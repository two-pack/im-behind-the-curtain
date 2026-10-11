import type { Clock } from "../clock.js";
import { AlreadyExistsError, IoFailure, type IoReason } from "../errors.js";
import { createIdGenerator, type IdGenerator } from "../ids.js";
import {
  type ConversationRequest,
  createReplyFile,
  createRequestFile,
  createStateFile,
  type ReplyFile,
  type ReplyFileKind,
  type ReplyKind,
  type RequestFile,
  type StateFile,
  serializeFile,
} from "../model.js";
import type { ExchangeStorage } from "../store/exchange-store.js";
import { checkReply, type ReplyCheck } from "./reply-check.js";

/** What the broker tells the outside. The log lines are made elsewhere. */
export type BrokerEvent =
  | { type: "replied" | "skipped" | "cancelled" | "timed_out"; id: string }
  /** `id` is missing when the failure is not about one request, such as a failed listing. */
  | { type: "error"; id: string | undefined; reason: IoReason }
  | { type: "recovered"; id: string | undefined };

export type BrokerEventHandler = (event: BrokerEvent) => void;

/**
 * The result of waiting for a request. `cancelled` has no answer to give: the
 * client is gone.
 */
export type ExchangeOutcome =
  | { kind: "replied"; id: string; body: string }
  | { kind: "skipped"; id: string }
  | { kind: "timed_out"; id: string; limitSeconds: number }
  | { kind: "cancelled"; id: string };

export interface Submitted {
  id: string;
  /** Resolves when a reply for this request has been accepted. */
  outcome: Promise<ExchangeOutcome>;
}

export interface WaitingExchange {
  id: string;
  request: RequestFile;
}

export interface WaitingListing {
  /** Requests that wait for a reply, in id order. */
  waiting: WaitingExchange[];
  /** Ids of requests this version cannot show. Each id is returned once. */
  unsupported: string[];
}

export type PlaceResult = { kind: "placed"; bytes: string } | { kind: "too-late" };

/**
 * What a screen learns about the reply it placed. `pending`: the request still
 * waits. `unreadable`: state.json exists but its content cannot be read. `elsewhere`:
 * another reply was used. `ended`: the request ended in a way that has no word of its own.
 */
export type Confirmation =
  | { kind: "pending" | "unreadable" | "sent" | "skipped" | "elsewhere" | "ended" }
  | { kind: "cancelled" }
  | { kind: "timed_out"; limitSeconds: number | undefined };

/** The state, the answer and the leftover work of a request that has just ended. */
interface Ending {
  outcome: ExchangeOutcome;
  state: StateFile;
  /** reply.json is still there and goes away before state.json is written. */
  removeReplyFile: boolean;
  /** The client was told and the log line was written. */
  answered: boolean;
}

export interface BrokerOptions {
  store: ExchangeStorage;
  clock: Clock;
  pollIntervalMs: number;
  /** How long a request may wait for its reply, in seconds. 0 or missing means no limit. */
  waitLimitSeconds?: number;
}

export interface Polling {
  stop(): Promise<void>;
}

/**
 * Owns the life of a request: assigning ids, saving, ending it exactly once (a reply, a skip,
 * a disconnect or the wait limit, whichever comes first), and listing what is waiting. serve and
 * answer both use it, over the same storage files.
 */
export class ExchangeBroker {
  private readonly store: ExchangeStorage;
  private readonly clock: Clock;
  private readonly pollIntervalMs: number;
  private readonly waitLimitSeconds: number;
  private ids: IdGenerator = createIdGenerator();
  private readonly handlers = new Set<BrokerEventHandler>();
  private readonly waiters = new Map<string, (outcome: ExchangeOutcome) => void>();
  /**
   * Requests whose ending has been decided in this run. It is checked and set
   * with no `await` in between, so the first of a reply, a disconnect and the wait limit wins.
   * An entry stays for the whole run, except when the work fails before reply.accepted.json exists.
   */
  private readonly claimed = new Set<string>();
  /** The first disconnect or wait limit that lost to a claim that was later given back. */
  private readonly deferred = new Map<string, "cancelled" | "timed_out">();
  /** Endings whose state.json is not written yet. Each poll tries again. */
  private readonly endings = new Map<string, Ending>();
  /** The timer of the wait limit of each request that waits for a reply. */
  private readonly deadlines = new Map<string, AbortController>();
  private stopped = false;
  /** Requests known to be over (or unusable). They are not read again in this run. */
  private readonly finished = new Set<string>();
  /** Requests whose request.json serve has read once, or wrote itself, in this run. */
  private readonly requestChecked = new Set<string>();
  /** Requests whose last attempt failed. A later success reports a recovery. */
  private readonly failing = new Set<string>();
  /** True while the listing of the storage directory is failing. */
  private listFailing = false;

  constructor(options: BrokerOptions) {
    this.store = options.store;
    this.clock = options.clock;
    this.pollIntervalMs = options.pollIntervalMs;
    this.waitLimitSeconds = options.waitLimitSeconds ?? 0;
  }

  /** Continues ids after the largest id in storage. Call once, before `submit`. */
  async initialize(): Promise<void> {
    this.ids = createIdGenerator({ after: await this.store.maxId() });
  }

  subscribe(handler: BrokerEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /** Assigns an id and saves the request. Fails, with nothing stored, if it cannot be saved. */
  async submit(request: ConversationRequest): Promise<Submitted> {
    const now = this.clock.now();
    const id = this.ids.next(now.getTime());
    const receivedAt = now.toISOString();
    const outcome = new Promise<ExchangeOutcome>((resolve) => {
      this.waiters.set(id, resolve);
    });
    this.watchDeadline(id);
    try {
      await this.store.createRequest(
        createRequestFile(id, receivedAt, request),
        createStateFile(id, "waiting", receivedAt, null),
      );
    } catch (error) {
      this.waiters.delete(id);
      this.stopWatching(id);
      this.emit({
        type: "error",
        id,
        reason: error instanceof IoFailure ? error.reason : "failed",
      });
      throw error;
    }
    this.requestChecked.add(id);
    return { id, outcome };
  }

  /**
   * The client of a request went away. The request ends as `cancelled` unless something else
   * ended it first.
   */
  async cancel(id: string): Promise<void> {
    await this.endWithoutReply(id, "cancelled");
  }

  /**
   * Stops everything that is waiting: the timers go, and no client is answered. The files stay
   * `waiting`. A later disconnect of those clients is not a cancel.
   */
  shutdown(): void {
    this.stopped = true;
    for (const deadline of this.deadlines.values()) {
      deadline.abort();
    }
    this.deadlines.clear();
    this.waiters.clear();
  }

  /** Where request.json of a request is: the file that holds the whole conversation. */
  requestFilePath(id: string): string {
    return this.store.requestFilePath(id);
  }

  /** Looks at every request that is still waiting and accepts the replies that arrived. */
  async pollOnce(): Promise<void> {
    if (this.stopped) {
      return;
    }
    let ids: string[];
    try {
      ids = await this.store.listIds();
    } catch (error) {
      this.listFailing = true;
      this.report(undefined, error);
      return;
    }
    if (this.stopped) {
      return;
    }
    if (this.listFailing) {
      this.listFailing = false;
      this.emit({ type: "recovered", id: undefined });
    }
    for (const id of ids) {
      if (this.stopped) {
        return;
      }
      if (this.finished.has(id)) {
        continue;
      }
      await this.attempt(id, () => this.serveOne(id));
    }
  }

  /**
   * Polls again 500 milliseconds after the previous poll ended, so polls never overlap and
   * a slow poll does not pile up work. Failures of the files are handled inside a poll. An
   * exception that escapes ends the loop and is passed to `onFailure`.
   */
  startPolling(onFailure: (error: unknown) => void): Polling {
    const controller = new AbortController();
    const running = (async () => {
      try {
        while (!controller.signal.aborted) {
          await this.pollOnce();
          await this.clock.sleep(this.pollIntervalMs, controller.signal);
        }
      } catch (error) {
        onFailure(error);
      }
    })();
    return {
      stop: async () => {
        controller.abort();
        await running;
      },
    };
  }

  /** The requests an answer can show: waiting, with no reply file yet, not in `skip`. */
  async listWaiting(skip: ReadonlySet<string>): Promise<WaitingListing> {
    const listing: WaitingListing = { waiting: [], unsupported: [] };
    for (const id of await this.store.listIds()) {
      if (this.finished.has(id) || skip.has(id)) {
        continue;
      }
      await this.attempt(id, () => this.inspectForAnswer(id, listing));
    }
    return listing;
  }

  /**
   * The one check of a reply before it is placed. The answer screen calls it, and
   * so does the later unit that checks hand-written replies.
   */
  checkReply(kind: ReplyKind, body: string): ReplyCheck {
    return checkReply(kind, body);
  }

  /**
   * Places this answer's reply. `too-late` means the request is no longer waiting or another
   * reply came first. An input/output failure is thrown for the caller to show.
   */
  async placeReply(id: string, body: string, kind: ReplyFileKind = "text"): Promise<PlaceResult> {
    const state = await this.store.readState(id);
    if (state.kind !== "ok" || state.value.state !== "waiting") {
      return { kind: "too-late" };
    }
    const files = await this.store.listFiles(id);
    if (files.has("reply.json") || files.has("reply.accepted.json")) {
      return { kind: "too-late" };
    }
    const bytes = serializeFile(createReplyFile(body, this.clock.now().toISOString(), kind));
    try {
      await this.store.placeReply(id, bytes);
    } catch (error) {
      if (error instanceof AlreadyExistsError) {
        return { kind: "too-late" };
      }
      throw error;
    }
    return { kind: "placed", bytes };
  }

  /**
   * How the request ended, for a screen that placed `bytes` (or nothing, when `bytes` is
   * undefined).
   */
  async confirmReply(id: string, bytes: string | undefined): Promise<Confirmation> {
    const state = await this.store.readState(id);
    if (state.kind === "unreadable") {
      return { kind: "unreadable" };
    }
    if (state.kind !== "ok" || state.value.state === "waiting") {
      return { kind: "pending" };
    }
    switch (state.value.state) {
      case "replied":
      case "skipped":
        return this.whoseReply(id, state.value.state, bytes);
      case "cancelled":
        return { kind: "cancelled" };
      case "timed_out":
        return { kind: "timed_out", limitSeconds: limitFromReason(state.value.endReason) };
      default:
        return { kind: "ended" };
    }
  }

  private async whoseReply(
    id: string,
    state: "replied" | "skipped",
    bytes: string | undefined,
  ): Promise<Confirmation> {
    if (bytes === undefined) {
      return { kind: "elsewhere" };
    }
    const accepted = await this.store.readReply(id, "reply.accepted.json");
    if (accepted?.bytes !== bytes) {
      return { kind: "elsewhere" };
    }
    return { kind: state === "replied" ? "sent" : "skipped" };
  }

  private emit(event: BrokerEvent): void {
    for (const handler of this.handlers) {
      handler(event);
    }
  }

  private report(id: string | undefined, error: unknown): void {
    if (id !== undefined) {
      this.failing.add(id);
    }
    this.emit({ type: "error", id, reason: error instanceof IoFailure ? error.reason : "failed" });
  }

  /** Runs the work for one request. A failure is reported and left for the next poll. */
  private async attempt<T>(id: string, work: () => Promise<T>): Promise<T | undefined> {
    try {
      const result = await work();
      if (this.failing.delete(id)) {
        this.emit({ type: "recovered", id });
      }
      return result;
    } catch (error) {
      this.report(id, error);
      return undefined;
    }
  }

  /**
   * A file of this request has content that cannot be read. The request is left as
   * it is: nothing is changed or removed, it is not read again in this run, and the problem is
   * reported once.
   */
  private markUnreadable(id: string): void {
    this.finished.add(id);
    this.emit({ type: "error", id, reason: "unreadable" });
  }

  private async serveOne(id: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    const ending = this.endings.get(id);
    if (ending !== undefined) {
      await this.finish(id, ending);
      return;
    }
    if (this.claimed.has(id)) {
      return;
    }
    const state = await this.store.readState(id);
    if (state.kind === "missing") {
      return;
    }
    if (state.kind === "unreadable") {
      this.markUnreadable(id);
      return;
    }
    if (state.kind !== "ok" || state.value.state !== "waiting") {
      this.finished.add(id);
      return;
    }
    if (await this.requestIsReadable(id)) {
      await this.receive(id);
    }
  }

  /** Reads request.json once for a request that serve did not save itself. */
  private async requestIsReadable(id: string): Promise<boolean> {
    if (this.requestChecked.has(id)) {
      return true;
    }
    const request = await this.store.readRequest(id);
    if (request.kind === "unreadable") {
      this.markUnreadable(id);
      return false;
    }
    this.requestChecked.add(id);
    return true;
  }

  /**
   * Accepting a reply, in the order of the table in the reliability design: link
   * reply.accepted.json, remove reply.json, then write state.json. The reply is read and checked
   * before the request is claimed, so a reply file that cannot be used never holds a claim.
   */
  private async receive(id: string): Promise<void> {
    if (this.stopped || this.claimed.has(id)) {
      return;
    }
    const files = await this.store.listFiles(id);
    const hasAccepted = files.has("reply.accepted.json");
    if (!hasAccepted && !files.has("reply.json")) {
      return;
    }
    const reply = await this.usableReply(id, hasAccepted);
    // After shutdown nothing is claimed, linked or written. The check comes right
    // before the claim and again before each later step, because every await can let it happen.
    if (this.stopped || reply === undefined || !this.claim(id)) {
      return;
    }
    if (!hasAccepted) {
      await this.linkAccepted(id);
    }
    await this.finish(
      id,
      replyEnding(id, reply, this.clock.now().toISOString(), files.has("reply.json")),
    );
  }

  /**
   * The reply that ends the request: the accepted one if there is one, else reply.json. Only a
   * version 1 reply of a kind this version knows is used. An accepted reply that cannot be read
   * is reported once.
   */
  private async usableReply(id: string, hasAccepted: boolean): Promise<ReplyFile | undefined> {
    const stored = await this.store.readReply(
      id,
      hasAccepted ? "reply.accepted.json" : "reply.json",
    );
    if (stored?.parsed.kind === "unreadable" && hasAccepted) {
      this.markUnreadable(id);
    }
    return stored?.parsed.kind === "ok" ? stored.parsed.value : undefined;
  }

  /** Decides the ending of a request. False when something else decided it first. */
  private claim(id: string): boolean {
    if (this.claimed.has(id)) {
      return false;
    }
    this.claimed.add(id);
    return true;
  }

  /**
   * Gives a claim back because the work failed before reply.accepted.json existed. A
   * disconnect or wait limit that lost to this claim is applied now.
   */
  private release(id: string): void {
    this.claimed.delete(id);
    const waiting = this.deferred.get(id);
    this.deferred.delete(id);
    if (waiting !== undefined) {
      void this.endWithoutReply(id, waiting);
    }
  }

  /** Ends a request that has no reply: the client left, or the wait limit passed. */
  private async endWithoutReply(id: string, kind: "cancelled" | "timed_out"): Promise<void> {
    if (!this.waiters.has(id)) {
      return;
    }
    if (!this.claim(id)) {
      if (!this.deferred.has(id)) {
        this.deferred.set(id, kind);
      }
      return;
    }
    const now = this.clock.now().toISOString();
    const limitSeconds = this.waitLimitSeconds;
    const ending: Ending =
      kind === "cancelled"
        ? {
            outcome: { kind, id },
            state: createStateFile(id, kind, now, now, "client disconnected"),
            removeReplyFile: false,
            answered: false,
          }
        : {
            outcome: { kind, id, limitSeconds },
            state: createStateFile(
              id,
              kind,
              now,
              now,
              `wait limit of ${limitSeconds} seconds reached`,
            ),
            removeReplyFile: false,
            answered: false,
          };
    try {
      await this.finish(id, ending);
    } catch (error) {
      this.report(id, error);
    }
  }

  /**
   * Does what is left of an ending: removes reply.json if it is still there, then writes
   * state.json in one write. The client is answered at the first try, even when the write fails.
   * A failure is thrown, and the next poll tries again.
   */
  private async finish(id: string, ending: Ending): Promise<void> {
    if (this.stopped) {
      return;
    }
    try {
      if (ending.removeReplyFile) {
        await this.store.removeReply(id);
        ending.removeReplyFile = false;
      }
      await this.store.writeState(ending.state);
    } catch (error) {
      this.endings.set(id, ending);
      this.answer(id, ending);
      throw error;
    }
    this.endings.delete(id);
    this.answer(id, ending);
    this.finished.add(id);
    this.deferred.delete(id);
  }

  /** Tells the log and the client how the request ended, once, and clears what it left. */
  private answer(id: string, ending: Ending): void {
    if (ending.answered) {
      return;
    }
    ending.answered = true;
    this.stopWatching(id);
    this.emit({ type: ending.outcome.kind, id });
    const resolve = this.waiters.get(id);
    if (resolve !== undefined) {
      this.waiters.delete(id);
      resolve(ending.outcome);
    }
  }

  /**
   * Puts the timer of the wait limit on a request, counted from the time it arrived. There is
   * no timer when the limit is 0.
   */
  private watchDeadline(id: string): void {
    const limitMs = this.waitLimitSeconds * 1000;
    if (limitMs === 0 || this.stopped) {
      return;
    }
    const controller = new AbortController();
    this.deadlines.set(id, controller);
    void this.clock.sleep(limitMs, controller.signal).then(() => {
      if (!controller.signal.aborted) {
        void this.endWithoutReply(id, "timed_out");
      }
    });
  }

  private stopWatching(id: string): void {
    this.deadlines.get(id)?.abort();
    this.deadlines.delete(id);
  }

  /**
   * Step one of accepting: reply.accepted.json is linked to reply.json. When that fails, nothing
   * is decided yet, so the claim is given back before the failure goes on.
   */
  private async linkAccepted(id: string): Promise<void> {
    try {
      await this.store.acceptReply(id);
    } catch (error) {
      if (!(error instanceof AlreadyExistsError)) {
        this.release(id);
        throw error;
      }
    }
  }

  private async inspectForAnswer(id: string, listing: WaitingListing): Promise<void> {
    const state = await this.store.readState(id);
    if (state.kind === "missing") {
      return;
    }
    if (state.kind === "unreadable") {
      this.markUnreadable(id);
      return;
    }
    if (state.kind !== "ok" || state.value.state !== "waiting") {
      this.finished.add(id);
      return;
    }
    const files = await this.store.listFiles(id);
    if (files.has("reply.json") || files.has("reply.accepted.json")) {
      return;
    }
    const request = await this.store.readRequest(id);
    if (request.kind === "ok") {
      listing.waiting.push({ id, request: request.value });
    } else if (request.kind === "unsupported") {
      this.finished.add(id);
      listing.unsupported.push(id);
    } else if (request.kind === "unreadable") {
      this.markUnreadable(id);
    }
  }
}

/** The ending for a reply: replied with its text, or skipped. */
function replyEnding(id: string, reply: ReplyFile, now: string, removeReplyFile: boolean): Ending {
  const skipped = reply.kind === "skip";
  return {
    outcome: skipped ? { kind: "skipped", id } : { kind: "replied", id, body: reply.body },
    state: skipped
      ? createStateFile(id, "skipped", now, now, "skipped by the human")
      : createStateFile(id, "replied", now, now),
    removeReplyFile,
    answered: false,
  };
}

/** The wait limit in seconds that a `timed_out` end reason names, if it can be read. */
function limitFromReason(reason: string | null): number | undefined {
  const match = /^wait limit of (\d+) seconds reached$/.exec(reason ?? "");
  return match === null ? undefined : Number(match[1]);
}
