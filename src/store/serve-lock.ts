/**
 * `serve.lock`: the mark that says one `serve` uses a storage directory.
 *
 * The lock is a small JSON file. It is taken with a hard link, which fails when the file exists,
 * so two serves cannot both take it. The running serve rewrites `heartbeatAt` every 5 seconds. A
 * lock whose process is gone, or whose heartbeat is old, is stale and may be taken over. A file
 * that is not a lock of this program is never read further and never deleted.
 */
import { randomBytes } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { AlreadyExistsError, errorCode, IoFailure, StartupError } from "../errors.js";
import { fileMode, isProcessAlive, linkExclusive } from "../platform.js";

/**
 * The part of the clock the lock uses. It is the same shape as `Clock` of src/clock.ts, kept
 * here so that this module imports nothing but the platform module and the leaf modules.
 */
interface Clock {
  now(): Date;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const LOCK_FILE = "serve.lock";
/** How often the running serve rewrites `heartbeatAt`. */
const HEARTBEAT_INTERVAL_MS = 5000;
/** A heartbeat further from now than this, in either direction, makes the lock stale. */
const STALE_AFTER_MS = 15000;
/** How many times the lock is tried for: the first try, the try after a stale lock is removed, and one spare. */
const MAX_PLACEMENTS = 3;

/** The file operations the lock uses. Tests replace single operations to make them fail. */
export interface LockFs {
  readFile(file: string): Promise<string>;
  writeFile(file: string, data: string, mode?: number): Promise<void>;
  link(existing: string, target: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  unlink(file: string): Promise<void>;
}

/**
 * Whether the parent of `file` is a regular file. Windows reports a missing file below a regular
 * file as "not found" (ENOENT), where other systems report "not a directory" (ENOTDIR).
 */
async function parentIsFile(file: string): Promise<boolean> {
  try {
    return (await fsPromises.stat(path.dirname(file))).isFile();
  } catch {
    return false;
  }
}

export const nodeLockFs: LockFs = {
  readFile: async (file) => {
    try {
      return await fsPromises.readFile(file, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT" && (await parentIsFile(file))) {
        throw Object.assign(new Error(`ENOTDIR: not a directory, open '${file}'`), {
          code: "ENOTDIR",
        });
      }
      throw error;
    }
  },
  writeFile: (file, data, mode) => fsPromises.writeFile(file, data, { encoding: "utf8", mode }),
  link: (existing, target) => fsPromises.link(existing, target),
  rename: (from, to) => fsPromises.rename(from, to),
  unlink: (file) => fsPromises.unlink(file),
};

/** The content of serve.lock (StorageLock). */
interface LockContent {
  formatVersion: 1;
  processId: number;
  startedAt: string;
  heartbeatAt: string;
}

/**
 * What a look at serve.lock found. `foreign` is content that was read and is not a
 * lock of this program; it is never deleted. A serve.lock that cannot be read at all (no
 * permission, an input/output failure) has no verdict: it is an IoFailure, which ends the start
 * with "cannot read <dir>/serve.lock: <reason>." and is never called foreign.
 */
export type LockVerdict =
  | { kind: "absent" }
  | { kind: "running" | "stale"; lock: LockContent }
  | { kind: "foreign" };

function isTime(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

/** The lock in `text`, or undefined when the text is not a lock of this program. */
function parseLock(text: string): LockContent | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return undefined;
  }
  const { formatVersion, processId, startedAt, heartbeatAt } = data as Record<string, unknown>;
  if (formatVersion !== 1 || !Number.isInteger(processId) || !isTime(startedAt)) {
    return undefined;
  }
  return isTime(heartbeatAt)
    ? { formatVersion: 1, processId: processId as number, startedAt, heartbeatAt }
    : undefined;
}

/**
 * The verdict for the text of a lock. Only the process, the heartbeat and the clock decide;
 * `startedAt` does not.
 */
function judge(text: string, nowMs: number, alive: (pid: number) => boolean): LockVerdict {
  const lock = parseLock(text);
  if (lock === undefined) {
    return { kind: "foreign" };
  }
  if (!alive(lock.processId)) {
    return { kind: "stale", lock };
  }
  const distance = Math.abs(nowMs - Date.parse(lock.heartbeatAt));
  return { kind: distance > STALE_AFTER_MS ? "stale" : "running", lock };
}

/**
 * The text of the lock file, or undefined when it does not exist. A directory in its place is
 * read as empty text, which is not a lock. Any other failure is an IoFailure with the reason.
 */
async function readLockText(fs: LockFs, file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      return undefined;
    }
    if (code === "EISDIR") {
      return "";
    }
    throw new IoFailure("read failed", error);
  }
}

export interface InspectOptions {
  rootDir: string;
  clock: Clock;
  fs?: LockFs;
  isProcessAlive?: (processId: number) => boolean;
}

/**
 * Looks at serve.lock and nothing else: it creates nothing. A storage directory that does not
 * exist has no lock. A directory that cannot be read is an IoFailure.
 */
export async function inspectLock(options: InspectOptions): Promise<LockVerdict> {
  const fs = options.fs ?? nodeLockFs;
  const text = await readLockText(fs, path.join(options.rootDir, LOCK_FILE));
  if (text === undefined) {
    return { kind: "absent" };
  }
  return judge(text, options.clock.now().getTime(), options.isProcessAlive ?? isProcessAlive);
}

export interface ServeLockOptions {
  rootDir: string;
  platform: NodeJS.Platform;
  clock: Clock;
  fs?: LockFs;
  /** The process id written into the lock. Tests set it. */
  processId?: number;
  isProcessAlive?: (processId: number) => boolean;
  /** Source of the random part of hidden file names. Tests replace it. */
  randomHex?: () => string;
}

/** How a rewrite of heartbeatAt went: renewed, no longer ours, or failed and to be tried again. */
export type HeartbeatResult = "renewed" | "lost" | "failed";

export interface Heartbeat {
  /** Ends the loop, and waits for a rewrite that is in progress. */
  stop(): Promise<void>;
}

export interface HeartbeatHandlers {
  /** The lock is not ours any more. Called once, and the loop ends. */
  onLost: () => void;
  /** An exception that the loop does not handle itself. The loop ends. */
  onFailure: (error: unknown) => void;
}

/** The lock of one serve. `acquire` takes it, the heartbeat keeps it, and `release` returns it. */
export class ServeLock {
  private readonly rootDir: string;
  private readonly lockPath: string;
  private readonly clock: Clock;
  private readonly fs: LockFs;
  private readonly mode: number | undefined;
  private readonly processId: number;
  private readonly alive: (processId: number) => boolean;
  private readonly randomHex: () => string;
  private startedAt = "";
  private counter = 0;

  constructor(options: ServeLockOptions) {
    this.rootDir = options.rootDir;
    this.lockPath = path.join(options.rootDir, LOCK_FILE);
    this.clock = options.clock;
    this.fs = options.fs ?? nodeLockFs;
    this.mode = fileMode(options.platform);
    this.processId = options.processId ?? process.pid;
    this.alive = options.isProcessAlive ?? isProcessAlive;
    this.randomHex = options.randomHex ?? (() => randomBytes(4).toString("hex"));
  }

  /**
   * Takes the lock, or ends with a StartupError: busy, not a lock file, or the
   * reason it could not be created. The storage directory must exist.
   */
  async acquire(): Promise<void> {
    const now = this.clock.now().toISOString();
    this.startedAt = now;
    const staging = this.hiddenPath();
    try {
      await this.stage(staging, this.contentAt(now));
      await this.claim(staging);
    } finally {
      await this.discard(staging);
    }
  }

  /**
   * Rewrites heartbeatAt when the lock is still ours. `lost`: it is not ours, or it
   * has gone. `failed`: it could not be read or written; the next try may work.
   */
  async heartbeat(): Promise<HeartbeatResult> {
    let text: string | undefined;
    try {
      text = await readLockText(this.fs, this.lockPath);
    } catch {
      return "failed";
    }
    if (!this.isOurs(text)) {
      return "lost";
    }
    const staging = this.hiddenPath();
    try {
      await this.stage(staging, this.contentAt(this.startedAt, this.clock.now().toISOString()));
      await this.fs.rename(staging, this.lockPath);
      return "renewed";
    } catch {
      await this.discard(staging);
      return "failed";
    }
  }

  /** Starts the rewrite every 5 seconds. It does not wait for anything else. */
  startHeartbeat(handlers: HeartbeatHandlers): Heartbeat {
    const controller = new AbortController();
    const running = this.beat(controller.signal, handlers);
    return {
      stop: async () => {
        controller.abort();
        await running;
      },
    };
  }

  /** Removes the lock when it is ours. Every failure is ignored. */
  async release(): Promise<void> {
    try {
      if (this.isOurs(await readLockText(this.fs, this.lockPath))) {
        await this.fs.unlink(this.lockPath);
      }
    } catch {
      // A lock that stays is judged stale by the next serve.
    }
  }

  private async beat(signal: AbortSignal, handlers: HeartbeatHandlers): Promise<void> {
    try {
      for (;;) {
        await this.clock.sleep(HEARTBEAT_INTERVAL_MS, signal);
        if (signal.aborted) {
          return;
        }
        if ((await this.heartbeat()) === "lost") {
          handlers.onLost();
          return;
        }
      }
    } catch (error) {
      handlers.onFailure(error);
    }
  }

  private contentAt(startedAt: string, heartbeatAt: string = startedAt): string {
    const content: LockContent = {
      formatVersion: 1,
      processId: this.processId,
      startedAt,
      heartbeatAt,
    };
    return `${JSON.stringify(content, null, 2)}\n`;
  }

  private isOurs(text: string | undefined): boolean {
    const lock = text === undefined ? undefined : parseLock(text);
    return (
      lock !== undefined && lock.processId === this.processId && lock.startedAt === this.startedAt
    );
  }

  private hiddenPath(): string {
    this.counter += 1;
    const name = `.serve-lock.${this.processId}.${this.counter}.${this.randomHex()}.tmp`;
    return path.join(this.rootDir, name);
  }

  private async stage(file: string, data: string): Promise<void> {
    try {
      await this.fs.writeFile(file, data, this.mode);
    } catch (error) {
      throw this.cannotCreate(error);
    }
  }

  private async discard(file: string): Promise<void> {
    try {
      await this.fs.unlink(file);
    } catch {
      // A hidden file that stays does no harm; it is never read as data.
    }
  }

  /** Tries to place the lock; a lock that exists is judged, and a stale one is removed and tried again. */
  private async claim(staging: string): Promise<void> {
    for (let attempt = 0; attempt < MAX_PLACEMENTS; attempt += 1) {
      if (await this.place(staging)) {
        await this.confirm();
        return;
      }
      const text = await this.read();
      if (text !== undefined) {
        await this.clearIfStale(text);
      }
    }
    throw this.busy();
  }

  /** True when the lock was placed, false when a lock exists. Any other failure ends with an error. */
  private async place(staging: string): Promise<boolean> {
    try {
      await linkExclusive(this.fs.link, staging, this.lockPath);
      return true;
    } catch (error) {
      if (error instanceof AlreadyExistsError) {
        return false;
      }
      throw this.cannotCreate(error);
    }
  }

  /**
   * Reads the lock that exists. A failure to read it (no permission, an input/output failure) is a
   * startup error that names the file and the reason. It is not the "not an imbehind lock file"
   * error of `clearIfStale`, which is only for content that could be read.
   */
  private async read(): Promise<string | undefined> {
    try {
      return await readLockText(this.fs, this.lockPath);
    } catch (error) {
      const detail = error instanceof IoFailure ? error.detail : "unknown error";
      throw new StartupError(`cannot read ${this.lockPath}: ${detail}.`);
    }
  }

  /**
   * Running ends the start with the busy sentence, and so does a file that is not a lock. A
   * stale lock is removed, but only when it is unchanged on a second read.
   */
  private async clearIfStale(text: string): Promise<void> {
    const verdict = judge(text, this.clock.now().getTime(), this.alive);
    if (verdict.kind === "running") {
      throw this.busy();
    }
    if (verdict.kind === "foreign") {
      throw new StartupError(
        `${this.lockPath} is not an imbehind lock file. Remove it if no imbehind serve uses this directory.`,
      );
    }
    if ((await this.read()) !== text) {
      return;
    }
    try {
      await this.fs.unlink(this.lockPath);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        throw this.cannotCreate(error);
      }
    }
  }

  /** After placing the lock: read it back and make sure it is ours. */
  private async confirm(): Promise<void> {
    if (!this.isOurs(await this.read())) {
      throw this.busy();
    }
  }

  private busy(): StartupError {
    return new StartupError(`${this.rootDir} is already used by another imbehind serve.`);
  }

  private cannotCreate(error: unknown): StartupError {
    const failure = error instanceof IoFailure ? error : new IoFailure("failed", error);
    return new StartupError(`cannot create ${this.lockPath}: ${failure.detail}.`);
  }
}
