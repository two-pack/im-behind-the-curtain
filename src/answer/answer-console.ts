/**
 * The screen of `imbehind answer`: shows the oldest waiting request, reads the person's
 * reply (or the wish to skip the request), places it, and tells how the request ended.
 */
import { clearLine, createInterface, cursorTo, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type {
  BrokerEvent,
  Confirmation,
  ExchangeBroker,
  WaitingExchange,
  WaitingListing,
} from "../broker/exchange-broker.js";
import type { Clock } from "../clock.js";
import { EXIT, IoFailure } from "../errors.js";
import { shortId } from "../ids.js";
import type { Logger, Screen } from "../log.js";
import type { ReplyFileKind, ReplyKind } from "../model.js";
import { endOfInputHint } from "../platform.js";
import { conversationLines, escapeAllControls, escapeControls } from "./conversation-view.js";

/** Every sentence the screen shows, in one place. */
const TEXT = {
  waiting: "Waiting for requests... (press Ctrl+C to quit)",
  emptyReply: "The reply is empty. Type a reply, or press Ctrl+C to quit.",
  sent: "Sent.",
  skipped: "Skipped.",
  skipPrompt: "Skip this request? The client will receive an error. [y/N] ",
  notSent: "Not sent: this request was already answered in another window.",
  ended: "Not sent: this request has already ended.",
  cancelled: "Cancelled: the client disconnected. Your reply will not be sent.",
  timedOut: (limitSeconds: number | undefined) =>
    `Timed out: the request waited longer than ${
      limitSeconds === undefined ? "the wait limit" : `${limitSeconds} seconds`
    }. Your reply will not be sent.`,
  newRequests: (count: number) => `New request received. ${count} requests are waiting.`,
  inputEnded: "Error: input ended. Nothing was sent; the request is still waiting.",
  writeFailed: (detail: string) => `Error: could not write the reply. ${detail}.`,
  quit: (id: string) => `Quit. Request ${shortId(id)} is still waiting.`,
  unsupported: (id: string) =>
    `Cannot show request ${shortId(id)}: this version does not support it.`,
  prompt: () => `Type your reply. Finish with ${endOfInputHint()}.`,
  jsonPrompt: () => `Type the JSON. Finish with ${endOfInputHint()}.`,
  jsonAgain: () => `Type the JSON again. Finish with ${endOfInputHint()}.`,
  requiredShape: "Required shape:",
  anyJson: "Any JSON value is accepted as long as it is valid JSON.",
  notJson: (reason: string) => `Not sent: your reply is not valid JSON (${reason}).`,
  serveNotRunning: (dir: string) => `Error: imbehind serve is not running for ${dir}.`,
  startServe: "Start it with: imbehind serve",
  cannotRead: (dir: string, detail: string) => `Error: cannot read ${dir}: ${detail}.`,
} as const;

/** The word shown after "Reply:" for each kind of reply. */
const REPLY_KIND_LABELS: Readonly<Record<ReplyKind, string>> = { text: "text", json: "JSON" };

/** Total width of the line above each request. */
const SEPARATOR_WIDTH = 60;

export type ReadResult =
  | { kind: "reply"; text: string; gotInput: boolean }
  | { kind: "interrupted" };

/** The answer to one question: a line, the end of the input, or Ctrl+C. */
export type LineResult = { kind: "line"; text: string } | { kind: "end" } | { kind: "interrupted" };

/** Reads what the person types. */
export interface ReplyReader {
  /** Reads one reply: the lines the person types, until they end the input. */
  readReply(signal: AbortSignal): Promise<ReadResult>;
  /** Shows `prompt` and reads the one line that answers it. */
  readLine(prompt: string, signal: AbortSignal): Promise<LineResult>;
  /** Writes one line above what the person is typing, and draws the typed text again. */
  notify(text: string): void;
}

/**
 * A reader that opens a fresh line reader for every reply and every question, so that ending
 * one reply with the end-of-input key does not stop the next one. Standard input that has
 * already ended gives an empty reply, or the end of the input, at once.
 */
export function createReplyReader(
  input: Readable,
  output: Writable,
  terminal: boolean,
  options: ReplyReaderOptions = {},
): ReplyReader {
  const reader: ReaderSetup = {
    input,
    output,
    terminal,
    ctrlZEnds: options.ctrlZEnds === true,
    active: undefined,
  };
  return {
    readReply: (signal) => {
      if (signal.aborted) {
        return Promise.resolve<ReadResult>({ kind: "interrupted" });
      }
      if (input.readableEnded) {
        return Promise.resolve<ReadResult>({ kind: "reply", text: "", gotInput: false });
      }
      return readOneReply(reader, signal);
    },
    readLine: (prompt, signal) => {
      if (signal.aborted) {
        return Promise.resolve<LineResult>({ kind: "interrupted" });
      }
      if (input.readableEnded) {
        return Promise.resolve<LineResult>({ kind: "end" });
      }
      return readOneLine(reader, prompt, signal);
    },
    notify: (text) => showAboveInput(reader, text),
  };
}

export interface ReplyReaderOptions {
  /** Treat "Ctrl+Z, then Enter" as the end of the input (needed in a Windows console). */
  ctrlZEnds?: boolean;
}

interface ReaderSetup {
  input: Readable;
  output: Writable;
  terminal: boolean;
  ctrlZEnds: boolean;
  /** The line reader that is open now, if the person is typing. */
  active: Interface | undefined;
}

interface KeyPress {
  ctrl?: boolean;
  name?: string;
}

/**
 * On Windows "Ctrl+Z, then Enter" ends the input, but Node's line reader ignores it. This
 * watches the keys, so the caller can tell that the Enter that just came followed Ctrl+Z.
 */
function watchCtrlZ(setup: ReaderSetup, rl: Interface) {
  let pressed = false;
  const onKeypress = (_text: string | undefined, key: KeyPress | undefined): void => {
    if (key?.ctrl === true && key.name === "z") {
      pressed = true;
    } else if (key?.name !== "return" && key?.name !== "enter") {
      pressed = false;
    }
  };
  if (setup.ctrlZEnds) {
    // A listener keeps Node from suspending the program on Ctrl+Z (a non-Windows habit).
    rl.on("SIGTSTP", () => undefined);
    setup.input.on("keypress", onKeypress);
  }
  return {
    pressed: () => pressed,
    stop: () => {
      setup.input.off("keypress", onKeypress);
    },
  };
}

/** Writes a line above the one the person is typing. The typed text and the prompt stay. */
function showAboveInput(setup: ReaderSetup, text: string): void {
  const { output, active, terminal } = setup;
  if (active === undefined) {
    output.write(`${text}\n`);
    return;
  }
  if (terminal) {
    clearLine(output, 0);
    cursorTo(output, 0);
  } else {
    output.write("\n");
  }
  output.write(`${text}\n`);
  active.prompt(true);
}

/** Reads the lines of one reply with a new line reader, and closes it at the end. */
function readOneReply(setup: ReaderSetup, signal: AbortSignal): Promise<ReadResult> {
  const { input, output, terminal } = setup;
  return new Promise<ReadResult>((resolve) => {
    const lines: string[] = [];
    const rl = createInterface({ input, output, terminal, prompt: "> " });
    setup.active = rl;
    const ctrlZ = watchCtrlZ(setup, rl);
    let settled = false;
    const finish = (result: ReadResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      ctrlZ.stop();
      setup.active = undefined;
      rl.close();
      // The last "> " prompt has no line break. End the line so later text starts on a new one.
      output.write("\n");
      resolve(result);
    };
    const finishWithLines = (): void =>
      finish({ kind: "reply", text: lines.join("\n"), gotInput: lines.length > 0 });
    const onAbort = (): void => finish({ kind: "interrupted" });
    signal.addEventListener("abort", onAbort, { once: true });
    rl.on("line", (line) => {
      if (ctrlZ.pressed()) {
        // Ctrl+Z then Enter ends the input. Text typed before Ctrl+Z on this line is kept.
        if (line !== "") {
          lines.push(line);
        }
        finishWithLines();
        return;
      }
      lines.push(line);
      rl.prompt();
    });
    rl.on("SIGINT", onAbort);
    rl.on("close", finishWithLines);
    rl.prompt();
  });
}

/** Asks one question with a new line reader and reads the one line that answers it. */
function readOneLine(setup: ReaderSetup, prompt: string, signal: AbortSignal): Promise<LineResult> {
  const { input, output, terminal } = setup;
  return new Promise<LineResult>((resolve) => {
    const rl = createInterface({ input, output, terminal, prompt });
    setup.active = rl;
    const ctrlZ = watchCtrlZ(setup, rl);
    let settled = false;
    const finish = (result: LineResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      ctrlZ.stop();
      setup.active = undefined;
      rl.close();
      // A terminal shows the answer and its line break. Otherwise the question has none.
      if (result.kind !== "line" || !terminal) {
        output.write("\n");
      }
      resolve(result);
    };
    const onAbort = (): void => finish({ kind: "interrupted" });
    signal.addEventListener("abort", onAbort, { once: true });
    rl.on("line", (line) =>
      finish(ctrlZ.pressed() ? { kind: "end" } : { kind: "line", text: line }),
    );
    rl.on("SIGINT", onAbort);
    rl.on("close", () => finish({ kind: "end" }));
    rl.prompt();
  });
}

/** Line breaks become \n, and the newlines at the end are removed. */
export function normalizeReply(text: string): string {
  return text.replace(/\r\n|\r/g, "\n").replace(/\n+$/, "");
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** The time a request arrived, as local date and time. */
function formatReceived(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return "unknown";
  }
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * What a look at the lock of the storage directory found: a serve runs, no serve
 * runs, or the directory cannot be read (the reason is a short fixed phrase).
 */
export type ServeStatus =
  | { kind: "running" }
  | { kind: "not-running" }
  | { kind: "unreadable"; detail: string };

export interface AnswerConsoleOptions {
  broker: ExchangeBroker;
  /** Where requests and notices go. */
  screen: Screen;
  /** Where "Error:" lines go. */
  errorScreen: Screen;
  logger: Logger;
  clock: Clock;
  reader: ReplyReader;
  pollIntervalMs: number;
  /** The storage directory, for the sentences about it. */
  storageDir: string;
  /** Looks at the lock of the storage directory once, when the screen starts. */
  checkServe: () => Promise<ServeStatus>;
}

/** What a request that ended while the person was busy tells: the client left, or time ran out. */
type Closed = Extract<Confirmation, { kind: "cancelled" | "timed_out" }>;

type Typed =
  | { kind: "text"; text: string }
  | { kind: "skip" }
  | { kind: "closed"; closed: Closed }
  | { kind: "exit"; code: number };

/** The sentence for how a request ended, or undefined while it still waits. */
function endingLine(result: Confirmation): string | undefined {
  switch (result.kind) {
    case "sent":
      return TEXT.sent;
    case "skipped":
      return TEXT.skipped;
    case "elsewhere":
      return TEXT.notSent;
    case "cancelled":
      return TEXT.cancelled;
    case "timed_out":
      return TEXT.timedOut(result.limitSeconds);
    case "ended":
      return TEXT.ended;
    default:
      return undefined;
  }
}

const NO_REQUESTS: WaitingListing = { waiting: [], unsupported: [] };

export class AnswerConsole {
  private readonly options: AnswerConsoleOptions;
  /** Requests this answer already put a reply on, or lost to another window. */
  private readonly placed = new Set<string>();
  private readonly noticed = new Set<string>();
  /** The ids of the waiting requests the last look saw, to tell the new ones. */
  private seen: ReadonlySet<string> = new Set();
  private waitingShown = false;
  private listFailed = false;

  constructor(options: AnswerConsoleOptions) {
    this.options = options;
  }

  /**
   * Runs until Ctrl+C (the signal aborts) or until the input is closed. Returns the exit code.
   * It ends at once with exit code 1 when no serve runs for the storage directory.
   */
  async run(signal: AbortSignal): Promise<number> {
    if (!(await this.serveIsRunning())) {
      return EXIT.failure;
    }
    const unsubscribe = this.options.broker.subscribe((event) => this.relay(event));
    try {
      return await this.loop(signal);
    } finally {
      unsubscribe();
    }
  }

  /** Checks that a serve is running. A sentence goes to standard error when it fails. */
  private async serveIsRunning(): Promise<boolean> {
    const { checkServe, errorScreen, storageDir } = this.options;
    const status = await checkServe();
    if (status.kind === "unreadable") {
      errorScreen.line(TEXT.cannotRead(storageDir, status.detail));
    } else if (status.kind === "not-running") {
      errorScreen.line(TEXT.serveNotRunning(storageDir));
      errorScreen.line(TEXT.startServe);
    }
    return status.kind === "running";
  }

  private async loop(signal: AbortSignal): Promise<number> {
    while (!signal.aborted) {
      const listing = (await this.list()) ?? NO_REQUESTS;
      this.noticeUnsupported(listing.unsupported, (text) => this.options.screen.line(text));
      const first = listing.waiting[0];
      if (first === undefined) {
        await this.idle(signal);
        continue;
      }
      this.waitingShown = false;
      const exit = await this.answerOne(first, listing.waiting, signal);
      if (exit !== undefined) {
        return exit;
      }
    }
    return EXIT.interrupted;
  }

  private relay(event: BrokerEvent): void {
    const id = event.id === undefined ? undefined : shortId(event.id);
    if (event.type === "error") {
      this.options.logger.failure(id, event.reason);
    } else if (event.type === "recovered") {
      this.options.logger.recovered(id);
    }
  }

  /** The waiting requests in id order, or undefined when the storage could not be read. */
  private async list(): Promise<WaitingListing | undefined> {
    try {
      const listing = await this.options.broker.listWaiting(this.placed);
      if (this.listFailed) {
        this.listFailed = false;
        this.options.logger.recovered(undefined);
      }
      return listing;
    } catch (error) {
      if (!(error instanceof IoFailure)) {
        throw error;
      }
      this.listFailed = true;
      this.options.logger.failure(undefined, error.reason);
      return undefined;
    }
  }

  /** Tells once for each request this version cannot show. `write` is where the line goes. */
  private noticeUnsupported(ids: readonly string[], write: (text: string) => void): void {
    for (const id of ids) {
      if (!this.noticed.has(id)) {
        this.noticed.add(id);
        write(TEXT.unsupported(id));
      }
    }
  }

  private async idle(signal: AbortSignal): Promise<void> {
    if (!this.waitingShown) {
      this.waitingShown = true;
      this.options.screen.line(TEXT.waiting);
    }
    await this.options.clock.sleep(this.options.pollIntervalMs, signal);
  }

  /** Shows one request and carries it through. Returns an exit code when the program must end. */
  private async answerOne(
    item: WaitingExchange,
    waiting: readonly WaitingExchange[],
    signal: AbortSignal,
  ): Promise<number | undefined> {
    this.show(item, waiting.length);
    this.seen = new Set(waiting.map((other) => other.id));
    const typed = await this.collect(item, signal);
    switch (typed.kind) {
      case "exit":
        return typed.code;
      case "closed":
        this.options.screen.line(endingLine(typed.closed) ?? TEXT.ended);
        return undefined;
      case "skip":
        return this.send(item.id, "", "skip", signal);
      default:
        return this.send(item.id, typed.text, item.request.replyKind, signal);
    }
  }

  private show(item: WaitingExchange, total: number): void {
    const { screen } = this.options;
    const { request } = item;
    const head = `--- Request 1 of ${total} (${shortId(item.id)}) `;
    screen.line(head + "-".repeat(Math.max(3, SEPARATOR_WIDTH - head.length)));
    screen.line(`Received: ${formatReceived(request.receivedAt)}`);
    screen.line(`Model:    ${escapeAllControls(request.model)}`);
    screen.line(`Reply:    ${REPLY_KIND_LABELS[request.replyKind]}`);
    screen.line("");
    const path = this.options.broker.requestFilePath(item.id);
    for (const line of conversationLines(request.conversation, path)) {
      screen.line(line);
    }
    if (request.replyKind === "json") {
      this.showRequiredShape(request.requiredShape);
    }
    screen.line(request.replyKind === "json" ? TEXT.jsonPrompt() : TEXT.prompt());
  }

  /** The shape the client asked for, nested by two spaces, or the note that any JSON will do. */
  private showRequiredShape(shape: Record<string, unknown> | null): void {
    const { screen } = this.options;
    if (shape === null) {
      screen.line(TEXT.anyJson);
    } else {
      screen.line(TEXT.requiredShape);
      for (const line of escapeControls(JSON.stringify(shape, null, 2)).split("\n")) {
        screen.line(`  ${line}`);
      }
    }
    screen.line("");
  }

  /** Reads until there is a reply, or a wish to skip, or until the request or the program ends. */
  private async collect(item: WaitingExchange, signal: AbortSignal): Promise<Typed> {
    for (;;) {
      const typed = await this.typeOnce(item, signal);
      if (typed !== undefined) {
        return typed;
      }
    }
  }

  /** One round of typing. Undefined means the same request asks again. */
  private async typeOnce(item: WaitingExchange, signal: AbortSignal): Promise<Typed | undefined> {
    const { reader, screen } = this.options;
    const read = await this.watched(item.id, signal, (stop) => reader.readReply(stop));
    if ("closed" in read) {
      return { kind: "closed", closed: read.closed };
    }
    if (read.value.kind === "interrupted") {
      return this.quit(item);
    }
    if (!read.value.gotInput) {
      return this.confirmSkip(item, signal);
    }
    const text = normalizeReply(read.value.text);
    if (text === "") {
      screen.line(TEXT.emptyReply);
      return undefined;
    }
    return this.accepts(item.request.replyKind, text) ? { kind: "text", text } : undefined;
  }

  /** Nothing was typed: asks whether to skip. Only y or Y skips. */
  private async confirmSkip(
    item: WaitingExchange,
    signal: AbortSignal,
  ): Promise<Typed | undefined> {
    const { reader, errorScreen } = this.options;
    const asked = await this.watched(item.id, signal, (stop) =>
      reader.readLine(TEXT.skipPrompt, stop),
    );
    if ("closed" in asked) {
      return { kind: "closed", closed: asked.closed };
    }
    const { value } = asked;
    if (value.kind === "interrupted") {
      return this.quit(item);
    }
    if (value.kind === "end") {
      errorScreen.line(TEXT.inputEnded);
      return { kind: "exit", code: EXIT.failure };
    }
    return value.text === "y" || value.text === "Y" ? { kind: "skip" } : undefined;
  }

  private quit(item: WaitingExchange): Typed {
    this.options.screen.line(TEXT.quit(item.id));
    return { kind: "exit", code: EXIT.interrupted };
  }

  /**
   * Runs a read while the request is watched. When the client leaves or
   * the wait limit passes, the read is stopped at once and `closed` tells why.
   */
  private async watched<T>(
    id: string,
    signal: AbortSignal,
    read: (stop: AbortSignal) => Promise<T>,
  ): Promise<{ value: T } | { closed: Closed }> {
    const stop = new AbortController();
    const either = AbortSignal.any([signal, stop.signal]);
    const result: { closed?: Closed } = {};
    const watching = this.watch(id, either, (closed) => {
      result.closed = closed;
      stop.abort();
    });
    try {
      const value = await read(either);
      return result.closed === undefined ? { value } : { closed: result.closed };
    } finally {
      stop.abort();
      await watching;
    }
  }

  /** Looks at the request every poll interval until `signal` aborts or the request is closed. */
  private async watch(
    id: string,
    signal: AbortSignal,
    onClosed: (closed: Closed) => void,
  ): Promise<void> {
    const { clock, pollIntervalMs } = this.options;
    for (;;) {
      await clock.sleep(pollIntervalMs, signal);
      if (signal.aborted) {
        return;
      }
      const state = await this.confirm(id, undefined);
      if (signal.aborted) {
        return;
      }
      if (state.kind === "cancelled" || state.kind === "timed_out") {
        onClosed(state);
        return;
      }
      await this.noticeNewRequests(id, state.kind === "pending", signal);
    }
  }

  /** Tells the count when a request came that the last look had not seen. */
  private async noticeNewRequests(
    shownId: string,
    shownStillWaiting: boolean,
    signal: AbortSignal,
  ): Promise<void> {
    const listing = await this.list();
    if (listing === undefined || signal.aborted) {
      return;
    }
    // A request that cannot be shown is told about only once, so it must not be lost here.
    this.noticeUnsupported(listing.unsupported, (text) => this.options.reader.notify(text));
    const ids = listing.waiting.map((item) => item.id);
    // The listing leaves out a request that already has a reply file, so the shown request is
    // counted here for as long as its state is waiting.
    if (shownStillWaiting && !ids.includes(shownId)) {
      ids.push(shownId);
    }
    const hasNew = ids.some((id) => !this.seen.has(id));
    this.seen = new Set(ids);
    if (hasNew && ids.length > 1) {
      this.options.reader.notify(TEXT.newRequests(ids.length));
    }
  }

  /**
   * The check of the reply before it is placed. A reply that fails is not sent: the
   * reason is shown, and the same request asks again.
   */
  private accepts(kind: ReplyKind, text: string): boolean {
    const check = this.options.broker.checkReply(kind, text);
    if (!check.ok) {
      this.options.screen.line(TEXT.notJson(check.reason));
      this.options.screen.line(TEXT.jsonAgain());
    }
    return check.ok;
  }

  private async send(
    id: string,
    text: string,
    kind: ReplyFileKind,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    const { broker, errorScreen, clock, pollIntervalMs } = this.options;
    let placed: Awaited<ReturnType<ExchangeBroker["placeReply"]>>;
    try {
      placed = await broker.placeReply(id, text, kind);
    } catch (error) {
      if (!(error instanceof IoFailure)) {
        throw error;
      }
      errorScreen.line(TEXT.writeFailed(error.detail));
      await clock.sleep(pollIntervalMs, signal);
      return undefined;
    }
    this.placed.add(id);
    return this.awaitEnding(id, placed.kind === "placed" ? placed.bytes : undefined, signal);
  }

  /**
   * Waits until the request is no longer waiting, then tells how it ended. With
   * no `bytes` this answer placed nothing, so a reply that was used is another window's.
   */
  private async awaitEnding(
    id: string,
    bytes: string | undefined,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    const { screen, clock, pollIntervalMs } = this.options;
    while (!signal.aborted) {
      const line = endingLine(await this.confirm(id, bytes));
      if (line !== undefined) {
        screen.line(line);
        return undefined;
      }
      await clock.sleep(pollIntervalMs, signal);
    }
    return EXIT.interrupted;
  }

  /**
   * One look at the outcome. A state file that cannot be read, or a read that throws, is written
   * once with its fixed reason, and the next poll tries again.
   */
  private async confirm(id: string, bytes: string | undefined): Promise<Confirmation> {
    const { broker, logger } = this.options;
    try {
      const result = await broker.confirmReply(id, bytes);
      if (result.kind === "unreadable") {
        logger.failure(shortId(id), "unreadable");
        return { kind: "pending" };
      }
      logger.recovered(shortId(id));
      return result;
    } catch (error) {
      if (!(error instanceof IoFailure)) {
        throw error;
      }
      logger.failure(shortId(id), error.reason);
      return { kind: "pending" };
    }
  }
}
