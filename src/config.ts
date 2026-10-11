import { lookup as dnsLookup } from "node:dns/promises";
import net from "node:net";
import { InvalidOptionError, StartupError } from "./errors.js";
import {
  absolutePath,
  currentPlatformInfo,
  defaultStorageDir,
  missingStorageBaseMessage,
  type PlatformInfo,
} from "./platform.js";

/** The server listens on this address when no other local address is asked for. */
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 3000;
/** How long serve and answer wait between two reads of the storage directory. */
export const POLL_INTERVAL_MS = 500;

/** How long serve waits for a reply before it gives up, in seconds. 0 means no limit. */
export const DEFAULT_WAIT_LIMIT_SECONDS = 1800;
/** How long a finished request is kept before it is deleted, in seconds. 0 means never delete. */
export const DEFAULT_RETENTION_SECONDS = 86400;
/** How often old requests are looked for, in seconds. */
export const DEFAULT_SWEEP_INTERVAL_SECONDS = 600;

/** The largest wait limit: in milliseconds it still fits the timer limit of Node.js. */
const MAX_WAIT_LIMIT_SECONDS = 2147483;
const MAX_RETENTION_SECONDS = 315360000;
const MAX_SWEEP_INTERVAL_SECONDS = 2147483;
const MAX_PORT = 65535;
/** The most characters of a received value that an error sentence repeats. */
const MAX_SHOWN = 64;

export interface Settings {
  host: string;
  port: number;
  storageDir: string;
  pollIntervalMs: number;
  waitLimitSeconds: number;
  retentionSeconds: number;
  sweepIntervalSeconds: number;
}

/** The settings for a given storage directory, with the default of every other value. */
export function createSettings(storageDir: string, port: number = DEFAULT_PORT): Settings {
  return {
    host: DEFAULT_HOST,
    port,
    storageDir,
    pollIntervalMs: POLL_INTERVAL_MS,
    waitLimitSeconds: DEFAULT_WAIT_LIMIT_SECONDS,
    retentionSeconds: DEFAULT_RETENTION_SECONDS,
    sweepIntervalSeconds: DEFAULT_SWEEP_INTERVAL_SECONDS,
  };
}

// ---------------------------------------------------------------------------------------------
// The command line
// ---------------------------------------------------------------------------------------------

type CommandName = "serve" | "answer" | "path";
type SettingName = "host" | "port" | "dir" | "timeout" | "retention" | "sweep-interval";
/** The text of each option as it was typed, before any check. */
export type RawOptions = Partial<Record<SettingName, string>>;

export interface CommandLine {
  name: CommandName;
  options: RawOptions;
}

const SERVE_OPTIONS: readonly SettingName[] = [
  "host",
  "port",
  "dir",
  "timeout",
  "retention",
  "sweep-interval",
];
const OPTIONS_OF: Readonly<Record<CommandName, readonly SettingName[]>> = {
  serve: SERVE_OPTIONS,
  answer: ["dir"],
  path: ["dir"],
};

const USAGE = "usage: imbehind serve | answer | path";

function usageError(): InvalidOptionError {
  return new InvalidOptionError(USAGE);
}

function isCommandName(word: string | undefined): word is CommandName {
  return word === "serve" || word === "answer" || word === "path";
}

/** One `--name value` or `--name=value`, and the index of the first word after it. */
function readOption(
  words: readonly string[],
  index: number,
  allowed: readonly SettingName[],
): { name: SettingName; value: string; next: number } {
  const word = words[index] ?? "";
  if (!word.startsWith("--")) {
    throw usageError();
  }
  const equals = word.indexOf("=");
  const name = equals === -1 ? word.slice(2) : word.slice(2, equals);
  if (!(allowed as readonly string[]).includes(name)) {
    throw usageError();
  }
  if (equals !== -1) {
    return { name: name as SettingName, value: word.slice(equals + 1), next: index + 1 };
  }
  const value = words[index + 1];
  if (value === undefined) {
    throw usageError();
  }
  return { name: name as SettingName, value, next: index + 2 };
}

/**
 * Reads the words after the program name: a command and its options. A wrong way of
 * writing, such as an unknown command or option, a repeated option, an option without a value, or
 * a serve-only option given to another command, is a usage error (exit code 2). The values are
 * not checked here.
 */
export function parseCommandLine(argv: readonly string[]): CommandLine {
  const [name, ...words] = argv;
  if (!isCommandName(name)) {
    throw usageError();
  }
  const options: RawOptions = {};
  let index = 0;
  while (index < words.length) {
    const option = readOption(words, index, OPTIONS_OF[name]);
    if (option.name in options) {
      throw usageError();
    }
    options[option.name] = option.value;
    index = option.next;
  }
  return { name, options };
}

// ---------------------------------------------------------------------------------------------
// Where a value comes from
// ---------------------------------------------------------------------------------------------

type Env = Readonly<Record<string, string | undefined>>;

/** Where one value came from: the name to show in an error, and the text if there is one. */
interface SettingSource {
  origin: "option" | "environment" | "default";
  name: string;
  text?: string;
}

function envName(setting: SettingName): string {
  return `IMBEHIND_${setting.toUpperCase().replace("-", "_")}`;
}

/** The option, else a non-empty environment variable, else the default. */
function pickSource(setting: SettingName, option: string | undefined, env: Env): SettingSource {
  if (option !== undefined) {
    return { origin: "option", name: `--${setting}`, text: option };
  }
  const fromEnv = env[envName(setting)];
  if (fromEnv) {
    return { origin: "environment", name: envName(setting), text: fromEnv };
  }
  return { origin: "default", name: `--${setting}` };
}

function shown(text: string): string {
  return text.slice(0, MAX_SHOWN);
}

/** The number in `text` when it is digits only and within the range, else undefined. */
function wholeNumber(text: string, min: number, max: number): number | undefined {
  if (!/^[0-9]+$/.test(text)) {
    return undefined;
  }
  const value = Number(text);
  return value >= min && value <= max ? value : undefined;
}

/** A value that must be a whole number in a range. The default is used when nothing is given. */
function resolveNumber(
  source: SettingSource,
  range: { min: number; max: number; fallback: number; unit: "seconds" | "port" },
): number {
  if (source.text === undefined) {
    return range.fallback;
  }
  const value = wholeNumber(source.text, range.min, range.max);
  if (value === undefined) {
    const expected =
      range.unit === "port"
        ? `a number from ${range.min} to ${range.max}`
        : `a whole number of seconds from ${range.min} to ${range.max}`;
    throw new InvalidOptionError(
      `${source.name} must be ${expected} (got "${shown(source.text)}").`,
    );
  }
  return value;
}

const TIMEOUT_RANGE = {
  min: 0,
  max: MAX_WAIT_LIMIT_SECONDS,
  fallback: DEFAULT_WAIT_LIMIT_SECONDS,
  unit: "seconds",
} as const;

/**
 * The wait limit of one `serve` start: the option, else the environment
 * variable, else the default. An empty environment variable counts as not set. A value that is not
 * digits only, or is above 2147483, ends the start with exit code 2.
 */
export function resolveWaitLimit(option: string | undefined, env: Env): number {
  return resolveNumber(pickSource("timeout", option, env), TIMEOUT_RANGE);
}

// ---------------------------------------------------------------------------------------------
// The host
// ---------------------------------------------------------------------------------------------

/** Turns a name into the addresses it stands for. Tests replace it. */
export type NameLookup = (name: string) => Promise<string[]>;

const systemLookup: NameLookup = async (name) => {
  const found = await dnsLookup(name, { all: true });
  return found.map((entry) => entry.address);
};

/**
 * Whether `address` is a loopback address: IPv4 in 127.0.0.0/8 or `::1`. `net.isIPv4` accepts only
 * four decimal numbers from 0 to 255, so `127.1`, `0x7f.0.0.1`, octal and single-number forms are
 * refused, the same as in the Host header check of the HTTP server.
 */
function isLoopbackAddress(address: string): boolean {
  return (net.isIPv4(address) && address.startsWith("127.")) || address === "::1";
}

function notLocal(text: string): InvalidOptionError {
  return new InvalidOptionError(
    `${shown(text)} is not a local address. imbehind only listens on this machine (127.0.0.0/8, ::1, localhost).`,
  );
}

/** The addresses that `localhost` stands for, or none when the lookup fails. */
async function localhostAddresses(lookup: NameLookup): Promise<string[]> {
  try {
    return await lookup("localhost");
  } catch {
    return [];
  }
}

/** The address to listen on: the text itself for a loopback address, the first address of localhost. */
async function resolveHost(source: SettingSource, lookup: NameLookup): Promise<string> {
  if (source.text === undefined) {
    return DEFAULT_HOST;
  }
  const text = source.text === "[::1]" ? "::1" : source.text;
  if (isLoopbackAddress(text)) {
    return text;
  }
  if (text.toLowerCase() === "localhost") {
    const addresses = await localhostAddresses(lookup);
    const first = addresses[0];
    if (first !== undefined && addresses.every(isLoopbackAddress)) {
      return first;
    }
  }
  throw notLocal(source.text);
}

// ---------------------------------------------------------------------------------------------
// The storage directory
// ---------------------------------------------------------------------------------------------

/**
 * The storage directory: the option, else a non-empty IMBEHIND_DIR, else the default of the
 * operating system. A relative path becomes absolute from the working directory. An empty option
 * is an invalid value (exit code 2). No default can be found: exit code 1.
 */
export function resolveStorageDir(option: string | undefined, info: PlatformInfo): string {
  const source = pickSource("dir", option, info.env);
  if (source.text === undefined) {
    const found = defaultStorageDir(info);
    if (found === undefined) {
      throw new StartupError(missingStorageBaseMessage(info.platform));
    }
    return found;
  }
  if (source.text === "") {
    throw new InvalidOptionError("--dir must not be empty.");
  }
  return absolutePath(info, source.text);
}

// ---------------------------------------------------------------------------------------------
// All settings of serve
// ---------------------------------------------------------------------------------------------

/**
 * Checks the six settings of `serve` in a fixed order and stops at the first
 * failure. It touches no file. The order: host, port, timeout, retention, sweep-interval,
 * dir, then retention against timeout.
 */
export async function resolveServeSettings(
  options: RawOptions,
  info: PlatformInfo,
  lookup: NameLookup = systemLookup,
): Promise<Settings> {
  const { env } = info;
  const host = await resolveHost(pickSource("host", options.host, env), lookup);
  const port = resolveNumber(pickSource("port", options.port, env), {
    min: 1,
    max: MAX_PORT,
    fallback: DEFAULT_PORT,
    unit: "port",
  });
  const waitLimitSeconds = resolveWaitLimit(options.timeout, env);
  const retentionSeconds = resolveNumber(pickSource("retention", options.retention, env), {
    min: 0,
    max: MAX_RETENTION_SECONDS,
    fallback: DEFAULT_RETENTION_SECONDS,
    unit: "seconds",
  });
  const sweepIntervalSeconds = resolveNumber(
    pickSource("sweep-interval", options["sweep-interval"], env),
    {
      min: 1,
      max: MAX_SWEEP_INTERVAL_SECONDS,
      fallback: DEFAULT_SWEEP_INTERVAL_SECONDS,
      unit: "seconds",
    },
  );
  const storageDir = resolveStorageDir(options.dir, info);
  checkRetention(retentionSeconds, waitLimitSeconds);
  return {
    host,
    port,
    storageDir,
    pollIntervalMs: POLL_INTERVAL_MS,
    waitLimitSeconds,
    retentionSeconds,
    sweepIntervalSeconds,
  };
}

/** With neither value 0, a finished request must be kept at least as long as it can wait. */
function checkRetention(retentionSeconds: number, waitLimitSeconds: number): void {
  if (retentionSeconds !== 0 && waitLimitSeconds !== 0 && retentionSeconds < waitLimitSeconds) {
    throw new InvalidOptionError(
      `--retention (${retentionSeconds} seconds) must not be shorter than --timeout (${waitLimitSeconds} seconds).`,
    );
  }
}

/** The settings with every default and the default storage directory of this machine. */
export function loadSettings(info: PlatformInfo = currentPlatformInfo()): Settings {
  return createSettings(resolveStorageDir(undefined, info));
}
