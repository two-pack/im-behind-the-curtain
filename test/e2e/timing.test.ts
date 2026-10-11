import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import type { ReadResult, ReplyReader } from "../../src/answer/answer-console.js";
import { waitFor } from "../helpers/io.js";
import { postChat, startAnswer, startServe } from "../helpers/system.js";

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

  type(text: string): void {
    const resolve = this.pending;
    this.pending = undefined;
    resolve?.({ kind: "reply", text, gotInput: true });
  }
}

const LIMIT_MS = 2000;
const ROUNDS = 3;

// These tests use the real clock and the real 500 millisecond polling. No fake clock is used.
describe("timing with the real clock (NFR6.1, NFR7.1)", () => {
  it("shows a request within 2000 ms and returns a reply within 2000 ms", async () => {
    const serve = await startServe();
    const reader = new GatedReader();
    const answer = startAnswer(serve.storageDir, reader);
    await waitFor(() => answer.stdout().includes("Waiting for requests..."));

    const shown: number[] = [];
    const returned: number[] = [];
    for (let round = 0; round < ROUNDS; round += 1) {
      const marker = `question-${round}`;
      const sentAt = performance.now();
      const response = postChat(serve.baseUrl, marker);
      await waitFor(() => answer.stdout().includes(`  ${marker}\n`), LIMIT_MS * 2);
      shown.push(performance.now() - sentAt);
      expect(answer.stdout()).toContain(`User:\n  ${marker}`);

      await waitFor(() => reader.waiting);
      const typedAt = performance.now();
      reader.type(`answer-${round}`);
      const reply = await response;
      returned.push(performance.now() - typedAt);
      expect(reply.status).toBe(200);
      await waitFor(() => answer.stdout().split("Sent.").length - 1 === round + 1, LIMIT_MS * 2);
    }

    for (const elapsed of shown) {
      expect(elapsed).toBeLessThanOrEqual(LIMIT_MS);
    }
    for (const elapsed of returned) {
      expect(elapsed).toBeLessThanOrEqual(LIMIT_MS);
    }
  });
});
