import { randomBytes } from "node:crypto";

/** A UTC time to the millisecond, a hyphen, and six lowercase hex digits. */
export const REQUEST_ID_PATTERN = /^[0-9]{8}T[0-9]{9}Z-[0-9a-f]{6}$/;

export function isRequestId(value: string): boolean {
  return REQUEST_ID_PATTERN.test(value);
}

/** Builds the id text from a time in milliseconds and six hex digits. */
export function formatRequestId(timeMs: number, hex: string): string {
  const stamp = new Date(timeMs).toISOString().replace(/[-:.]/g, "");
  return `${stamp}-${hex}`;
}

/** Reads the time of an id back as milliseconds since the epoch. */
export function requestIdTimeMs(id: string): number {
  const part = (start: number, end: number): number => Number(id.slice(start, end));
  return Date.UTC(
    part(0, 4),
    part(4, 6) - 1,
    part(6, 8),
    part(9, 11),
    part(11, 13),
    part(13, 15),
    part(15, 18),
  );
}

/** The last six hex digits. Both serve and answer show this to tell requests apart. */
export function shortId(id: string): string {
  return id.slice(-6);
}

/** The largest valid id among the given names. Other names are ignored. */
export function maxRequestId(names: readonly string[]): string | undefined {
  let largest: string | undefined;
  for (const name of names) {
    if (isRequestId(name) && (largest === undefined || name > largest)) {
      largest = name;
    }
  }
  return largest;
}

export interface IdGenerator {
  /** Assigns the next id. Its time is always later than the time of the previous id. */
  next(nowMs: number): string;
}

export interface IdGeneratorOptions {
  /** The largest id already in storage. New ids continue after it. */
  after?: string;
  /** Source of the six hex digits. Tests replace it. */
  randomHex?: () => string;
}

function randomSixHex(): string {
  return randomBytes(3).toString("hex");
}

/**
 * Ids are assigned one at a time and synchronously, so two ids never share a time.
 * When the clock is not later than the previous id, the previous time plus one
 * millisecond is used instead.
 */
export function createIdGenerator(options: IdGeneratorOptions = {}): IdGenerator {
  const randomHex = options.randomHex ?? randomSixHex;
  let lastMs =
    options.after === undefined ? Number.NEGATIVE_INFINITY : requestIdTimeMs(options.after);
  return {
    next(nowMs: number): string {
      lastMs = nowMs > lastMs ? nowMs : lastMs + 1;
      return formatRequestId(lastMs, randomHex());
    },
  };
}
