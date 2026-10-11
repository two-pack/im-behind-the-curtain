import { describe, expect, it } from "vitest";
import { systemClock } from "../src/clock.js";

describe("system clock", () => {
  it("returns the current time", () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  it("sleeps for about the requested time", async () => {
    const start = Date.now();
    await systemClock.sleep(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it("wakes up early when the signal is aborted", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const sleeping = systemClock.sleep(10_000, controller.signal);
    controller.abort();
    await sleeping;
    expect(Date.now() - start).toBeLessThan(1000);
  });

  it("returns at once when the signal is already aborted", async () => {
    const start = Date.now();
    await systemClock.sleep(10_000, AbortSignal.abort());
    expect(Date.now() - start).toBeLessThan(1000);
  });
});
