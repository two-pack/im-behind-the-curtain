import { describe, expect, it } from "vitest";
import {
  createIdGenerator,
  formatRequestId,
  isRequestId,
  maxRequestId,
  REQUEST_ID_PATTERN,
  requestIdTimeMs,
  shortId,
} from "../src/ids.js";

const EXAMPLE_TIME = Date.UTC(2026, 9, 9, 14, 5, 12, 123);
const EXAMPLE_ID = "20261009T140512123Z-a1b2c3";

describe("request id format", () => {
  it("formats a UTC time to the millisecond and six hex digits", () => {
    expect(formatRequestId(EXAMPLE_TIME, "a1b2c3")).toBe(EXAMPLE_ID);
    expect(REQUEST_ID_PATTERN.test(EXAMPLE_ID)).toBe(true);
  });

  it("recognizes only ids of the documented shape", () => {
    expect(isRequestId(EXAMPLE_ID)).toBe(true);
    expect(isRequestId(`.${EXAMPLE_ID}`)).toBe(false);
    expect(isRequestId("20261009T140512123Z-A1B2C3")).toBe(false);
    expect(isRequestId("20261009T140512123-a1b2c3")).toBe(false);
    expect(isRequestId("20261009T140512123Z-a1b2c")).toBe(false);
    expect(isRequestId("not-an-id")).toBe(false);
  });

  it("reads the time back out of an id", () => {
    expect(requestIdTimeMs(EXAMPLE_ID)).toBe(EXAMPLE_TIME);
  });

  it("takes the last six hex digits as the short id", () => {
    expect(shortId(EXAMPLE_ID)).toBe("a1b2c3");
  });
});

describe("request id generator", () => {
  it("uses the current time and random hex when the clock moves forward", () => {
    const generator = createIdGenerator();
    const id = generator.next(EXAMPLE_TIME);
    expect(isRequestId(id)).toBe(true);
    expect(requestIdTimeMs(id)).toBe(EXAMPLE_TIME);
  });

  it("gives every id a time strictly later than the previous one", () => {
    const generator = createIdGenerator();
    const first = generator.next(EXAMPLE_TIME);
    const sameMillisecond = generator.next(EXAMPLE_TIME);
    const clockWentBack = generator.next(EXAMPLE_TIME - 5000);
    expect(requestIdTimeMs(first)).toBe(EXAMPLE_TIME);
    expect(requestIdTimeMs(sameMillisecond)).toBe(EXAMPLE_TIME + 1);
    expect(requestIdTimeMs(clockWentBack)).toBe(EXAMPLE_TIME + 2);
  });

  it("assigns ten ids in one millisecond without overlap and in ascending order", () => {
    const generator = createIdGenerator();
    const ids = Array.from({ length: 10 }, () => generator.next(EXAMPLE_TIME));
    expect(new Set(ids).size).toBe(10);
    expect([...ids].sort()).toEqual(ids);
  });

  it("rolls over to the next second in the id text", () => {
    const generator = createIdGenerator({ randomHex: () => "000000" });
    const atBoundary = Date.UTC(2026, 9, 9, 14, 5, 12, 999);
    generator.next(atBoundary);
    expect(generator.next(atBoundary)).toBe("20261009T140513000Z-000000");
  });

  it("continues after the largest id that is already in storage", () => {
    const generator = createIdGenerator({ after: EXAMPLE_ID });
    const sameTime = generator.next(EXAMPLE_TIME);
    const earlierClock = createIdGenerator({ after: EXAMPLE_ID }).next(EXAMPLE_TIME - 60_000);
    expect(requestIdTimeMs(sameTime)).toBe(EXAMPLE_TIME + 1);
    expect(requestIdTimeMs(earlierClock)).toBe(EXAMPLE_TIME + 1);
  });

  it("uses lowercase hex from the injected random source", () => {
    const generator = createIdGenerator({ randomHex: () => "0a1b2c" });
    expect(generator.next(EXAMPLE_TIME)).toBe("20261009T140512123Z-0a1b2c");
  });
});

describe("largest id in storage", () => {
  it("returns the largest valid id and ignores other names", () => {
    const names = [
      "20261009T140512123Z-a1b2c3",
      ".20261010T000000000Z-ffffff",
      "20261009T140513000Z-000000",
      "stray.txt",
      "zzzz",
    ];
    expect(maxRequestId(names)).toBe("20261009T140513000Z-000000");
  });

  it("returns undefined when there is no valid id", () => {
    expect(maxRequestId([])).toBeUndefined();
    expect(maxRequestId([".hidden", "other"])).toBeUndefined();
  });
});
