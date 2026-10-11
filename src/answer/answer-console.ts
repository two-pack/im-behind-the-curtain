/**
 * The screen of `imbehind answer`: shows the oldest waiting request, reads the person's
 * reply, places it, and tells whether it was used.
 */
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { BrokerEvent, ExchangeBroker, WaitingExchange } from "../broker/exchange-broker.js";
import type { Clock } from "../clock.js";
import { EXIT, IoFailure } from "../errors.js";
import { shortId } from "../ids.js";
import type { Logger, Screen } from "../log.js";
import type { ReplyKind, Role } from "../model.js";
import { endOfInputHint } from "../platform.js";

/** Every sentence the screen shows, in one place. */
const TEXT = {
  waiting: "Waiting for requests... (press Ctrl+C to quit)",
  emptyReply: "The reply is empty. Type a reply, or press Ctrl+C to quit.",
  sent: "Sent.",
  notSent: "Not sent: this request was already answered in another window.",
  inputClosed: "Error: input closed.",
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
} as const;

/** The word shown after "Reply:" for each kind of reply. */
const REPLY_KIND_LABELS: Readonly<Record<ReplyKind, string>> = { text: "text", json: "JSON" };

const ROLE_LABELS: Readonly<Record<Role, string>> = {
  system: "System",
  developer: "Developer",
  user: "User",
  assistant: "Assistant",
};

/** Total width of the line above each request. */
const SEPARATOR_WIDTH = 60;

export type ReadResult =
  | { kind: "reply"; text: string; gotInput: boolean }
  | { kind: "interrupted" };

/** Reads one reply: the lines the person types, until they end the input. */
export interface ReplyReader {
  readReply(signal: AbortSignal): Promise<ReadResult>;
}

/**
 * A reader that opens a fresh line reader for every reply, so that ending one reply with
 * the end-of-input key does not stop the next one. Standard input that has already ended
 * gives an empty reply at once.
 */
export function createReplyReader(
  input: Readable,
  output: Writable,
  terminal: boolean,
  options: ReplyReaderOptions = {},
): ReplyReader {
  const reader = { input, output, terminal, ctrlZEnds: options.ctrlZEnds === true };
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
}

interface KeyPress {
  ctrl?: boolean;
  name?: string;
}

/** Reads the lines of one reply with a new line reader, and closes it at the end. */
function readOneReply(setup: ReaderSetup, signal: AbortSignal): Promise<ReadResult> {
  const { input, output, terminal, ctrlZEnds } = setup;
  return new Promise<ReadResult>((resolve) => {
    const lines: string[] = [];
    const rl = createInterface({ input, output, terminal, prompt: "> " });
    let settled = false;
    let ctrlZPressed = false;
    const finish = (result: ReadResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      input.off("keypress", onKeypress);
      rl.close();
      // The last "> " prompt has no line break. End the line so later text starts on a new one.
      output.write("\n");
      resolve(result);
    };
    const finishWithLines = (): void =>
      finish({ kind: "reply", text: lines.join("\n"), gotInput: lines.length > 0 });
    const onAbort = (): void => finish({ kind: "interrupted" });
    const onKeypress = (_text: string | undefined, key: KeyPress | undefined): void => {
      if (key?.ctrl === true && key.name === "z") {
        ctrlZPressed = true;
      } else if (key?.name !== "return" && key?.name !== "enter") {
        ctrlZPressed = false;
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    rl.on("line", (line) => {
      if (ctrlZPressed) {
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
    if (ctrlZEnds) {
      // A listener keeps Node from suspending the program on Ctrl+Z (a non-Windows habit).
      rl.on("SIGTSTP", () => undefined);
      input.on("keypress", onKeypress);
    }
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

/** The lines of one message, indented by two spaces. */
function indented(content: string): string[] {
  if (content === "") {
    return ["  (empty)"];
  }
  return content.split(/\r\n|\r|\n/).map((line) => (line === "" ? "" : `  ${line}`));
}

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
}

type Typed = { kind: "text"; text: string } | { kind: "exit"; code: number };

export class AnswerConsole {
  private readonly options: AnswerConsoleOptions;
  /** Requests this answer already put a reply on, or lost to another window. */
  private readonly placed = new Set<string>();
  private readonly noticed = new Set<string>();
  private waitingShown = false;
  private listFailed = false;
  /** How many times in a row the input ended without any text. */
  private emptyStreak = 0;

  constructor(options: AnswerConsoleOptions) {
    this.options = options;
  }

  /** Runs until Ctrl+C (the signal aborts) or until the input is closed. Returns the exit code. */
  async run(signal: AbortSignal): Promise<number> {
    const unsubscribe = this.options.broker.subscribe((event) => this.relay(event));
    try {
      return await this.loop(signal);
    } finally {
      unsubscribe();
    }
  }

  private async loop(signal: AbortSignal): Promise<number> {
    while (!signal.aborted) {
      const listing = await this.list();
      this.noticeUnsupported(listing.unsupported);
      const first = listing.waiting[0];
      if (first === undefined) {
        await this.idle(signal);
        continue;
      }
      this.waitingShown = false;
      const exit = await this.answerOne(first, listing.waiting.length, signal);
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

  private async list() {
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
      return { waiting: [], unsupported: [] };
    }
  }

  private noticeUnsupported(ids: readonly string[]): void {
    for (const id of ids) {
      if (!this.noticed.has(id)) {
        this.noticed.add(id);
        this.options.screen.line(TEXT.unsupported(id));
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
    total: number,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    this.show(item, total);
    const typed = await this.collect(item, signal);
    if (typed.kind === "exit") {
      return typed.code;
    }
    return this.send(item.id, typed.text, item.request.replyKind, signal);
  }

  private show(item: WaitingExchange, total: number): void {
    const { screen } = this.options;
    const { request } = item;
    const head = `--- Request 1 of ${total} (${shortId(item.id)}) `;
    screen.line(head + "-".repeat(Math.max(3, SEPARATOR_WIDTH - head.length)));
    screen.line(`Received: ${formatReceived(request.receivedAt)}`);
    screen.line(`Model:    ${request.model}`);
    screen.line(`Reply:    ${REPLY_KIND_LABELS[request.replyKind]}`);
    screen.line("");
    for (const message of request.conversation) {
      screen.line(`${ROLE_LABELS[message.role]}:`);
      for (const line of indented(message.content)) {
        screen.line(line);
      }
      screen.line("");
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
      for (const line of JSON.stringify(shape, null, 2).split("\n")) {
        screen.line(`  ${line}`);
      }
    }
    screen.line("");
  }

  /** Reads until there is a reply that is not empty, or until the program must end. */
  private async collect(item: WaitingExchange, signal: AbortSignal): Promise<Typed> {
    for (;;) {
      const read = await this.options.reader.readReply(signal);
      if (read.kind === "interrupted") {
        this.options.screen.line(TEXT.quit(item.id));
        return { kind: "exit", code: EXIT.interrupted };
      }
      this.emptyStreak = read.gotInput ? 0 : this.emptyStreak + 1;
      if (this.emptyStreak >= 2) {
        this.options.errorScreen.line(TEXT.inputClosed);
        return { kind: "exit", code: EXIT.failure };
      }
      const text = normalizeReply(read.text);
      if (text === "") {
        this.options.screen.line(TEXT.emptyReply);
      } else {
        this.emptyStreak = 0;
        if (this.accepts(item.request.replyKind, text)) {
          return { kind: "text", text };
        }
      }
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
    kind: ReplyKind,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    const { broker, screen, errorScreen, clock, pollIntervalMs } = this.options;
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
    if (placed.kind === "too-late") {
      screen.line(TEXT.notSent);
      return undefined;
    }
    return this.awaitConfirmation(id, placed.bytes, signal);
  }

  /** Waits until serve has accepted a reply, then tells whether it was this answer's reply. */
  private async awaitConfirmation(
    id: string,
    bytes: string,
    signal: AbortSignal,
  ): Promise<number | undefined> {
    const { screen, clock, pollIntervalMs } = this.options;
    while (!signal.aborted) {
      const result = await this.confirm(id, bytes);
      if (result === "confirmed") {
        screen.line(TEXT.sent);
        return undefined;
      }
      if (result === "not-ours") {
        screen.line(TEXT.notSent);
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
  private async confirm(id: string, bytes: string) {
    const { broker, logger } = this.options;
    try {
      const result = await broker.confirmReply(id, bytes);
      if (result === "unreadable") {
        logger.failure(shortId(id), "unreadable");
        return "pending" as const;
      }
      logger.recovered(shortId(id));
      return result;
    } catch (error) {
      if (!(error instanceof IoFailure)) {
        throw error;
      }
      logger.failure(shortId(id), error.reason);
      return "pending" as const;
    }
  }
}
