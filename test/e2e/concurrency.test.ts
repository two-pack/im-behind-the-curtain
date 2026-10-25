import { describe, expect, it } from "vitest";
import { ExchangeBroker } from "../../src/broker/exchange-broker.js";
import { systemClock } from "../../src/clock.js";
import { createIdGenerator } from "../../src/ids.js";
import { type ConversationRequest, createRequestFile, createStateFile } from "../../src/model.js";
import { ExchangeStore } from "../../src/store/exchange-store.js";
import { makeTempDir } from "../helpers/fs.js";
import { answerEverything, postChat, startServe } from "../helpers/system.js";

const NOW = "2026-10-09T14:05:12.000Z";

function conversation(content: string): ConversationRequest {
  return {
    format: "chat.completions",
    model: "m",
    replyKind: "text",
    requiredShape: null,
    stream: false,
    includeUsage: false,
    conversation: [{ role: "user", content }],
    originalRequest: { model: "m" },
  };
}

describe("ten requests at the same time (NFR8)", () => {
  it("returns every client its own answer, with distinct ascending ids", async () => {
    const serve = await startServe();
    const questions = Array.from({ length: 10 }, (_, index) => `question ${index}`);
    const pending = questions.map((question) => postChat(serve.baseUrl, question));
    const answering = answerEverything(serve.storageDir, 10);

    const replies = await Promise.all(pending);
    await answering;

    replies.forEach((reply, index) => {
      expect(reply.status).toBe(200);
      const choices = reply.body.choices as { message: { content: string } }[];
      expect(choices[0]?.message.content).toBe(`answer to question ${index}`);
    });
    const ids = replies.map((reply) => String(reply.body.id));
    expect(new Set(ids).size).toBe(10);

    const stored = await new ExchangeStore({ rootDir: serve.storageDir }).listIds();
    expect(stored).toHaveLength(10);
    expect(ids.map((id) => id.replace("chatcmpl-", "")).sort()).toEqual(stored);
  });
});

// These tests check what the listing finds, not how long it takes: a time limit here made the
// tests fail on slow CI runners without saying anything about the behavior.
describe("listing many requests (NFR8)", () => {
  async function fill(store: ExchangeStore, count: number, state: "waiting" | "replied") {
    const ids = createIdGenerator();
    const start = Date.UTC(2026, 0, 1);
    const all = Array.from({ length: count }, (_, index) => ids.next(start + index));
    for (let offset = 0; offset < all.length; offset += 50) {
      await Promise.all(
        all
          .slice(offset, offset + 50)
          .map((id) =>
            store.createRequest(
              createRequestFile(id, NOW, conversation(`q ${id}`)),
              createStateFile(id, state, NOW, state === "replied" ? NOW : null),
            ),
          ),
      );
    }
  }

  it("lists ten waiting requests (NFR8)", async () => {
    const root = await makeTempDir();
    const store = new ExchangeStore({ rootDir: root });
    await store.prepare();
    await fill(store, 10, "waiting");
    const broker = new ExchangeBroker({ store, clock: systemClock, pollIntervalMs: 500 });
    const listing = await broker.listWaiting(new Set());
    expect(listing.waiting).toHaveLength(10);
  });

  // Creating 1000 requests takes a while on a slow machine, so this test keeps a long timeout.
  it("lists 1000 finished requests as none waiting, three times over (NFR8)", async () => {
    const root = await makeTempDir();
    const store = new ExchangeStore({ rootDir: root });
    await store.prepare();
    await fill(store, 1000, "replied");
    const broker = new ExchangeBroker({ store, clock: systemClock, pollIntervalMs: 500 });

    for (let pass = 0; pass < 3; pass += 1) {
      const listing = await broker.listWaiting(new Set());
      expect(listing.waiting, `pass ${pass}`).toEqual([]);
      expect(listing.unsupported, `pass ${pass}`).toEqual([]);
    }
  }, 120_000);
});
