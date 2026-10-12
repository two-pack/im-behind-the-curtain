/**
 * Error types shared by the storage, broker and command layers.
 *
 * Failures of file operations are told apart by type, never by matching message text.
 * An exception message is never written to the screen or to a response, because the
 * message of a failed JSON parse can carry a piece of the input.
 */

/** Short fixed phrases for a failed file operation. They are safe to print. */
export const IO_REASONS = [
  "read failed",
  "write failed",
  "rename failed",
  "link failed",
  "unreadable",
  "failed",
  "delete failed",
  "kept unknown files",
  "abandon failed",
] as const;
export type IoReason = (typeof IO_REASONS)[number];

/** The target of an exclusive create already exists. This is a result, not a failure. */
export class AlreadyExistsError extends Error {
  constructor() {
    super("already exists");
    this.name = "AlreadyExistsError";
  }
}

/** A read, write, rename or link failed for an input/output reason. */
export class IoFailure extends Error {
  readonly reason: IoReason;
  /** A short phrase for the cause, such as "permission denied". It never carries file content. */
  readonly detail: string;

  constructor(reason: IoReason, cause: unknown) {
    super(reason);
    this.name = "IoFailure";
    this.reason = reason;
    this.detail = describeFsError(cause);
  }
}

/** The program cannot start. The message becomes the "Error: ..." line and the exit code is 1. */
export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StartupError";
  }
}

/** An option or environment variable has a value that is not allowed. The exit code is 2. */
export class InvalidOptionError extends StartupError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOptionError";
  }
}

/** Process exit codes. */
export const EXIT = { success: 0, failure: 1, invalidOption: 2, interrupted: 130 } as const;

export function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

const FS_PHRASES: Readonly<Record<string, string>> = {
  ENOENT: "no such file or directory",
  ENOTDIR: "not a directory",
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  EEXIST: "already exists",
  ENOSPC: "no space left on device",
  EROFS: "read-only file system",
  ENOTSUP: "not supported",
  EOPNOTSUPP: "not supported",
  EXDEV: "cross-device link not permitted",
  EMLINK: "too many links",
  EBUSY: "resource busy or locked",
  EMFILE: "too many open files",
  EIO: "input/output error",
};

/** Turns an error from the file system into a short fixed phrase. */
export function describeFsError(error: unknown): string {
  const code = errorCode(error);
  if (code === undefined) {
    return "unknown error";
  }
  return FS_PHRASES[code] ?? `error code ${code}`;
}
