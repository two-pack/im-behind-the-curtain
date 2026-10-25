import { describe, expect, it } from "vitest";
import { POLL_INTERVAL_MS } from "../src/config.js";
import {
  CI_LIMIT_FACTOR,
  checkedSpanMs,
  DOCUMENTED_LIMIT_MS,
  STARTUP_MARGIN_MS,
  timingLimitMs,
  timingTestTimeoutMs,
} from "./helpers/timing-limit.js";

/**
 * The judging logic of the timing tests (NFR6, NFR7). None of these checks uses the real clock or
 * reads process.env: the environment is an object made in the test.
 */
describe("timingLimitMs", () => {
  it("is the documented 10 seconds when CI is not set", () => {
    expect(timingLimitMs({})).toBe(10_000);
    expect(DOCUMENTED_LIMIT_MS).toBe(10_000);
  });

  it("is twice the documented limit, 20 seconds, when CI is true", () => {
    expect(timingLimitMs({ CI: "true" })).toBe(20_000);
    expect(CI_LIMIT_FACTOR).toBe(2);
  });

  it("stays at 10 seconds when CI is false or empty", () => {
    expect(timingLimitMs({ CI: "false" })).toBe(10_000);
    expect(timingLimitMs({ CI: "" })).toBe(10_000);
  });
});

describe("checkedSpanMs", () => {
  it("adds one polling interval to a span that was measured without the polling wait", () => {
    expect(checkedSpanMs({ elapsedMs: 120, pollingExcluded: true, pollIntervalMs: 500 })).toBe(620);
  });

  it("keeps a span that was measured with the polling wait as it is", () => {
    expect(checkedSpanMs({ elapsedMs: 120, pollingExcluded: false, pollIntervalMs: 500 })).toBe(
      120,
    );
  });

  it("passes the 2974 ms reported in issue #6, with the local and the CI limit", () => {
    const span = checkedSpanMs({
      elapsedMs: 2974,
      pollingExcluded: false,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(span).toBeLessThanOrEqual(timingLimitMs({}));
    expect(span).toBeLessThanOrEqual(timingLimitMs({ CI: "true" }));
  });

  it("passes 9500 ms without polling exactly at the local limit, and fails 9501 ms", () => {
    const limit = timingLimitMs({});
    const atLimit = checkedSpanMs({
      elapsedMs: 9500,
      pollingExcluded: true,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    const overLimit = checkedSpanMs({
      elapsedMs: 9501,
      pollingExcluded: true,
      pollIntervalMs: POLL_INTERVAL_MS,
    });
    expect(atLimit).toBe(10_000);
    expect(atLimit).toBeLessThanOrEqual(limit);
    expect(overLimit).toBeGreaterThan(limit);
  });
});

describe("timingTestTimeoutMs", () => {
  it("gives every sequential wait the full limit and adds the startup margin", () => {
    expect(STARTUP_MARGIN_MS).toBe(5_000);
    const local = timingLimitMs({});
    const ci = timingLimitMs({ CI: "true" });
    const timeout = (sequentialWaits: number, limitMs: number) =>
      timingTestTimeoutMs({ sequentialWaits, limitMs, startupMarginMs: STARTUP_MARGIN_MS });
    expect(timeout(13, local)).toBe(135_000);
    expect(timeout(13, ci)).toBe(265_000);
    expect(timeout(2, local)).toBe(25_000);
  });
});
