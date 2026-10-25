import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type {
  LineResult,
  ReadResult,
  ReplyReader,
  StdinRead,
} from "../../src/answer/answer-console.js";
import { POLL_INTERVAL_MS } from "../../src/config.js";
import { ExchangeStore } from "../../src/store/exchange-store.js";
import { waitFor } from "../helpers/io.js";
import {
  postChat,
  postChatRaw,
  startAnswer,
  startServe,
  waitForRequestId,
} from "../helpers/system.js";
import {
  checkedSpanMs,
  FAST_POLL_MS,
  STARTUP_MARGIN_MS,
  timingLimitMs,
  timingTestTimeoutMs,
} from "../helpers/timing-limit.js";

/** A reader the test controls: it waits until the test types a reply. */
class GatedReader implements ReplyReader {
  private pending: ((result: ReadResult) => void) | undefined;

  get waiting(): boolean {
    return this.pending !== undefined;
  }

  readReply(signal: AbortSignal): Promise<ReadResult> {
    return new Promise((resolve) => {
      this.pending = resolve;
      signal.addEventListener("abort", () => resolve({ kind: "interrupted" }), { once: true });
    });
  }

  async readLine(): Promise<LineResult> {
    return { kind: "end" };
  }

  async readStdin(): Promise<StdinRead> {
    return { kind: "interrupted" };
  }

  notify(): void {}

  type(text: string): void {
    const resolve = this.pending;
    this.pending = undefined;
    resolve?.({ kind: "reply", text, gotInput: true });
  }
}

/** The documented 10 second limit, or twice that on CI, where runners can be slow. */
const LIMIT_MS = timingLimitMs(process.env);
const ROUNDS = 3;

/**
 * The waits of the first test that come one after another: the first "Waiting for requests..."
 * line, then in each round the marker line, the reader waiting, the response and "Sent.".
 */
const ROUND_TRIP_WAITS = 1 + ROUNDS * 4;
/** The waits of the streaming test: the reader waiting and the response. */
const STREAM_WAITS = 2;

/**
 * When the request was stored, as the broker wrote it into request.json. It is called after the
 * answer screen showed the request, so the request is already there and nothing is waited for.
 */
async function receivedAtMs(storageDir: string, index: number): Promise<number> {
  const id = await waitForRequestId(storageDir, index);
  const request = await new ExchangeStore({ rootDir: storageDir }).readRequest(id);
  if (request.kind !== "ok") {
    throw new Error(`request ${id} could not be read: ${request.kind}`);
  }
  return Date.parse(request.value.receivedAt);
}

// These tests use the real clock and the real serve. No fake clock is used.
describe("timing with the real clock (NFR6, NFR7)", () => {
  it(
    "shows a request and returns a reply, each within the limit",
    async () => {
      const serve = await startServe();
      const reader = new GatedReader();
      // The answer screen polls every FAST_POLL_MS here, so the time to show a request is
      // measured without its polling wait. One full POLL_INTERVAL_MS is added back below.
      const answer = startAnswer(serve.storageDir, reader, { pollIntervalMs: FAST_POLL_MS });
      await waitFor(() => answer.stdout().includes("Waiting for requests..."), LIMIT_MS);

      const shown: number[] = [];
      const returned: number[] = [];
      for (let round = 0; round < ROUNDS; round += 1) {
        const marker = `question-${round}`;
        const response = postChat(serve.baseUrl, marker);
        await waitFor(() => answer.stdout().includes(`  ${marker}\n`), LIMIT_MS);
        const shownAt = Date.now();
        shown.push(shownAt - (await receivedAtMs(serve.storageDir, round)));
        expect(answer.stdout()).toContain(`User:\n  ${marker}`);

        await waitFor(() => reader.waiting, LIMIT_MS);
        const typedAt = performance.now();
        reader.type(`answer-${round}`);
        const reply = await response;
        returned.push(performance.now() - typedAt);
        expect(reply.status).toBe(200);
        await waitFor(() => answer.stdout().split("Sent.").length - 1 === round + 1, LIMIT_MS);
      }

      for (const elapsedMs of shown) {
        const span = checkedSpanMs({
          elapsedMs,
          pollingExcluded: true,
          pollIntervalMs: POLL_INTERVAL_MS,
        });
        expect(span).toBeLessThanOrEqual(LIMIT_MS);
      }
      // serve polls for the reply every POLL_INTERVAL_MS, fixed in src/cli.ts, and CliOptions
      // gives the tests no way to change it. So this span includes the polling wait of serve and
      // is compared with the limit as it is, with nothing added.
      for (const elapsedMs of returned) {
        const span = checkedSpanMs({
          elapsedMs,
          pollingExcluded: false,
          pollIntervalMs: POLL_INTERVAL_MS,
        });
        expect(span).toBeLessThanOrEqual(LIMIT_MS);
      }
    },
    timingTestTimeoutMs({
      sequentialWaits: ROUND_TRIP_WAITS,
      limitMs: LIMIT_MS,
      startupMarginMs: STARTUP_MARGIN_MS,
    }),
  );

  it(
    "returns a streamed reply within the limit of the person typing it (NFR7)",
    async () => {
      const serve = await startServe();
      const reader = new GatedReader();
      startAnswer(serve.storageDir, reader, { pollIntervalMs: FAST_POLL_MS });
      const response = postChatRaw(serve.baseUrl, "streamed question", { stream: true });
      await waitFor(() => reader.waiting, LIMIT_MS);
      const typedAt = performance.now();
      reader.type("streamed answer");
      const reply = await response;
      const elapsedMs = performance.now() - typedAt;
      expect(reply.status).toBe(200);
      expect(reply.contentType).toContain("text/event-stream");
      expect(reply.text).toContain("streamed answer");
      expect(reply.text.endsWith("data: [DONE]\n\n")).toBe(true);
      // As in the test above, this span includes the polling wait of serve, which the tests
      // cannot shorten, so it is compared with the limit as it is.
      const span = checkedSpanMs({
        elapsedMs,
        pollingExcluded: false,
        pollIntervalMs: POLL_INTERVAL_MS,
      });
      expect(span).toBeLessThanOrEqual(LIMIT_MS);
    },
    timingTestTimeoutMs({
      sequentialWaits: STREAM_WAITS,
      limitMs: LIMIT_MS,
      startupMarginMs: STARTUP_MARGIN_MS,
    }),
  );
});
