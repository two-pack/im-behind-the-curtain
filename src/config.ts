import { StartupError } from "./errors.js";
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

export interface Settings {
  host: string;
  port: number;
  storageDir: string;
  pollIntervalMs: number;
}

/** The settings for a given storage directory. The address is always the fixed default. */
export function createSettings(storageDir: string, port: number = DEFAULT_PORT): Settings {
  return { host: DEFAULT_HOST, port, storageDir, pollIntervalMs: POLL_INTERVAL_MS };
}

/** Decides the settings for one start. This version has defaults only. */
export function loadSettings(info: PlatformInfo = currentPlatformInfo()): Settings {
  const storageDir = defaultStorageDir(info);
  if (storageDir === undefined) {
    throw new StartupError(missingStorageBaseMessage(info.platform));
  }
  return createSettings(storageDir);
}
