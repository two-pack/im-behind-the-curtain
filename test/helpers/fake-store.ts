import { AlreadyExistsError, IoFailure, type IoReason } from "../../src/errors.js";
import {
  type Loaded,
  parseReplyFile,
  type ReplyFile,
  type RequestFile,
  type StateFile,
} from "../../src/model.js";
import type {
  ExchangeStorage,
  ReplyFileName,
  Stored,
  StoredReply,
} from "../../src/store/exchange-store.js";

interface Entry {
  request: RequestFile | "unreadable" | "unsupported";
  state: StateFile | "unreadable" | "missing";
  files: Map<ReplyFileName, string>;
}

function ioError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/** An in-memory storage with the same rules as the real one, and failures on demand. */
export class FakeStore implements ExchangeStorage {
  readonly entries = new Map<string, Entry>();
  readonly calls: Record<string, number> = {};
  private readonly failures = new Map<string, number>();
  private readonly gates = new Map<string, Promise<void>>();

  /** Makes the next `times` calls of an operation fail with an input/output failure. */
  fail(operation: string, times = 1): void {
    this.failures.set(operation, times);
  }

  /** Makes an operation wait for the given promise before it runs. */
  gate(operation: string, until: Promise<void> | undefined): void {
    if (until === undefined) {
      this.gates.delete(operation);
    } else {
      this.gates.set(operation, until);
    }
  }

  addRaw(id: string, entry: Partial<Entry> & Pick<Entry, "request" | "state">): void {
    this.entries.set(id, { files: new Map(), ...entry });
  }

  count(operation: string): number {
    return this.calls[operation] ?? 0;
  }

  private async enter(operation: string, reason: IoReason): Promise<void> {
    this.calls[operation] = this.count(operation) + 1;
    const gate = this.gates.get(operation);
    if (gate !== undefined) {
      await gate;
    }
    const remaining = this.failures.get(operation) ?? 0;
    if (remaining > 0) {
      this.failures.set(operation, remaining - 1);
      throw new IoFailure(reason, ioError("EIO"));
    }
  }

  async listIds(): Promise<string[]> {
    await this.enter("listIds", "read failed");
    return [...this.entries.keys()].sort();
  }

  async maxId(): Promise<string | undefined> {
    await this.enter("maxId", "read failed");
    return [...this.entries.keys()].sort().pop();
  }

  async listFiles(id: string): Promise<ReadonlySet<string>> {
    await this.enter("listFiles", "read failed");
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return new Set();
    }
    const names = new Set<string>(["request.json"]);
    if (entry.state !== "missing") {
      names.add("state.json");
    }
    for (const name of entry.files.keys()) {
      names.add(name);
    }
    return names;
  }

  async createRequest(request: RequestFile, state: StateFile): Promise<void> {
    await this.enter("createRequest", "write failed");
    this.entries.set(request.id, { request, state, files: new Map() });
  }

  async readRequest(id: string): Promise<Stored<RequestFile>> {
    await this.enter("readRequest", "read failed");
    const entry = this.entries.get(id);
    if (entry === undefined) {
      return { kind: "missing" };
    }
    if (entry.request === "unreadable" || entry.request === "unsupported") {
      return { kind: entry.request };
    }
    return { kind: "ok", value: entry.request };
  }

  async readState(id: string): Promise<Stored<StateFile>> {
    await this.enter("readState", "read failed");
    const entry = this.entries.get(id);
    if (entry === undefined || entry.state === "missing") {
      return { kind: "missing" };
    }
    if (entry.state === "unreadable") {
      return { kind: "unreadable" };
    }
    return { kind: "ok", value: entry.state };
  }

  async writeState(state: StateFile): Promise<void> {
    await this.enter("writeState", "write failed");
    const entry = this.entries.get(state.id);
    if (entry !== undefined) {
      entry.state = state;
    }
  }

  async placeReply(id: string, bytes: string): Promise<void> {
    await this.enter("placeReply", "write failed");
    const entry = this.entries.get(id);
    if (entry === undefined) {
      throw new IoFailure("write failed", ioError("ENOENT"));
    }
    if (entry.files.has("reply.json")) {
      throw new AlreadyExistsError();
    }
    entry.files.set("reply.json", bytes);
  }

  async acceptReply(id: string): Promise<void> {
    await this.enter("acceptReply", "link failed");
    const entry = this.entries.get(id);
    const reply = entry?.files.get("reply.json");
    if (entry === undefined || reply === undefined) {
      throw new IoFailure("link failed", ioError("ENOENT"));
    }
    if (entry.files.has("reply.accepted.json")) {
      throw new AlreadyExistsError();
    }
    entry.files.set("reply.accepted.json", reply);
  }

  async removeReply(id: string): Promise<void> {
    await this.enter("removeReply", "failed");
    this.entries.get(id)?.files.delete("reply.json");
  }

  async readReply(id: string, name: ReplyFileName): Promise<StoredReply | undefined> {
    await this.enter("readReply", "read failed");
    const bytes = this.entries.get(id)?.files.get(name);
    if (bytes === undefined) {
      return undefined;
    }
    let parsed: Loaded<ReplyFile>;
    try {
      parsed = parseReplyFile(JSON.parse(bytes));
    } catch {
      parsed = { kind: "unreadable" };
    }
    return { bytes, parsed };
  }

  async removeRequest(id: string): Promise<"removed" | "kept"> {
    await this.enter("removeRequest", "delete failed");
    this.entries.delete(id);
    return "removed";
  }

  requestFilePath(id: string): string {
    return `/fake-storage/requests/${id}/request.json`;
  }

  /** Puts a reply file in place the way a user tool or another answer would. */
  putFile(id: string, name: ReplyFileName, bytes: string): void {
    this.entries.get(id)?.files.set(name, bytes);
  }
}
