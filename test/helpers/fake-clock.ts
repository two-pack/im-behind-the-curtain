import type { Clock } from "../../src/clock.js";

/** Lets every pending promise callback run. */
export function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

interface Sleeper {
  at: number;
  resolve: () => void;
}

/** A clock that only moves when the test advances it. Sleeping waits for `advance`. */
export class FakeClock implements Clock {
  private nowMs: number;
  private sleepers: Sleeper[] = [];

  constructor(startMs = Date.UTC(2026, 9, 9, 14, 5, 12, 0)) {
    this.nowMs = startMs;
  }

  now(): Date {
    return new Date(this.nowMs);
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const sleeper: Sleeper = { at: this.nowMs + ms, resolve };
      this.sleepers.push(sleeper);
      signal?.addEventListener(
        "abort",
        () => {
          this.sleepers = this.sleepers.filter((other) => other !== sleeper);
          resolve();
        },
        { once: true },
      );
    });
  }

  /** The number of sleeps that have not finished. */
  get sleeping(): number {
    return this.sleepers.length;
  }

  /** Moves time forward and wakes every sleeper that falls due, in order. */
  async advance(ms: number): Promise<void> {
    const target = this.nowMs + ms;
    for (;;) {
      const due = this.sleepers.filter((sleeper) => sleeper.at <= target);
      const next = due.sort((a, b) => a.at - b.at)[0];
      if (next === undefined) {
        break;
      }
      this.sleepers = this.sleepers.filter((sleeper) => sleeper !== next);
      this.nowMs = Math.max(this.nowMs, next.at);
      next.resolve();
      await settle();
    }
    this.nowMs = target;
    await settle();
  }
}
