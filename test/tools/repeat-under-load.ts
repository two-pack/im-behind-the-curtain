/**
 * Runs the timing tests (test/e2e/timing.test.ts) several times while every logical CPU core is
 * kept busy, the way a slow CI runner might be. Run it with `npm run timing:load`, and give
 * `-- --runs <n>` for another number of runs than 10. It ends with exit code 0 when every run
 * passed and 1 when any run failed. It is not part of `npm run check` or of CI.
 *
 * It needs nothing but Node.js and the installed dependencies.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TIMING_TEST = path.join("test", "e2e", "timing.test.ts");
const DEFAULT_RUNS = 10;
/** A child process that does nothing but compute, to keep one CPU core busy. */
const BUSY_LOOP = "for (;;) {}";

/** Stops the load and resolves once it has stopped. */
type StopLoad = () => Promise<void> | void;

/** The number of runs from the arguments: `--runs <n>`, where n is a whole number of 1 or more. */
export function parseRuns(args: readonly string[]): number {
  let runs = DEFAULT_RUNS;
  let index = 0;
  while (index < args.length) {
    const arg = args[index];
    if (arg !== "--runs") {
      throw new Error(`unknown argument ${JSON.stringify(arg)}. Use --runs <n>.`);
    }
    runs = parseCount(args[index + 1]);
    index += 2;
  }
  return runs;
}

function parseCount(value: string | undefined): number {
  if (value === undefined || !/^[1-9]\d*$/.test(value)) {
    throw new Error(
      `--runs needs a whole number of 1 or more, not ${JSON.stringify(value ?? "")}.`,
    );
  }
  return Number(value);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Does one run and tells whether it passed. A run that throws counts as failed. */
async function attempt(
  run: number,
  runOnce: (run: number) => Promise<boolean>,
  log: (line: string) => void,
): Promise<boolean> {
  try {
    const passed = await runOnce(run);
    log(`Run ${run} ${passed ? "passed" : "failed"}.`);
    return passed;
  } catch (error) {
    log(`Run ${run} failed: ${describeError(error)}`);
    return false;
  }
}

/**
 * Starts the load, does every run, stops the load and returns the exit code: 0 when every run
 * passed, 1 when any failed. A failed run does not end the loop, so the failures can be counted.
 * The load is stopped once, whether the runs pass, fail or throw.
 */
export async function repeatUnderLoad(options: {
  runs?: number;
  startLoad: () => StopLoad;
  runOnce: (run: number) => Promise<boolean>;
  log?: (line: string) => void;
}): Promise<number> {
  const runs = options.runs ?? DEFAULT_RUNS;
  const log = options.log ?? console.log;
  const stop = options.startLoad();
  let failures = 0;
  try {
    for (let run = 1; run <= runs; run += 1) {
      if (!(await attempt(run, options.runOnce, log))) {
        failures += 1;
      }
    }
  } finally {
    await stop();
  }
  log(failures === 0 ? `All ${runs} runs passed.` : `${failures} of ${runs} runs failed.`);
  return failures === 0 ? 0 : 1;
}

/** Ends one busy child process and resolves when it is gone. */
function stopWorker(worker: ChildProcess): Promise<void> {
  if (worker.exitCode !== null || worker.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    worker.once("exit", () => resolve());
    worker.once("error", () => resolve());
    worker.kill();
  });
}

/** Starts one busy child process per logical CPU core and returns how to stop them. */
function startCpuLoad(): StopLoad {
  const count = availableParallelism();
  const workers = Array.from({ length: count }, () => {
    const worker = spawn(process.execPath, ["-e", BUSY_LOOP], { stdio: "ignore" });
    worker.on("error", (error) => console.error(`A load process failed: ${error.message}`));
    return worker;
  });
  console.log(`Started ${count} load processes, one per logical CPU core.`);
  return async () => {
    await Promise.all(workers.map(stopWorker));
    console.log("Stopped the load processes.");
  };
}

/** The path of the vitest command, found through package resolution. */
function resolveVitestCli(): string {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("vitest/package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof manifest.bin === "string" ? manifest.bin : manifest.bin?.vitest;
  if (bin === undefined) {
    throw new Error(`${manifestPath} names no vitest command`);
  }
  return path.resolve(path.dirname(manifestPath), bin);
}

/** Runs the timing tests once with vitest and tells whether they passed. */
function runTimingTests(vitestCli: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [vitestCli, "run", TIMING_TEST], {
      cwd: ROOT,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code === 0));
  });
}

async function main(args: readonly string[]): Promise<number> {
  let runs: number;
  let vitestCli: string;
  try {
    runs = parseRuns(args);
    vitestCli = resolveVitestCli();
  } catch (error) {
    console.error(`timing:load cannot start: ${describeError(error)}`);
    return 1;
  }
  return repeatUnderLoad({
    runs,
    startLoad: startCpuLoad,
    runOnce: () => runTimingTests(vitestCli),
  });
}

/**
 * True when Node.js runs this file as the command, false when a test imports it. Both paths are
 * compared as real paths, so a symbolic link on the way to the repository does not hide the
 * command.
 */
function startedAsCommand(): boolean {
  const script = process.argv[1];
  return (
    script !== undefined && realpathSync(script) === realpathSync(fileURLToPath(import.meta.url))
  );
}

if (startedAsCommand()) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`timing:load failed: ${describeError(error)}`);
    process.exitCode = 1;
  }
}
