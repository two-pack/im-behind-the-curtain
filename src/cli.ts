/**
 * The command layer: picks `serve` or `answer`, puts the parts together, and turns
 * failures into "Error:" lines and exit codes.
 */
import { AnswerConsole, createReplyReader } from "./answer/answer-console.js";
import { ExchangeBroker } from "./broker/exchange-broker.js";
import { type Clock, systemClock } from "./clock.js";
import { createSettings, loadSettings, resolveWaitLimit, type Settings } from "./config.js";
import { EXIT, InvalidOptionError, IoFailure, StartupError } from "./errors.js";
import { HttpServer } from "./http/server.js";
import { Logger, Screen } from "./log.js";
import { ctrlZEndsInput, type ProcessIo } from "./platform.js";
import { ExchangeStore, type StoreFs } from "./store/exchange-store.js";

/** Test-only overrides. Production passes none. The listening address cannot be changed. */
export interface CliOptions {
  clock?: Clock;
  settings?: Partial<Pick<Settings, "port" | "storageDir">>;
  storeFs?: StoreFs;
}

interface Context {
  io: ProcessIo;
  clock: Clock;
  logger: Logger;
  settings: Settings;
  store: ExchangeStore;
}

/** How serve ended: the person pressed Ctrl+C, or something unexpected failed. */
type Ending = { kind: "interrupted" } | { kind: "failed"; error: unknown };

const USAGE = "usage: imbehind serve | imbehind answer";

/** The command that was asked for. `timeout` is the text after `--timeout`, for serve only. */
interface Command {
  name: "serve" | "answer";
  timeout?: string;
}

const TIMEOUT_OPTION = "--timeout";

/**
 * Reads the words after the program name: `answer`, or `serve` with an optional
 * `--timeout <seconds>` or `--timeout=<seconds>`. Anything else gives undefined. The value is
 * not checked here.
 */
function parseCommand(argv: readonly string[]): Command | undefined {
  const [name, ...rest] = argv;
  if (name === "answer") {
    return rest.length === 0 ? { name } : undefined;
  }
  if (name !== "serve") {
    return undefined;
  }
  const [word, value, ...more] = rest;
  if (word === undefined) {
    return { name };
  }
  if (word.startsWith(`${TIMEOUT_OPTION}=`) && value === undefined) {
    return { name, timeout: word.slice(TIMEOUT_OPTION.length + 1) };
  }
  return word === TIMEOUT_OPTION && more.length === 0 ? { name, timeout: value ?? "" } : undefined;
}

function resolveSettings(io: ProcessIo, options: CliOptions): Settings {
  const override = options.settings;
  if (override?.storageDir !== undefined) {
    return createSettings(override.storageDir, override.port);
  }
  const loaded = loadSettings(io.info);
  return override?.port === undefined ? loaded : { ...loaded, port: override.port };
}

async function prepare(
  io: ProcessIo,
  options: CliOptions,
  logger: Logger,
  clock: Clock,
  waitLimitSeconds?: number,
): Promise<Context> {
  const resolved = resolveSettings(io, options);
  const settings = waitLimitSeconds === undefined ? resolved : { ...resolved, waitLimitSeconds };
  const store = new ExchangeStore({ rootDir: settings.storageDir, fs: options.storeFs });
  await store.prepare();
  return { io, clock, logger, settings, store };
}

function newBroker(context: Context): ExchangeBroker {
  return new ExchangeBroker({
    store: context.store,
    clock: context.clock,
    pollIntervalMs: context.settings.pollIntervalMs,
    waitLimitSeconds: context.settings.waitLimitSeconds,
  });
}

async function runServe(context: Context): Promise<number> {
  const { io, clock, logger, settings } = context;
  const broker = newBroker(context);
  try {
    await broker.initialize();
  } catch (error) {
    if (error instanceof IoFailure) {
      throw new StartupError(`cannot read ${settings.storageDir}: ${error.detail}.`);
    }
    throw error;
  }
  // The first unexpected failure ends serve. Later ones are ignored.
  let fail: (error: unknown) => void = () => {};
  const failed = new Promise<Ending>((resolve) => {
    fail = (error) => resolve({ kind: "failed", error });
  });
  const server = new HttpServer({
    host: settings.host,
    port: settings.port,
    broker,
    logger,
    nowSeconds: () => Math.floor(clock.now().getTime() / 1000),
    onUnexpectedFailure: fail,
  });
  const address = await server.listen();
  logger.listening(address.host, address.port, settings.storageDir);
  const polling = broker.startPolling(fail);
  let stopListening: () => void = () => {};
  const interrupted = new Promise<Ending>((resolve) => {
    stopListening = io.onInterrupt(() => resolve({ kind: "interrupted" }));
  });
  const ending = await Promise.race([interrupted, failed]);
  stopListening();
  // Stop accepting replies before anything else closes: a poll that is still
  // running must not claim a reply that no client will receive.
  broker.shutdown();
  await polling.stop();
  await server.close();
  if (ending.kind === "failed") {
    throw ending.error;
  }
  return EXIT.interrupted;
}

async function runAnswer(context: Context): Promise<number> {
  const { io, clock, logger, settings } = context;
  const controller = new AbortController();
  const stopListening = io.onInterrupt(() => controller.abort());
  const answer = new AnswerConsole({
    broker: newBroker(context),
    screen: new Screen(io.stdout),
    errorScreen: new Screen(io.stderr),
    logger,
    clock,
    reader: createReplyReader(io.stdin, io.stdout, io.isTerminal, {
      ctrlZEnds: ctrlZEndsInput(io.info.platform),
    }),
    pollIntervalMs: settings.pollIntervalMs,
  });
  try {
    return await answer.run(controller.signal);
  } finally {
    stopListening();
  }
}

async function dispatch(
  argv: readonly string[],
  io: ProcessIo,
  options: CliOptions,
  logger: Logger,
  clock: Clock,
): Promise<number> {
  const command = parseCommand(argv);
  if (command === undefined) {
    throw new StartupError(USAGE);
  }
  // Only serve uses the wait limit. It is checked before anything is created on disk.
  const waitLimit =
    command.name === "serve" ? resolveWaitLimit(command.timeout, io.info.env) : undefined;
  const context = await prepare(io, options, logger, clock, waitLimit);
  return command.name === "serve" ? runServe(context) : runAnswer(context);
}

/** How long a command may take to wind down after a failure before main returns anyway. */
const WIND_DOWN_MS = 2000;

/**
 * Watches for the failures that no command handles: an error event of standard output or
 * standard error (a closed or broken terminal), an uncaught exception, and an unhandled
 * rejection. The first one writes the fixed unexpected-failure line, unless standard error itself
 * is broken, and resolves `failed`. Later ones are ignored. Nothing about the error is kept.
 */
function watchForFailure(io: ProcessIo, logger: Logger) {
  let stderrBroken = false;
  let hasFailed = false;
  let resolveFailed: () => void = () => {};
  const failed = new Promise<void>((resolve) => {
    resolveFailed = resolve;
  });
  const fail = (): void => {
    if (hasFailed) {
      return;
    }
    hasFailed = true;
    if (!stderrBroken) {
      logger.unexpectedFailure();
    }
    resolveFailed();
  };
  const onStdoutError = (): void => fail();
  const onStderrError = (): void => {
    stderrBroken = true;
    fail();
  };
  io.stdout.on("error", onStdoutError);
  io.stderr.on("error", onStderrError);
  const stopFatal = io.onFatalError(fail);
  const stop = (): void => {
    io.stdout.off("error", onStdoutError);
    io.stderr.off("error", onStderrError);
    stopFatal();
  };
  return { failed, hasFailed: () => hasFailed, stop };
}

/**
 * The same environment, except that a failure also counts as Ctrl+C for the command. So the
 * command winds down the way it does for Ctrl+C and leaves the waiting requests as they are.
 */
function windDownOnFailure(io: ProcessIo, failed: Promise<void>): ProcessIo {
  return {
    ...io,
    onInterrupt: (handler) => {
      let listening = true;
      const stop = io.onInterrupt(handler);
      void failed.then(() => {
        if (listening) {
          handler();
        }
      });
      return () => {
        listening = false;
        stop();
      };
    },
  };
}

/** Waits for the command to finish winding down, but not longer than WIND_DOWN_MS. */
async function waitToWindDown(command: Promise<unknown>): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, WIND_DOWN_MS);
    timer.unref();
  });
  try {
    await Promise.race([command, limit]);
  } finally {
    clearTimeout(timer);
  }
}

/** Runs one command and returns the exit code. */
export async function main(
  argv: readonly string[],
  io: ProcessIo,
  options: CliOptions = {},
): Promise<number> {
  const clock = options.clock ?? systemClock;
  const logger = new Logger({ out: io.stdout, err: io.stderr, clock });
  const watch = watchForFailure(io, logger);
  try {
    // A broken terminal or an uncaught error ends the command with the fixed line. The
    // command winds down as for Ctrl+C, so waiting requests stay as they are.
    const command = dispatch(
      argv,
      windDownOnFailure(io, watch.failed),
      options,
      logger,
      clock,
    ).catch((error: unknown) => handleFailure(error, logger, watch.hasFailed()));
    const code = await Promise.race([command, watch.failed.then(() => EXIT.failure)]);
    if (watch.hasFailed()) {
      await waitToWindDown(command);
      return EXIT.failure;
    }
    return code;
  } finally {
    watch.stop();
  }
}

/** Turns a failure of a command into its "Error:" line and the exit code. */
function handleFailure(error: unknown, logger: Logger, alreadyReported: boolean): number {
  if (alreadyReported) {
    return EXIT.failure;
  }
  if (error instanceof StartupError) {
    logger.startupError(error.message);
    return error instanceof InvalidOptionError ? EXIT.invalidOption : EXIT.failure;
  }
  // Any other exception is unexpected. Its message, stack and paths are never shown.
  logger.unexpectedFailure();
  return EXIT.failure;
}
