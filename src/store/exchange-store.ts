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
import { currentPlatformInfo, directoryMode, fileMode, linkExclusive } from "../platform.js";

/** The file operations the store uses. Tests replace single operations to make them fail. */
export interface StoreFs {
  /** `mode` is set on the directories this call creates. A directory that exists is not changed. */
  mkdir(dir: string, options: { recursive: boolean; mode?: number }): Promise<unknown>;
  /**
   * `mode` is the mode of the new file. A file that exists is replaced by rename, never by this.
   */
  writeFile(file: string, data: string, mode?: number): Promise<void>;
  readFile(file: string): Promise<string>;
  readdir(dir: string): Promise<string[]>;
  rename(from: string, to: string): Promise<void>;
  link(existing: string, target: string): Promise<void>;
  unlink(file: string): Promise<void>;
  /** Removes an empty directory. It fails when the directory still holds something. */
  rmdir(dir: string): Promise<void>;
  rm(target: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  /**
   * Whether `target` is a real directory. A symbolic link is not one, even when it points to a
   * directory, and it is not followed. Fails like `lstat` when `target` does not exist.
   */
  isRealDirectory(target: string): Promise<boolean>;
  /**
   * Whether `target` is a regular file. A symbolic link is not one, even when it points to a
   * file, and it is not followed. Fails like `lstat` when `target` does not exist.
   */
  isRegularFile(target: string): Promise<boolean>;
}

export const nodeFs: StoreFs = {
  mkdir: (dir, options) => fsPromises.mkdir(dir, options),
  writeFile: (file, data, mode) => fsPromises.writeFile(file, data, { encoding: "utf8", mode }),
  readFile: (file) => fsPromises.readFile(file, "utf8"),
  readdir: (dir) => fsPromises.readdir(dir),
  rename: (from, to) => fsPromises.rename(from, to),
  link: (existing, target) => fsPromises.link(existing, target),
  unlink: (file) => fsPromises.unlink(file),
  rmdir: (dir) => fsPromises.rmdir(dir),
  rm: (target, options) => fsPromises.rm(target, options),
  isRealDirectory: async (target) => (await fsPromises.lstat(target)).isDirectory(),
  isRegularFile: async (target) => (await fsPromises.lstat(target)).isFile(),
};

export interface StoreOptions {
  rootDir: string;
  fs?: StoreFs;
  /** Source of the random part of hidden file names. Tests replace it. */
  randomHex?: () => string;
  /** The platform decides the modes of what is created. Production uses this machine's. */
  platform?: NodeJS.Platform;
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

/**
 * The four files this server makes in a request folder. A delete may
 * remove these, and the hidden files of `isOwnTempName`.
 */
const REMOVABLE_FILES: ReadonlySet<string> = new Set([
  "request.json",
  "state.json",
  "reply.json",
  "reply.accepted.json",
]);

/** The kinds of hidden file that the store writes in a request folder. */
const TEMP_KINDS = ["state", "reply", "reply.accepted"] as const;

/**
 * The one place that defines the form of a hidden file name:
 * `.<kind>.<process id>.<sequence number>.<random hex>.tmp`. The writer builds its names with
 * `tempName`, and the delete accepts a name with `isOwnTempName`, so the two cannot drift apart.
 */
function tempName(kind: string, processId: number, sequence: number, random: string): string {
  return `.${kind}.${processId}.${sequence}.${random}.tmp`;
}

const OWN_TEMP_NAME = new RegExp(
  `^\\.(?:${TEMP_KINDS.map((kind) => kind.replace(/\./g, "\\.")).join("|")})\\.\\d+\\.\\d+\\.[0-9a-f]+\\.tmp$`,
);

/**
 * Whether `name` is a hidden file that this server's writer makes in a request folder. It is the
 * one exception to the rule that every other name that starts with a dot is left alone, and a
 * delete removes such a file together with the four known files.
 */
export function isOwnTempName(name: string): boolean {
  return OWN_TEMP_NAME.test(name);
}

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
  private readonly dirMode: number | undefined;
  private readonly fileMode: number | undefined;
  private counter = 0;

  constructor(options: StoreOptions) {
    this.rootDir = options.rootDir;
    this.requestsDir = path.join(options.rootDir, "requests");
    this.fs = options.fs ?? nodeFs;
    this.randomHex = options.randomHex ?? (() => randomBytes(4).toString("hex"));
    const platform = options.platform ?? currentPlatformInfo().platform;
    this.dirMode = directoryMode(platform);
    this.fileMode = fileMode(platform);
  }

  /**
   * Creates the directories that are missing (mode 0700 on Linux and macOS) and
   * checks that this directory can make hard links. A directory that exists is not changed.
   */
  async prepare(): Promise<void> {
    try {
      await this.fs.mkdir(this.requestsDir, { recursive: true, mode: this.dirMode });
    } catch (error) {
      throw new StartupError(
        `cannot create ${this.rootDir}: ${new IoFailure("failed", error).detail}.`,
      );
    }
    await this.checkHardLinks();
  }

  /**
   * The ids of the request folders, in order. Only real directories count: a symbolic link named
   * like an id is not followed and not listed.
   */
  async listIds(): Promise<string[]> {
    const entries = await this.guard("read failed", () => this.fs.readdir(this.requestsDir));
    const ids: string[] = [];
    for (const name of entries.filter(isRequestId).sort()) {
      if (await this.isRealDirectory(this.requestDir(name))) {
        ids.push(name);
      }
    }
    return ids;
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
        await this.fs.mkdir(hiddenDir, { recursive: true, mode: this.dirMode });
        await this.writeNew(path.join(hiddenDir, "request.json"), serializeFile(request));
        await this.writeNew(path.join(hiddenDir, "state.json"), serializeFile(state));
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

  /**
   * Step one of accepting a reply: place reply.accepted.json with the content of
   * reply.json, as a file this server made, so it has mode 0600 even when the user put reply.json
   * there with a wider mode. reply.json itself is read and never linked, so its mode and content
   * stay as they are.
   *
   * The content goes to a hidden file with a name of its own first
   * (`.reply.accepted.<pid>.<seq>.<hex>.tmp`), which is then linked as reply.accepted.json without
   * replacing a file that exists. Two accepts at the same time write two different files, so
   * neither can cut off the other. Only this accept's hidden file is removed, whether or not the
   * link worked. Fails with AlreadyExistsError when reply.accepted.json exists. Any other failure
   * changes nothing in the request, and the next poll tries again.
   */
  async acceptReply(id: string): Promise<void> {
    const dir = this.requestDir(id);
    const content = await this.readText(path.join(dir, "reply.json"));
    if (content === undefined) {
      throw new IoFailure(
        "link failed",
        Object.assign(new Error("no reply.json"), { code: "ENOENT" }),
      );
    }
    const hidden = path.join(dir, this.hiddenName("reply.accepted"));
    try {
      await this.guard("write failed", () => this.writeNew(hidden, content));
      await linkExclusive(this.fs.link, hidden, path.join(dir, "reply.accepted.json"));
    } finally {
      await this.discard(hidden);
    }
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

  /**
   * Deletes a request folder. Only when the folder holds nothing but the four known
   * files and hidden files of the temporary form (what a stopped write leaves), and each of
   * them is a regular file, are they removed, and then the empty folder. Any other entry, such as
   * a directory or a symbolic link with one of those names, means "kept": nothing is removed.
   * state.json goes last, and the folder is looked at again before that, so a stop or a new file
   * in between leaves a request that the next sweep can find again.
   */
  async removeRequest(id: string): Promise<"removed" | "kept"> {
    const dir = this.requestDir(id);
    try {
      const names = await this.fs.readdir(dir);
      if (names.some((name) => !REMOVABLE_FILES.has(name) && !isOwnTempName(name))) {
        return "kept";
      }
      if (!(await this.allRegularFiles(dir, names))) {
        return "kept";
      }
      await this.unlinkAll(
        dir,
        names.filter((name) => name !== "state.json"),
      );
      if ((await this.fs.readdir(dir)).some((name) => name !== "state.json")) {
        return "kept";
      }
      await this.unlinkAll(dir, ["state.json"]);
      await this.fs.rmdir(dir);
      return "removed";
    } catch (error) {
      if (isMissingFile(error)) {
        return "removed";
      }
      throw new IoFailure("delete failed", error);
    }
  }

  /**
   * True when every name in `dir` is a regular file. A name that has gone since the listing is
   * not a problem.
   */
  private async allRegularFiles(dir: string, names: readonly string[]): Promise<boolean> {
    for (const name of names) {
      try {
        if (!(await this.fs.isRegularFile(path.join(dir, name)))) {
          return false;
        }
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
    }
    return true;
  }

  private async unlinkAll(dir: string, names: readonly string[]): Promise<void> {
    for (const name of names) {
      try {
        await this.fs.unlink(path.join(dir, name));
      } catch (error) {
        if (!isMissingFile(error)) {
          throw error;
        }
      }
    }
  }

  /** True for a real directory. A missing entry and a symbolic link are not one. */
  private async isRealDirectory(target: string): Promise<boolean> {
    try {
      return await this.fs.isRealDirectory(target);
    } catch (error) {
      if (isMissingFile(error)) {
        return false;
      }
      throw new IoFailure("read failed", error);
    }
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
    return tempName(kind, process.pid, this.counter, this.randomHex());
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
      await this.guard("write failed", () => this.writeNew(hidden, bytes));
      await publish(hidden);
    } finally {
      await this.discard(hidden);
    }
  }

  private async checkHardLinks(): Promise<void> {
    const source = path.join(this.rootDir, this.hiddenName("link-check"));
    const target = path.join(this.rootDir, this.hiddenName("link-check"));
    try {
      await this.writeNew(source, "imbehind");
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

  /** The one place a file is written: a new file, with the file mode of this server. */
  private writeNew(file: string, data: string): Promise<void> {
    return this.fs.writeFile(file, data, this.fileMode);
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
  | "removeRequest"
  | "requestFilePath"
>;
