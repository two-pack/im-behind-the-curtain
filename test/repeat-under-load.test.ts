import { describe, expect, it } from "vitest";
import { parseRuns, repeatUnderLoad } from "./tools/repeat-under-load.js";

/**
 * The tool that repeats the timing tests under load (npm run timing:load). These checks give it
 * a fake load and a fake run, so no real load is started and vitest is not started again.
 */
interface Fake {
  calls: string[];
  startLoad: () => () => Promise<void>;
}

/** A fake load that records when it was started and stopped. */
function fakeLoad(calls: string[] = []): Fake {
  return {
    calls,
    startLoad: () => {
      calls.push("start");
      return async () => {
        calls.push("stop");
      };
    },
  };
}

const quiet = (): void => {};

describe("repeatUnderLoad", () => {
  it("returns 0 and runs the given number of times when every run passes", async () => {
    const load = fakeLoad();
    const code = await repeatUnderLoad({
      runs: 3,
      startLoad: load.startLoad,
      runOnce: async (run) => {
        load.calls.push(`run ${run}`);
        return true;
      },
      log: quiet,
    });
    expect(code).toBe(0);
    expect(load.calls).toEqual(["start", "run 1", "run 2", "run 3", "stop"]);
  });

  it("returns 1 when one run fails, and still does every run so that failures can be counted", async () => {
    const load = fakeLoad();
    const lines: string[] = [];
    const code = await repeatUnderLoad({
      runs: 3,
      startLoad: load.startLoad,
      runOnce: async (run) => {
        load.calls.push(`run ${run}`);
        return run !== 2;
      },
      log: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(load.calls).toEqual(["start", "run 1", "run 2", "run 3", "stop"]);
    expect(lines.at(-1)).toContain("1 of 3 runs failed");
  });

  it("counts a run that throws as failed and returns 1", async () => {
    const load = fakeLoad();
    const lines: string[] = [];
    const code = await repeatUnderLoad({
      runs: 2,
      startLoad: load.startLoad,
      runOnce: async (run) => {
        if (run === 1) {
          throw new Error("vitest could not start");
        }
        return true;
      },
      log: (line) => lines.push(line),
    });
    expect(code).toBe(1);
    expect(lines.join("\n")).toContain("vitest could not start");
    expect(lines.at(-1)).toContain("1 of 2 runs failed");
  });

  it("stops the load exactly once whether the runs pass, fail or throw", async () => {
    const outcomes: Array<() => Promise<boolean>> = [
      async () => true,
      async () => false,
      async () => {
        throw new Error("broken");
      },
    ];
    for (const outcome of outcomes) {
      const load = fakeLoad();
      await repeatUnderLoad({ runs: 2, startLoad: load.startLoad, runOnce: outcome, log: quiet });
      expect(load.calls.filter((call) => call === "stop")).toHaveLength(1);
      expect(load.calls.at(-1)).toBe("stop");
    }
  });

  it("runs 10 times when no number of runs is given", async () => {
    let count = 0;
    const code = await repeatUnderLoad({
      startLoad: fakeLoad().startLoad,
      runOnce: async () => {
        count += 1;
        return true;
      },
      log: quiet,
    });
    expect(code).toBe(0);
    expect(count).toBe(10);
  });
});

describe("parseRuns", () => {
  it("gives 10 when --runs is not given", () => {
    expect(parseRuns([])).toBe(10);
  });

  it("accepts a positive whole number after --runs", () => {
    expect(parseRuns(["--runs", "1"])).toBe(1);
    expect(parseRuns(["--runs", "25"])).toBe(25);
  });

  it("refuses 0, a negative number, a fraction and a value that is not a number", () => {
    for (const value of ["0", "-3", "1.5", "abc", ""]) {
      expect(() => parseRuns(["--runs", value]), value).toThrow(/--runs/);
    }
  });

  it("refuses --runs without a value and an argument it does not know", () => {
    expect(() => parseRuns(["--runs"])).toThrow(/--runs/);
    expect(() => parseRuns(["--fast"])).toThrow(/--fast/);
  });
});
