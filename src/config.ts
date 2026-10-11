import { InvalidOptionError, StartupError } from "./errors.js";
import {
  currentPlatformInfo,
  defaultStorageDir,
  missingStorageBaseMessage,
  type PlatformInfo,
} from "./platform.js";

/** The server listens on this address only. No setting or environment variable changes it. */
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
/** How long serve and answer wait between two reads of the storage directory. */
export const POLL_INTERVAL_MS = 500;

/** How long serve waits for a reply before it gives up, in seconds. 0 means no limit. */
export const DEFAULT_WAIT_LIMIT_SECONDS = 1800;
/** The largest wait limit: in milliseconds it still fits the timer limit of Node.js. */
const MAX_WAIT_LIMIT_SECONDS = 2147483;

export interface Settings {
  host: string;
  port: number;
  storageDir: string;
  pollIntervalMs: number;
  waitLimitSeconds: number;
}

/** The settings for a given storage directory. The address is always the fixed default. */
export function createSettings(storageDir: string, port: number = DEFAULT_PORT): Settings {
  return {
    host: DEFAULT_HOST,
    port,
    storageDir,
    pollIntervalMs: POLL_INTERVAL_MS,
    waitLimitSeconds: DEFAULT_WAIT_LIMIT_SECONDS,
  };
}

/** Where a wait limit value came from: the name to show in an error, and the text. */
function waitLimitSource(
  option: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): { name: string; value: string } | undefined {
  if (option !== undefined) {
    return { name: "--timeout", value: option };
  }
  const fromEnv = env.IMBEHIND_TIMEOUT;
  return fromEnv ? { name: "IMBEHIND_TIMEOUT", value: fromEnv } : undefined;
}

/**
 * The wait limit of one `serve` start: the option, else the environment
 * variable, else the default. An empty environment variable counts as not set. A value that is
 * not digits only, or is above 2147483, ends the start with exit code 2.
 */
export function resolveWaitLimit(
  option: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): number {
  const source = waitLimitSource(option, env);
  if (source === undefined) {
    return DEFAULT_WAIT_LIMIT_SECONDS;
  }
  const seconds = /^[0-9]+$/.test(source.value) ? Number(source.value) : -1;
  if (seconds < 0 || seconds > MAX_WAIT_LIMIT_SECONDS) {
    throw new InvalidOptionError(
      `${source.name} must be a whole number of seconds from 0 to ${MAX_WAIT_LIMIT_SECONDS} (got "${source.value}").`,
    );
  }
  return seconds;
}

/** Decides the settings for one start. The wait limit is added by `resolveWaitLimit` for serve. */
export function loadSettings(info: PlatformInfo = currentPlatformInfo()): Settings {
  const storageDir = defaultStorageDir(info);
  if (storageDir === undefined) {
    throw new StartupError(missingStorageBaseMessage(info.platform));
  }
  return createSettings(storageDir);
}
