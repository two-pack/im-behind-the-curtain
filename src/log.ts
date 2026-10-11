/**
 * The only way serve and answer write to the terminal.
 *
 * The logger has one function per kind of line, and the lines about requests take only fixed
 * values: a short id and a reason from a fixed list. A short id that does not look like one,
 * or a reason that is not in the list, is replaced by a placeholder, so a request or a reply
 * cannot reach the log by mistake. The one function that takes a sentence, `startupError`,
 * is for the program's own startup messages. The screen writer shows what a person must
 * read, such as a request, and it adds no color.
 */
import type { Clock } from "./clock.js";
import { IO_REASONS, type IoReason } from "./errors.js";

/** Where text goes. `process.stdout` and `process.stderr` fit, and tests pass a recorder. */
export interface Sink {
  write(text: string): unknown;
}

export interface LoggerOptions {
  out: Sink;
  err: Sink;
  clock: Clock;
}

/** The sentence of the fixed line for an unexpected failure. */
const UNEXPECTED_FAILURE = "unexpected failure.";

/** The width of the event column in a serve line. */
const EVENT_WIDTH = 10;
type EventWord = "received" | "replied" | "error";

const NO_ID = "------";
const SHORT_ID = /^[0-9a-f]{6}$/;

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function cleanId(shortId: string | undefined): string {
  return shortId !== undefined && SHORT_ID.test(shortId) ? shortId : NO_ID;
}

function cleanReason(reason: IoReason): IoReason {
  return (IO_REASONS as readonly string[]).includes(reason) ? reason : "failed";
}

export class Logger {
  private readonly out: Sink;
  private readonly err: Sink;
  private readonly clock: Clock;
  /** The failures that were already written, as "id|reason". */
  private readonly written = new Set<string>();

  constructor(options: LoggerOptions) {
    this.out = options.out;
    this.err = options.err;
    this.clock = options.clock;
  }

  listening(host: string, port: number, storageDir: string): void {
    this.out.write(`Listening on http://${host}:${port} (storage: ${storageDir})\n`);
  }

  received(shortId: string): void {
    this.event("received", shortId, "chat/completions  text");
  }

  replied(shortId: string): void {
    this.event("replied", shortId);
  }

  /** Writes a failure once for each pair of request and reason, until the request recovers. */
  failure(shortId: string | undefined, reason: IoReason): void {
    const id = cleanId(shortId);
    const fixed = cleanReason(reason);
    const key = `${id}|${fixed}`;
    if (this.written.has(key)) {
      return;
    }
    this.written.add(key);
    this.event("error", id, fixed);
  }

  /** Forgets the failures of a request, so a new failure is written again. */
  recovered(shortId: string | undefined): void {
    const prefix = `${cleanId(shortId)}|`;
    for (const key of [...this.written]) {
      if (key.startsWith(prefix)) {
        this.written.delete(key);
      }
    }
  }

  startupError(message: string): void {
    this.err.write(`Error: ${message}\n`);
  }

  /** The one line for a failure nobody planned for. It carries no message, stack or path. */
  unexpectedFailure(): void {
    this.startupError(UNEXPECTED_FAILURE);
  }

  /**
   * Writes one line of columns: the time, the event padded to ten columns, the short id, and
   * after two spaces the detail. An event word of ten or more characters is not cut and is
   * followed by two spaces. A line with no detail ends with the short id.
   */
  private event(event: EventWord, shortId: string, detail?: string): void {
    const now = this.clock.now();
    const time = `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const column = `${event.padEnd(Math.max(EVENT_WIDTH, event.length + 1))} `;
    const tail = detail === undefined ? "" : `  ${detail}`;
    this.out.write(`${time} ${column}${cleanId(shortId)}${tail}\n`);
  }
}

/** Writes lines for a person to read. */
export class Screen {
  private readonly sink: Sink;

  constructor(sink: Sink) {
    this.sink = sink;
  }

  line(text: string): void {
    this.sink.write(`${text}\n`);
  }
}
