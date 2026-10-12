import { Readable, Writable } from "node:stream";
import type { AnswerInputMode, PlatformInfo, ProcessIo } from "../../src/platform.js";

const LINUX: PlatformInfo = { platform: "linux", env: {}, homedir: "/home/alice" };

interface Recorder {
  stream: Writable;
  lines: () => string[];
  text: () => string;
}

/** A writable that keeps everything written to it. */
function recorder(): Recorder {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString("utf8"));
      callback();
    },
  });
  return {
    stream,
    text: () => chunks.join(""),
    lines: () => chunks.join("").split("\n").slice(0, -1),
  };
}

/**
 * A process environment with recorded output and a Ctrl+C that the test presses. `answerInput`
 * picks how `imbehind answer` uses the input, whatever `isTerminal` says. The tests
 * that type lines into the answer screen choose `interactive`.
 */
export function makeIo(
  info: PlatformInfo = LINUX,
  stdin: Readable = Readable.from([]),
  isTerminal = false,
  answerInput?: AnswerInputMode,
) {
  const out = recorder();
  const err = recorder();
  const handlers = new Set<() => void>();
  const fatalHandlers = new Set<() => void>();
  const io: ProcessIo = {
    stdin,
    stdout: out.stream,
    stderr: err.stream,
    isTerminal,
    ...(answerInput === undefined ? {} : { answerInput }),
    info,
    onInterrupt: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onFatalError: (handler) => {
      fatalHandlers.add(handler);
      return () => {
        fatalHandlers.delete(handler);
      };
    },
  };
  return {
    io,
    out,
    err,
    interrupt: () => {
      for (const handler of [...handlers]) {
        handler();
      }
    },
    listeners: () => handlers.size,
    /** Acts like an uncaught exception or an unhandled rejection of the process. */
    crash: () => {
      for (const handler of [...fatalHandlers]) {
        handler();
      }
    },
    fatalListeners: () => fatalHandlers.size,
  };
}

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
