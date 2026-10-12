/**
 * Everything that differs between operating systems lives in this module, and it is the
 * only module that may read `process.platform` or call `os.platform`.
 */
import { homedir } from "node:os";
import path from "node:path";
import type { Readable, Writable } from "node:stream";
import { AlreadyExistsError, errorCode, IoFailure } from "./errors.js";

export interface PlatformInfo {
  platform: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  homedir: string | undefined;
  /** The working directory, for making a relative path absolute. Tests set it. */
  cwd?: string;
}

function tryHomedir(): string | undefined {
  try {
    const home = homedir();
    return home === "" ? undefined : home;
  } catch {
    return undefined;
  }
}

/** The platform, environment, home directory and working directory of this process. */
export function currentPlatformInfo(): PlatformInfo {
  return {
    platform: process.platform,
    env: process.env,
    homedir: tryHomedir(),
    cwd: process.cwd(),
  };
}

/**
 * A path made absolute from the working directory and cleaned up, with the path rules of the
 * platform in `info`. Symbolic links are not resolved.
 */
export function absolutePath(info: PlatformInfo, target: string): string {
  const rules = info.platform === "win32" ? path.win32 : path.posix;
  return rules.resolve(info.cwd ?? process.cwd(), target);
}

/**
 * The default storage directory, or undefined when the base directory
 * cannot be found.
 */
export function defaultStorageDir(info: PlatformInfo): string | undefined {
  if (info.platform === "win32") {
    const base = info.env.LOCALAPPDATA;
    return base ? path.win32.join(base, "imbehind") : undefined;
  }
  if (info.platform === "darwin") {
    return info.homedir
      ? path.posix.join(info.homedir, "Library", "Application Support", "imbehind")
      : undefined;
  }
  const xdg = info.env.XDG_DATA_HOME;
  if (xdg) {
    return path.posix.join(xdg, "imbehind");
  }
  return info.homedir ? path.posix.join(info.homedir, ".local", "share", "imbehind") : undefined;
}

/**
 * The mode of a directory this program creates: only the user may use it. Windows has no such
 * mode, so there the default permissions of the profile apply and no mode is set.
 */
export function directoryMode(platform: NodeJS.Platform): number | undefined {
  return platform === "win32" ? undefined : 0o700;
}

/** The mode of a file this program creates: only the user may read or write it. */
export function fileMode(platform: NodeJS.Platform): number | undefined {
  return platform === "win32" ? undefined : 0o600;
}

/**
 * Whether the process exists. No signal is sent. A process we may not signal still exists, so it
 * counts as alive.
 */
export function isProcessAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) {
    return false;
  }
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

/** The sentence for the startup error when `defaultStorageDir` finds no base directory. */
export function missingStorageBaseMessage(platform: NodeJS.Platform): string {
  return platform === "win32"
    ? "cannot find the storage directory because LOCALAPPDATA is not set."
    : "cannot find the storage directory because the home directory is unknown.";
}

/**
 * Whether this program must itself treat "Ctrl+Z, then Enter" as the end of the input.
 * In a Windows console, Node's line reader ignores Ctrl+Z, so the end would never come.
 */
export function ctrlZEndsInput(platform: NodeJS.Platform): boolean {
  return platform === "win32";
}

/** How a person ends their typing: one text for every operating system. */
export function endOfInputHint(): string {
  return "Ctrl+D (Windows: Ctrl+Z, then Enter)";
}

export type LinkFunction = (existing: string, target: string) => Promise<void>;

/**
 * Creates `target` as a hard link to `existing`, and fails when `target` already exists.
 * It is used on Linux, macOS and Windows (NTFS) alike. A rename would replace an existing
 * file, so it must not be used for placing or accepting a reply.
 */
export async function linkExclusive(
  link: LinkFunction,
  existing: string,
  target: string,
): Promise<void> {
  try {
    await link(existing, target);
  } catch (error) {
    if (errorCode(error) === "EEXIST") {
      throw new AlreadyExistsError();
    }
    throw new IoFailure("link failed", error);
  }
}

export interface InterruptTarget {
  on(event: "SIGINT", listener: () => void): unknown;
  off(event: "SIGINT", listener: () => void): unknown;
}

/**
 * How `imbehind answer` uses its input. `interactive` shows the conversation and
 * reads what a person types. `stdin` reads the whole input as one reply.
 */
export type AnswerInputMode = "interactive" | "stdin";

/** The real terminal and operating system of this process, as the command layer sees them. */
export interface ProcessIo {
  stdin: Readable;
  stdout: Writable;
  stderr: Writable;
  /** True when standard input is a terminal. */
  isTerminal: boolean;
  /**
   * Only tests set this. It decides `AnswerInputMode` whatever `isTerminal` says, so a test can
   * type lines into the answer screen without a terminal.
   */
  answerInput?: AnswerInputMode;
  info: PlatformInfo;
  onInterrupt(handler: () => void): () => void;
  /**
   * Calls `handler` for an uncaught exception or an unhandled rejection. The handler gets no
   * error, because nothing about it may be shown. Returns a function that stops listening.
   */
  onFatalError(handler: () => void): () => void;
}

export function processIo(): ProcessIo {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    isTerminal: Boolean(process.stdin.isTTY),
    info: currentPlatformInfo(),
    onInterrupt: (handler) => onInterrupt(handler),
    onFatalError: (handler) => onFatalError(handler),
  };
}

/** Calls `handler` when the person presses Ctrl+C. Returns a function that stops listening. */
export function onInterrupt(handler: () => void, target: InterruptTarget = process): () => void {
  target.on("SIGINT", handler);
  return () => {
    target.off("SIGINT", handler);
  };
}

export interface FatalTarget {
  on(event: "uncaughtException" | "unhandledRejection", listener: () => void): unknown;
  off(event: "uncaughtException" | "unhandledRejection", listener: () => void): unknown;
}

/**
 * Calls `handler` for an uncaught exception or an unhandled rejection, so that Node does not
 * print the error with its stack. Returns a function that stops listening.
 */
export function onFatalError(handler: () => void, target: FatalTarget = process): () => void {
  target.on("uncaughtException", handler);
  target.on("unhandledRejection", handler);
  return () => {
    target.off("uncaughtException", handler);
    target.off("unhandledRejection", handler);
  };
}
