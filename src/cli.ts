/**
 * The command layer: picks `serve`, `answer` or `path`, puts the parts together, and turns
 * failures into "Error:" lines and exit codes.
 */
import { AnswerConsole, createReplyReader, type ServeStatus } from "./answer/answer-console.js";
import { ExchangeBroker } from "./broker/exchange-broker.js";
import { type Clock, systemClock } from "./clock.js";
import {
  type CommandLine,
  type NameLookup,
  POLL_INTERVAL_MS,
  parseCommandLine,
  resolveServeSettings,
  resolveStorageDir,
  type Settings,
} from "./config.js";
import { EXIT, InvalidOptionError, IoFailure, StartupError } from "./errors.js";
import { HttpServer, type HttpServerOptions } from "./http/server.js";
import { shortId } from "./ids.js";
import { Logger, Screen } from "./log.js";
import { ctrlZEndsInput, type ProcessIo } from "./platform.js";
import { ExchangeStore, type StoreFs } from "./store/exchange-store.js";
import { type InspectOptions, inspectLock, ServeLock } from "./store/serve-lock.js";
import { Sweeper } from "./sweeper/sweeper.js";

/**
 * Test-only overrides. Production passes none. `settings` replaces the port and the storage
 * directory after every check has been made, so a test can use a free port and a temporary folder.
 */
export interface CliOptions {
  clock?: Clock;
  settings?: Partial<Pick<Settings, "port" | "storageDir">>;
  storeFs?: StoreFs;
  /** Turns the name `localhost` into addresses. */
  lookup?: NameLookup;
  /** Whether a process exists, for judging serve.lock. */
  isProcessAlive?: (processId: number) => boolean;
  /** Makes the server that listens. */
  createServer?: HttpServerOptions["createServer"];
}

interface Context {
  io: ProcessIo;
  options: CliOptions;
  clock: Clock;
  logger: Logger;
}

/** How serve ended: the person pressed Ctrl+C, or something unexpected failed. */
type Ending = { kind: "interrupted" } | { kind: "failed"; error: unknown };

/** The storage directory: decided like serve does, then replaced by a test override if any. */
function storageDirOf(command: CommandLine, context: Context): string {
  const resolved = resolveStorageDir(command.options.dir, context.io.info);
  return context.options.settings?.storageDir ?? resolved;
}

/** All settings of serve, checked in the fixed order before anything is touched. */
async function serveSettings(command: CommandLine, context: Context): Promise<Settings> {
  const resolved = await resolveServeSettings(
    command.options,
    context.io.info,
    context.options.lookup,
  );
  const { port = resolved.port, storageDir = resolved.storageDir } = context.options.settings ?? {};
  return { ...resolved, port, storageDir };
}

function newStore(storageDir: string, context: Context): ExchangeStore {
  return new ExchangeStore({
    rootDir: storageDir,
    fs: context.options.storeFs,
    platform: context.io.info.platform,
  });
}

function newBroker(store: ExchangeStore, context: Context, waitLimitSeconds = 0): ExchangeBroker {
  return new ExchangeBroker({
    store,
    clock: context.clock,
    pollIntervalMs: POLL_INTERVAL_MS,
    waitLimitSeconds,
  });
}

/**
 * Makes the broker ready: ids continue after the largest one in storage, and the ids of the
 * requests that wait now are listed. A storage that cannot be read ends the start.
 */
async function readStorage(broker: ExchangeBroker, storageDir: string): Promise<string[]> {
  try {
    await broker.initialize();
    return await broker.snapshotWaiting();
  } catch (error) {
    if (error instanceof IoFailure) {
      throw new StartupError(`cannot read ${storageDir}: ${error.detail}.`);
    }
    throw error;
  }
}

/** What serve runs once it listens, and how to stop all of it in the right order. */
interface Serving {
  stop(): Promise<void>;
}

/**
 * The part of the start after the lock is held: list the waiting requests, listen,
 * print the Listening line, abandon the listed requests, and then start the poll and the first
 * sweep side by side. When listening fails nothing about a request has been changed.
 */
async function startServing(
  context: Context,
  settings: Settings,
  store: ExchangeStore,
  fail: (error: unknown) => void,
): Promise<Serving> {
  const { clock, logger } = context;
  const broker = newBroker(store, context, settings.waitLimitSeconds);
  const waiting = await readStorage(broker, settings.storageDir);
  const server = new HttpServer({
    host: settings.host,
    port: settings.port,
    createServer: context.options.createServer,
    broker,
    logger,
    nowSeconds: () => Math.floor(clock.now().getTime() / 1000),
    onUnexpectedFailure: fail,
  });
  const address = await server.listen();
  logger.listening(address.host, address.port, settings.storageDir);
  try {
    await broker.abandon(waiting);
    const polling = broker.startPolling(fail);
    const sweeping = new Sweeper({
      broker,
      clock,
      retentionSeconds: settings.retentionSeconds,
      intervalSeconds: settings.sweepIntervalSeconds,
      onProblem: (id, reason) => logger.failure(id === undefined ? undefined : shortId(id), reason),
    }).start(fail);
    return {
      stop: async () => {
        // Stop accepting replies before anything else closes: a poll that is
        // still running must not claim a reply that no client will receive.
        broker.shutdown();
        await polling.stop();
        await sweeping.stop();
        await server.close();
      },
    };
  } catch (error) {
    broker.shutdown();
    await server.close();
    throw error;
  }
}

/**
 * The two ways serve ends while it runs. The first unexpected failure ends serve;
 * later ones are ignored. Ctrl+C is listened to from the moment the lock is held.
 */
function watchEnding(io: ProcessIo) {
  let fail: (error: unknown) => void = () => {};
  const failed = new Promise<Ending>((resolve) => {
    fail = (error) => resolve({ kind: "failed", error });
  });
  let stopListening: () => void = () => {};
  const interrupted = new Promise<Ending>((resolve) => {
    stopListening = io.onInterrupt(() => resolve({ kind: "interrupted" }));
  });
  return {
    fail,
    next: () => Promise.race([interrupted, failed]),
    stop: () => stopListening(),
  };
}

/** Everything serve does while it holds the lock. The lock is returned by the caller. */
async function serveWhileLocked(
  context: Context,
  settings: Settings,
  store: ExchangeStore,
  lock: ServeLock,
): Promise<number> {
  const watch = watchEnding(context.io);
  const heartbeat = lock.startHeartbeat({
    onLost: () =>
      watch.fail(new StartupError(`another imbehind serve took over ${settings.storageDir}.`)),
    onFailure: watch.fail,
  });
  try {
    const serving = await startServing(context, settings, store, watch.fail);
    const ending = await watch.next();
    await serving.stop();
    if (ending.kind === "failed") {
      throw ending.error;
    }
    return EXIT.interrupted;
  } finally {
    watch.stop();
    await heartbeat.stop();
  }
}

async function runServe(command: CommandLine, context: Context): Promise<number> {
  const settings = await serveSettings(command, context);
  const store = newStore(settings.storageDir, context);
  await store.prepare();
  const lock = new ServeLock({
    rootDir: settings.storageDir,
    platform: context.io.info.platform,
    clock: context.clock,
    fs: context.options.storeFs,
    isProcessAlive: context.options.isProcessAlive,
  });
  await lock.acquire();
  try {
    return await serveWhileLocked(context, settings, store, lock);
  } finally {
    await lock.release();
  }
}

/**
 * Looks at serve.lock once. Nothing is created. A serve.lock that cannot be read
 * (no permission, an input/output failure) is not "not running" and not foreign: it ends with
 * "cannot read <dir>: <reason>.". Content that can be read but is not a lock
 * counts as not running here.
 */
async function checkServe(options: InspectOptions): Promise<ServeStatus> {
  try {
    const verdict = await inspectLock(options);
    return { kind: verdict.kind === "running" ? "running" : "not-running" };
  } catch (error) {
    if (error instanceof IoFailure) {
      return { kind: "unreadable", detail: error.detail };
    }
    throw error;
  }
}

async function runAnswer(command: CommandLine, context: Context): Promise<number> {
  const { io, clock, logger, options } = context;
  const storageDir = storageDirOf(command, context);
  const controller = new AbortController();
  const stopListening = io.onInterrupt(() => controller.abort());
  const answer = new AnswerConsole({
    broker: newBroker(newStore(storageDir, context), context),
    screen: new Screen(io.stdout),
    errorScreen: new Screen(io.stderr),
    logger,
    clock,
    reader: createReplyReader(io.stdin, io.stdout, io.isTerminal, {
      ctrlZEnds: ctrlZEndsInput(io.info.platform),
    }),
    pollIntervalMs: POLL_INTERVAL_MS,
    storageDir,
    checkServe: () =>
      checkServe({
        rootDir: storageDir,
        clock,
        fs: options.storeFs,
        isProcessAlive: options.isProcessAlive,
      }),
  });
  try {
    return await answer.run(controller.signal);
  } finally {
    stopListening();
  }
}

/** `path`: the storage directory, one line. Nothing is created, read or looked at. */
function runPath(command: CommandLine, context: Context): number {
  new Screen(context.io.stdout).line(storageDirOf(command, context));
  return EXIT.success;
}

async function dispatch(
  argv: readonly string[],
  io: ProcessIo,
  options: CliOptions,
  logger: Logger,
  clock: Clock,
): Promise<number> {
  const command = parseCommandLine(argv);
  const context: Context = { io, options, clock, logger };
  switch (command.name) {
    case "serve":
      return runServe(command, context);
    case "answer":
      return runAnswer(command, context);
    default:
      return runPath(command, context);
  }
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
