import type { Clock } from "../clock.js";
import { AlreadyExistsError, IoFailure, type IoReason } from "../errors.js";
import { createIdGenerator, type IdGenerator } from "../ids.js";
import {
  type ConversationRequest,
  createReplyFile,
  createRequestFile,
  createStateFile,
  type ReplyKind,
  type RequestFile,
  serializeFile,
} from "../model.js";
import type { ExchangeStorage } from "../store/exchange-store.js";
import { checkReply, type ReplyCheck } from "./reply-check.js";

/** What the broker tells the outside. The log lines are made elsewhere. */
export type BrokerEvent =
  | { type: "replied"; id: string }
  /** `id` is missing when the failure is not about one request, such as a failed listing. */
  | { type: "error"; id: string | undefined; reason: IoReason }
  | { type: "recovered"; id: string | undefined };

export type BrokerEventHandler = (event: BrokerEvent) => void;

/** The result of waiting for a request. Only a reply exists in this version. */
export interface ExchangeOutcome {
  kind: "replied";
  id: string;
  body: string;
}

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

/** `unreadable` means state.json exists but its content cannot be read. */
export type Confirmation = "confirmed" | "not-ours" | "pending" | "unreadable";

export interface BrokerOptions {
  store: ExchangeStorage;
  clock: Clock;
  pollIntervalMs: number;
}

export interface Polling {
  stop(): Promise<void>;
}

/**
 * Owns the life of a request: assigning ids, saving, accepting the first reply exactly once,
 * and listing what is waiting. serve and answer both use it, over the same storage files.
 */
export class ExchangeBroker {
  private readonly store: ExchangeStorage;
  private readonly clock: Clock;
  private readonly pollIntervalMs: number;
  private ids: IdGenerator = createIdGenerator();
  private readonly handlers = new Set<BrokerEventHandler>();
  private readonly waiters = new Map<string, (outcome: ExchangeOutcome) => void>();
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
    try {
      await this.store.createRequest(
        createRequestFile(id, receivedAt, request),
        createStateFile(id, "waiting", receivedAt, null),
      );
    } catch (error) {
      this.waiters.delete(id);
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

  /** Looks at every request that is still waiting and accepts the replies that arrived. */
  async pollOnce(): Promise<void> {
    let ids: string[];
    try {
      ids = await this.store.listIds();
    } catch (error) {
      this.listFailing = true;
      this.report(undefined, error);
      return;
    }
    if (this.listFailing) {
      this.listFailing = false;
      this.emit({ type: "recovered", id: undefined });
    }
    for (const id of ids) {
      if (this.finished.has(id)) {
        continue;
      }
      const body = await this.attempt(id, () => this.serveOne(id));
      if (body !== undefined) {
        this.complete(id, body);
      }
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
  async placeReply(id: string, body: string, kind: ReplyKind = "text"): Promise<PlaceResult> {
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

  /** Whether the reply this answer wrote is the one serve accepted. */
  async confirmReply(id: string, bytes: string): Promise<Confirmation> {
    const state = await this.store.readState(id);
    if (state.kind === "unreadable") {
      return "unreadable";
    }
    if (state.kind !== "ok" || state.value.state === "waiting") {
      return "pending";
    }
    if (state.value.state !== "replied") {
      return "not-ours";
    }
    const accepted = await this.store.readReply(id, "reply.accepted.json");
    return accepted?.bytes === bytes ? "confirmed" : "not-ours";
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

  private complete(id: string, body: string): void {
    this.finished.add(id);
    this.emit({ type: "replied", id });
    const resolve = this.waiters.get(id);
    if (resolve !== undefined) {
      this.waiters.delete(id);
      resolve({ kind: "replied", id, body });
    }
  }

  private async serveOne(id: string): Promise<string | undefined> {
    const state = await this.store.readState(id);
    if (state.kind === "missing") {
      return undefined;
    }
    if (state.kind === "unreadable") {
      this.markUnreadable(id);
      return undefined;
    }
    if (state.kind !== "ok" || state.value.state !== "waiting") {
      this.finished.add(id);
      return undefined;
    }
    if (!(await this.requestIsReadable(id))) {
      return undefined;
    }
    return this.receive(id);
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
   * reply.accepted.json, remove reply.json, then write state.json. Every row of the table
   * is a point where the work can stop and be picked up again by the next poll.
   */
  private async receive(id: string): Promise<string | undefined> {
    const files = await this.store.listFiles(id);
    const hasReply = files.has("reply.json");
    const hasAccepted = files.has("reply.accepted.json");
    if (!hasReply && !hasAccepted) {
      return undefined;
    }
    if (!hasAccepted && !(await this.canAccept(id))) {
      return undefined;
    }
    if (!hasAccepted) {
      await this.linkAccepted(id);
    }
    const accepted = await this.store.readReply(id, "reply.accepted.json");
    if (accepted?.parsed.kind === "unreadable") {
      this.markUnreadable(id);
      return undefined;
    }
    if (accepted === undefined || accepted.parsed.kind !== "ok") {
      return undefined;
    }
    if (hasReply) {
      await this.store.removeReply(id);
    }
    const now = this.clock.now().toISOString();
    await this.store.writeState(createStateFile(id, "replied", now, now));
    return accepted.parsed.value.body;
  }

  /** Only a version 1 reply of a kind this version knows is accepted. */
  private async canAccept(id: string): Promise<boolean> {
    const reply = await this.store.readReply(id, "reply.json");
    return reply?.parsed.kind === "ok";
  }

  private async linkAccepted(id: string): Promise<void> {
    try {
      await this.store.acceptReply(id);
    } catch (error) {
      if (!(error instanceof AlreadyExistsError)) {
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
