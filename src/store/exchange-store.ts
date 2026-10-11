import { randomBytes } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { errorCode, IoFailure, type IoReason, StartupError } from "../errors.js";
import { isRequestId } from "../ids.js";
import {
  type Loaded,
  parseReplyFile,
  parseRequestFile,
  parseStateFile,
  type ReplyFile,
  type RequestFile,
  type StateFile,
  serializeFile,
} from "../model.js";
import { linkExclusive } from "../platform.js";

/** The file operations the store uses. Tests replace single operations to make them fail. */
export interface StoreFs {
  mkdir(dir: string, options: { recursive: boolean }): Promise<unknown>;
  writeFile(file: string, data: string): Promise<void>;
  readFile(file: string): Promise<string>;
  readdir(dir: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  link(existing: string, target: string): Promise<void>;
  unlink(file: string): Promise<void>;
  rm(target: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}

export const nodeFs: StoreFs = {
  mkdir: (dir, options) => fsPromises.mkdir(dir, options),
  writeFile: (file, data) => fsPromises.writeFile(file, data, "utf8"),
  readFile: (file) => fsPromises.readFile(file, "utf8"),
  readdir: (dir) => fsPromises.readdir(dir),
  rename: (from, to) => fsPromises.rename(from, to),
  link: (existing, target) => fsPromises.link(existing, target),
  unlink: (file) => fsPromises.unlink(file),
  rm: (target, options) => fsPromises.rm(target, options),
};

export interface StoreOptions {
  rootDir: string;
  fs?: StoreFs;
  /** Source of the random part of hidden file names. Tests replace it. */
  randomHex?: () => string;
}

/** The result of reading a file that may not exist. */
export type Stored<T> = Loaded<T> | { kind: "missing" };

export type ReplyFileName = "reply.json" | "reply.accepted.json";

export interface StoredReply {
  /** The exact text of the file, for comparing what was written with what was accepted. */
  bytes: string;
  parsed: Loaded<ReplyFile>;
}

const MISSING = { kind: "missing" } as const;

function isMissingFile(error: unknown): boolean {
  const code = errorCode(error);
  return code === "ENOENT" || code === "ENOTDIR";
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Reads and writes the storage directory. The files are the only state.
 *
 * Only two ways of writing a file exist. A file such as `state.json` is written under a
 * hidden name and then renamed. A file such as `reply.json` is written under a hidden name
 * and then linked to its final name, which fails if the final name already exists.
 */
export class ExchangeStore {
  readonly rootDir: string;
  private readonly requestsDir: string;
  private readonly fs: StoreFs;
  private readonly randomHex: () => string;
  private counter = 0;

  constructor(options: StoreOptions) {
    this.rootDir = options.rootDir;
    this.requestsDir = path.join(options.rootDir, "requests");
    this.fs = options.fs ?? nodeFs;
    this.randomHex = options.randomHex ?? (() => randomBytes(4).toString("hex"));
  }

  /** Creates the directories and checks that this directory can make hard links. */
  async prepare(): Promise<void> {
    try {
      await this.fs.mkdir(this.requestsDir, { recursive: true });
    } catch (error) {
      throw new StartupError(
        `cannot create ${this.rootDir}: ${new IoFailure("failed", error).detail}.`,
      );
    }
    await this.checkHardLinks();
  }

  async listIds(): Promise<string[]> {
    const entries = await this.guard("read failed", () => this.fs.readdir(this.requestsDir));
    return entries.filter(isRequestId).sort();
  }

  async maxId(): Promise<string | undefined> {
    const ids = await this.listIds();
    return ids[ids.length - 1];
  }

  /** The names of the files inside one request directory. Empty when it does not exist. */
  async listFiles(id: string): Promise<ReadonlySet<string>> {
    try {
      return new Set(await this.fs.readdir(this.requestDir(id)));
    } catch (error) {
      if (isMissingFile(error)) {
        return new Set();
      }
      throw new IoFailure("read failed", error);
    }
  }

  /** Writes request.json and state.json in a hidden directory, then renames the directory. */
  async createRequest(request: RequestFile, state: StateFile): Promise<void> {
    const hiddenDir = path.join(this.requestsDir, `.${request.id}`);
    try {
      await this.guard("write failed", async () => {
        await this.fs.mkdir(hiddenDir, { recursive: true });
        await this.fs.writeFile(path.join(hiddenDir, "request.json"), serializeFile(request));
        await this.fs.writeFile(path.join(hiddenDir, "state.json"), serializeFile(state));
      });
      await this.guard("rename failed", () =>
        this.fs.rename(hiddenDir, this.requestDir(request.id)),
      );
    } catch (error) {
      await this.discard(hiddenDir);
      throw error;
    }
  }

  async readRequest(id: string): Promise<Stored<RequestFile>> {
    return this.readJson(path.join(this.requestDir(id), "request.json"), parseRequestFile);
  }

  async readState(id: string): Promise<Stored<StateFile>> {
    return this.readJson(path.join(this.requestDir(id), "state.json"), parseStateFile);
  }

  /** Replaces state.json. The new content is written under a hidden name first. */
  async writeState(state: StateFile): Promise<void> {
    const dir = this.requestDir(state.id);
    await this.writeThenPublish(dir, "state", serializeFile(state), (hidden) =>
      this.guard("rename failed", () => this.fs.rename(hidden, path.join(dir, "state.json"))),
    );
  }

  /**
   * Places reply.json. It fails with AlreadyExistsError when reply.json already exists, so of
   * two writers at the same time only one succeeds.
   */
  async placeReply(id: string, bytes: string): Promise<void> {
    const dir = this.requestDir(id);
    await this.writeThenPublish(dir, "reply", bytes, (hidden) =>
      linkExclusive(this.fs.link, hidden, path.join(dir, "reply.json")),
    );
  }

  /** Step one of accepting a reply: link reply.accepted.json to reply.json. */
  async acceptReply(id: string): Promise<void> {
    const dir = this.requestDir(id);
    await linkExclusive(
      this.fs.link,
      path.join(dir, "reply.json"),
      path.join(dir, "reply.accepted.json"),
    );
  }

  /** Step two of accepting a reply: remove reply.json. A missing file is not an error. */
  async removeReply(id: string): Promise<void> {
    try {
      await this.fs.unlink(path.join(this.requestDir(id), "reply.json"));
    } catch (error) {
      if (!isMissingFile(error)) {
        throw new IoFailure("failed", error);
      }
    }
  }

  async readReply(id: string, name: ReplyFileName): Promise<StoredReply | undefined> {
    const text = await this.readText(path.join(this.requestDir(id), name));
    if (text === undefined) {
      return undefined;
    }
    const json = parseJson(text);
    return { bytes: text, parsed: json.ok ? parseReplyFile(json.value) : { kind: "unreadable" } };
  }

  /** Where request.json of a request is, whether or not the file exists. Reads nothing. */
  requestFilePath(id: string): string {
    return path.join(this.requestDir(id), "request.json");
  }

  private requestDir(id: string): string {
    return path.join(this.requestsDir, id);
  }

  private hiddenName(kind: string): string {
    this.counter += 1;
    return `.${kind}.${process.pid}.${this.counter}.${this.randomHex()}.tmp`;
  }

  /**
   * The one way a single file is written: the bytes go to a hidden name in the same
   * directory first, `publish` gives the file its final name, and the hidden name is removed
   * whatever happens. `publish` renames (state.json) or links without replacing (reply.json).
   */
  private async writeThenPublish(
    dir: string,
    kind: string,
    bytes: string,
    publish: (hidden: string) => Promise<void>,
  ): Promise<void> {
    const hidden = path.join(dir, this.hiddenName(kind));
    try {
      await this.guard("write failed", () => this.fs.writeFile(hidden, bytes));
      await publish(hidden);
    } finally {
      await this.discard(hidden);
    }
  }

  private async checkHardLinks(): Promise<void> {
    const source = path.join(this.rootDir, this.hiddenName("link-check"));
    const target = path.join(this.rootDir, this.hiddenName("link-check"));
    try {
      await this.fs.writeFile(source, "imbehind");
    } catch (error) {
      throw new StartupError(
        `cannot write to ${this.rootDir}: ${new IoFailure("write failed", error).detail}.`,
      );
    }
    try {
      await linkExclusive(this.fs.link, source, target);
    } catch (error) {
      const detail = error instanceof IoFailure ? error.detail : "unknown error";
      throw new StartupError(`cannot create hard links in ${this.rootDir}: ${detail}.`);
    } finally {
      await this.discard(source);
      await this.discard(target);
    }
  }

  private async readText(file: string): Promise<string | undefined> {
    try {
      return await this.fs.readFile(file);
    } catch (error) {
      if (isMissingFile(error)) {
        return undefined;
      }
      throw new IoFailure("read failed", error);
    }
  }

  private async readJson<T>(file: string, parse: (data: unknown) => Loaded<T>): Promise<Stored<T>> {
    const text = await this.readText(file);
    if (text === undefined) {
      return MISSING;
    }
    const json = parseJson(text);
    return json.ok ? parse(json.value) : { kind: "unreadable" };
  }

  /** Runs an operation and turns any failure into an IoFailure with the given reason. */
  private async guard<T>(reason: IoReason, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      throw error instanceof IoFailure ? error : new IoFailure(reason, error);
    }
  }

  /** Removes a hidden file or directory. A failure here is ignored because the item is hidden. */
  private async discard(target: string): Promise<void> {
    try {
      await this.fs.rm(target, { recursive: true, force: true });
    } catch {
      // Hidden items are never read as data, so a leftover does no harm.
    }
  }
}

/** The part of the store that the broker uses. Tests provide an in-memory version. */
export type ExchangeStorage = Pick<
  ExchangeStore,
  | "listIds"
  | "maxId"
  | "listFiles"
  | "createRequest"
  | "readRequest"
  | "readState"
  | "writeState"
  | "placeReply"
  | "acceptReply"
  | "removeReply"
  | "readReply"
  | "requestFilePath"
>;
