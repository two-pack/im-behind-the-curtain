/**
 * Deletes old requests: a finished request whose retention has passed is
 * removed with its folder. The sweeper decides which ones and when. The broker reads and removes.
 *
 * It never deletes a waiting request, one it cannot read, or one in a state it does not know. A
 * folder with a file that this server did not make is kept as it is. The only hidden names it may
 * remove are the hidden files of the form `.<kind>.<pid>.<seq>.<hex>.tmp` that a stopped write
 * leaves, such as `.reply.accepted.<pid>.<seq>.<hex>.tmp`; the
 * store decides that. Entries of requests/ that are not real directories, such as symbolic
 * links, are not listed by the store, so they are neither followed nor deleted.
 */
import type { ExchangeBroker } from "../broker/exchange-broker.js";
import type { Clock } from "../clock.js";
import { IoFailure, type IoReason } from "../errors.js";

/** The part of the broker that the sweeper uses. */
type SweepBroker = Pick<ExchangeBroker, "listRequestIds" | "finishedAt" | "removeRequest">;

export interface SweeperOptions {
  broker: SweepBroker;
  clock: Clock;
  /** How long a finished request is kept, in seconds. 0 means never delete. */
  retentionSeconds: number;
  /** The time from the end of one pass to the start of the next, in seconds. */
  intervalSeconds: number;
  /**
   * Called with the id (or none, for the listing) and a fixed reason when a request is kept, or
   * could not be read or deleted. A problem is passed on once for each request and reason, until
   * the request is read or deleted well; then a failure that comes back is passed on again.
   * "kept unknown files" is passed on once for each request in a run.
   */
  onProblem: (id: string | undefined, reason: IoReason) => void;
}

export interface Sweeping {
  /** Ends the loop, and waits until the delete in progress (one request) is done. */
  stop(): Promise<void>;
}

export class Sweeper {
  private readonly options: SweeperOptions;
  private running: Promise<void> | undefined;
  private stopping = false;
  /** The problems already passed on, as "id|reason". */
  private readonly reported = new Set<string>();

  constructor(options: SweeperOptions) {
    this.options = options;
  }

  /**
   * One pass over the request folders. A pass that is already running is not joined by a second
   * one: the call waits for it and returns. With retention 0 nothing is done
   *.
   */
  sweepOnce(): Promise<void> {
    if (this.options.retentionSeconds === 0) {
      return Promise.resolve();
    }
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /**
   * Starts the first pass at once, without waiting for it, and then a pass every interval after
   * the previous one ended. With retention 0 there is no pass and no timer. An
   * exception that escapes ends the loop and is passed to `onFailure`.
   */
  start(onFailure: (error: unknown) => void): Sweeping {
    if (this.options.retentionSeconds === 0) {
      return { stop: () => Promise.resolve() };
    }
    const controller = new AbortController();
    const loop = this.loop(controller.signal, onFailure);
    return {
      stop: async () => {
        this.stopping = true;
        controller.abort();
        await loop;
      },
    };
  }

  private async loop(signal: AbortSignal, onFailure: (error: unknown) => void): Promise<void> {
    const { clock, intervalSeconds } = this.options;
    try {
      while (!signal.aborted) {
        await this.sweepOnce();
        await clock.sleep(intervalSeconds * 1000, signal);
      }
    } catch (error) {
      onFailure(error);
    }
  }

  private async pass(): Promise<void> {
    let ids: string[];
    try {
      ids = await this.options.broker.listRequestIds();
    } catch (error) {
      this.problem(undefined, error);
      return;
    }
    this.reported.delete(key(undefined, "read failed"));
    for (const id of ids) {
      if (this.stopping) {
        return;
      }
      await this.sweepOne(id);
    }
  }

  private async sweepOne(id: string): Promise<void> {
    try {
      await this.sweepChecked(id);
    } catch (error) {
      this.problem(id, error);
      return;
    }
    this.forgetFailures(id);
  }

  /** Reads one request and removes it when it is due. A failure is thrown. */
  private async sweepChecked(id: string): Promise<void> {
    const { broker, clock, retentionSeconds } = this.options;
    const endedAt = await broker.finishedAt(id);
    if (endedAt === undefined || endedAt + retentionSeconds * 1000 > clock.now().getTime()) {
      return;
    }
    if ((await broker.removeRequest(id)) === "kept") {
      this.report(id, "kept unknown files");
    }
  }

  /**
   * The request was read, and deleted if it was due, without a failure. The notes
   * that its failures were passed on are dropped, so a failure that comes back later is passed on
   * again. "kept unknown files" is not dropped: it is passed on once for each request in a run.
   */
  private forgetFailures(id: string): void {
    for (const marker of this.reported) {
      if (marker.startsWith(`${id}|`) && marker !== key(id, "kept unknown files")) {
        this.reported.delete(marker);
      }
    }
  }

  private problem(id: string | undefined, error: unknown): void {
    this.report(id, error instanceof IoFailure ? error.reason : "failed");
  }

  private report(id: string | undefined, reason: IoReason): void {
    const marker = key(id, reason);
    if (!this.reported.has(marker)) {
      this.reported.add(marker);
      this.options.onProblem(id, reason);
    }
  }
}

function key(id: string | undefined, reason: IoReason): string {
  return `${id ?? "-"}|${reason}`;
}
