import { describe, expect, it } from "vitest";
import {
  type BrokerEvent,
  ExchangeBroker,
  type ExchangeOutcome,
} from "../src/broker/exchange-broker.js";
import { IoFailure } from "../src/errors.js";
import { isRequestId, requestIdTimeMs } from "../src/ids.js";
import {
  type ConversationRequest,
  createReplyFile,
  createRequestFile,
  createStateFile,
  MAX_FILE_BYTES,
  serializeFile,
} from "../src/model.js";
import { FakeClock, settle } from "./helpers/fake-clock.js";
import { FakeStore } from "./helpers/fake-store.js";

const NOW = "2026-10-09T14:05:12.000Z";

const request: ConversationRequest = {
  format: "chat.completions",
  model: "whatever",
  replyKind: "text",
  requiredShape: null,
  stream: false,
  includeUsage: false,
  conversation: [{ role: "user", content: "Hello" }],
  originalRequest: { model: "whatever" },
};

function replyBytes(body: string): string {
  return serializeFile(createReplyFile(body, NOW));
}

function setup(waitLimitSeconds?: number) {
  const store = new FakeStore();
  const clock = new FakeClock();
  const events: BrokerEvent[] = [];
  const broker = new ExchangeBroker({ store, clock, pollIntervalMs: 500, waitLimitSeconds });
  broker.subscribe((event) => events.push(event));
  return { store, clock, events, broker };
}

async function submitWaiting(broker: ExchangeBroker) {
  const submitted = await broker.submit(request);
  let outcome: ExchangeOutcome | undefined;
  submitted.outcome.then((value) => {
    outcome = value;
  });
  return { id: submitted.id, outcomeOf: () => outcome };
}

function stateOf(store: FakeStore, id: string): string | undefined {
  const state = store.entries.get(id)?.state;
  return typeof state === "object" ? state.state : state;
}

describe("assigning ids and storing requests", () => {
  it("stores the request and a waiting state under a new id", async () => {
    const { store, broker, clock } = setup();
    const { id } = await broker.submit(request);
    expect(isRequestId(id)).toBe(true);
    const entry = store.entries.get(id);
    expect(stateOf(store, id)).toBe("waiting");
    expect(entry?.request).toMatchObject({
      id,
      receivedAt: clock.now().toISOString(),
      model: "whatever",
    });
  });

  it("gives ten requests in the same millisecond different, ascending ids", async () => {
    const { broker } = setup();
    const ids: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      ids.push((await broker.submit(request)).id);
    }
    expect(new Set(ids).size).toBe(10);
    expect([...ids].sort()).toEqual(ids);
  });

  it("continues after the largest id already in storage", async () => {
    const { store, broker, clock } = setup();
    const future = "20300101T000000000Z-ffffff";
    store.entries.set(future, {
      request: createRequestFile(future, NOW, request),
      state: createStateFile(future, "replied", NOW, NOW),
      files: new Map(),
    });
    await broker.initialize();
    const { id } = await broker.submit(request);
    expect(id > future).toBe(true);
    expect(requestIdTimeMs(id)).toBe(requestIdTimeMs(future) + 1);
    expect(clock.now().getTime()).toBeLessThan(requestIdTimeMs(future));
  });

  it("fails without accepting the request when it cannot be stored", async () => {
    const { store, broker, events } = setup();
    store.fail("createRequest");
    await expect(broker.submit(request)).rejects.toBeInstanceOf(IoFailure);
    expect(store.entries.size).toBe(0);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({ type: "error", reason: "write failed" });
    expect(isRequestId((event as { id: string }).id)).toBe(true);
  });
});

describe("accepting a reply", () => {
  it("does nothing while no reply file exists", async () => {
    const { store, broker, events } = setup();
    const { id } = await submitWaiting(broker);
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("waiting");
    expect(events).toEqual([]);
    expect(store.count("acceptReply")).toBe(0);
  });

  it("accepts a reply once: links, removes reply.json, marks replied, answers the waiter", async () => {
    const { store, broker, events, clock } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    await broker.pollOnce();
    await settle();
    const entry = store.entries.get(id);
    expect(entry?.files.has("reply.json")).toBe(false);
    expect(entry?.files.get("reply.accepted.json")).toBe(replyBytes("Hi"));
    expect(entry?.state).toMatchObject({ state: "replied", endedAt: clock.now().toISOString() });
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "Hi" });
    expect(events).toEqual([{ type: "replied", id }]);
  });

  it("uses reply.accepted.json and ignores a later reply.json (both files exist)", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.accepted.json", replyBytes("first"));
    store.putFile(id, "reply.json", replyBytes("second"));
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "first" });
    expect(store.entries.get(id)?.files.has("reply.json")).toBe(false);
    expect(store.count("acceptReply")).toBe(0);
  });

  it("only updates the state when reply.accepted.json is there and reply.json is not", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.accepted.json", replyBytes("Hi"));
    await broker.pollOnce();
    await settle();
    expect(stateOf(store, id)).toBe("replied");
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "Hi" });
    expect(store.count("acceptReply")).toBe(0);
    expect(store.count("removeReply")).toBe(0);
  });

  it("answers the client from memory and retries state.json when the write fails after the link (NFR13.3)", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    store.fail("writeState");
    await broker.pollOnce();
    await settle();
    expect(stateOf(store, id)).toBe("waiting");
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "Hi" });
    expect(events).toEqual([
      { type: "replied", id },
      { type: "error", id, reason: "write failed" },
    ]);
    await broker.pollOnce();
    await settle();
    expect(stateOf(store, id)).toBe("replied");
    expect(store.count("acceptReply")).toBe(1);
    expect(events.slice(2)).toEqual([{ type: "recovered", id }]);
  });

  it("recovers when serve stopped between the link and the removal (NFR13.9)", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    store.fail("removeReply");
    await broker.pollOnce();
    expect(store.entries.get(id)?.files.has("reply.json")).toBe(true);
    expect(store.entries.get(id)?.files.has("reply.accepted.json")).toBe(true);
    expect(stateOf(store, id)).toBe("waiting");
    await broker.pollOnce();
    await settle();
    expect(stateOf(store, id)).toBe("replied");
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "Hi" });
    expect(store.entries.get(id)?.files.has("reply.json")).toBe(false);
  });

  it("ends a request whose reply is of a kind it does not know as invalid_reply", async () => {
    const { store, broker, events } = setup();
    const { id } = await submitWaiting(broker);
    store.putFile(id, "reply.json", serializeFile({ formatVersion: 1, kind: "sing", body: "la" }));
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("invalid_reply");
    expect(store.count("acceptReply")).toBe(0);
    expect(events).toEqual([
      { type: "invalid_reply", id, reason: "reply file has an unknown kind" },
    ]);
  });

  it("does not judge a reply file while the kind of reply the request asks for cannot be known", async () => {
    const { store, broker, events } = setup();
    const id = "20260101T000000000Z-abcdef";
    store.addRaw(id, {
      request: "unsupported",
      state: createStateFile(id, "waiting", NOW, null),
    });
    store.putFile(id, "reply.json", replyBytes("not json"));
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("waiting");
    expect(store.entries.get(id)?.files.has("reply.accepted.json")).toBe(false);
    expect(store.entries.get(id)?.files.has("reply.json")).toBe(true);
    expect(events.filter((event) => event.type === "invalid_reply")).toEqual([]);
  });

  it("settles an old waiting request from a previous run without a connection", async () => {
    const { store, broker, events } = setup();
    const id = "20260101T000000000Z-abcdef";
    store.addRaw(id, {
      request: createRequestFile(id, NOW, request),
      state: createStateFile(id, "waiting", NOW, null),
    });
    store.putFile(id, "reply.json", replyBytes("late"));
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("replied");
    expect(events).toEqual([{ type: "replied", id }]);
  });

  it("does not read a finished request again (NFR8.4)", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    await broker.pollOnce();
    const reads = store.count("readState");
    store.putFile(id, "reply.json", replyBytes("late second reply"));
    await broker.pollOnce();
    await broker.pollOnce();
    expect(store.count("readState")).toBe(reads);
    expect(store.entries.get(id)?.files.get("reply.accepted.json")).toBe(replyBytes("Hi"));
  });
});

describe("failures in reading and writing", () => {
  it("leaves the request waiting, reports the failure, and tries again on the next poll", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    store.fail("readState");
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("waiting");
    expect(events).toEqual([{ type: "error", id, reason: "read failed" }]);
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "Hi" });
  });

  it("reports a failed listing without an id and keeps polling", async () => {
    const { store, broker, events } = setup();
    const { id } = await submitWaiting(broker);
    store.fail("listIds");
    await broker.pollOnce();
    expect(events).toEqual([{ type: "error", id: undefined, reason: "read failed" }]);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("replied");
  });

  it("reports a recovery when a listing works again after it failed", async () => {
    const { store, broker, events } = setup();
    store.fail("listIds");
    await broker.pollOnce();
    await broker.pollOnce();
    await broker.pollOnce();
    expect(events).toEqual([
      { type: "error", id: undefined, reason: "read failed" },
      { type: "recovered", id: undefined },
    ]);
  });

  it("reports every failure it sees, and lets the log decide what to print", async () => {
    const { store, broker, events } = setup();
    const { id } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    store.fail("readState", 2);
    await broker.pollOnce();
    await broker.pollOnce();
    expect(events.filter((event) => event.type === "error")).toHaveLength(2);
  });
});

describe("the polling loop (NFR6.2)", () => {
  it("waits 500 milliseconds after a poll ends, and never runs two polls at once", async () => {
    const { store, broker, clock } = setup();
    let release: () => void = () => {};
    store.gate(
      "listIds",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const polling = broker.startPolling(() => {});
    await settle();
    expect(store.count("listIds")).toBe(1);
    await clock.advance(5000);
    expect(store.count("listIds")).toBe(1);
    store.gate("listIds", undefined);
    release();
    await settle();
    expect(clock.sleeping).toBe(1);
    await clock.advance(499);
    expect(store.count("listIds")).toBe(1);
    await clock.advance(1);
    expect(store.count("listIds")).toBe(2);
    await polling.stop();
  });

  it("passes an exception that escapes a poll to the caller and stops the loop", async () => {
    const store = new FakeStore();
    const failures: unknown[] = [];
    const clock = {
      now: () => new Date(),
      sleep: () => Promise.reject(new Error("unexpected")),
    };
    const broker = new ExchangeBroker({ store, clock, pollIntervalMs: 500 });
    const polling = broker.startPolling((error) => failures.push(error));
    await polling.stop();
    expect(failures).toHaveLength(1);
    expect((failures[0] as Error).message).toBe("unexpected");
    expect(store.count("listIds")).toBe(1);
  });

  it("stops polling when asked", async () => {
    const { store, broker, clock } = setup();
    const polling = broker.startPolling(() => {});
    await settle();
    await clock.advance(500);
    const polls = store.count("listIds");
    await polling.stop();
    await clock.advance(5000);
    expect(store.count("listIds")).toBe(polls);
  });
});

describe("files whose content cannot be read", () => {
  const ID = "20260101T000001000Z-000001";
  const unreadableEvent: BrokerEvent = { type: "error", id: ID, reason: "unreadable" };

  function addWaitingWithReply(
    store: FakeStore,
    overrides: Partial<Parameters<FakeStore["addRaw"]>[1]>,
  ) {
    store.addRaw(ID, {
      request: createRequestFile(ID, NOW, request),
      state: createStateFile(ID, "waiting", NOW, null),
      ...overrides,
    });
    store.putFile(ID, "reply.json", replyBytes("Hi"));
  }

  it("serve leaves a request with an unreadable state.json alone and says so once", async () => {
    const { store, broker, events } = setup();
    addWaitingWithReply(store, { state: "unreadable" });
    for (let poll = 0; poll < 3; poll += 1) {
      await broker.pollOnce();
    }
    expect(events.filter((event) => event.type === "error")).toEqual([unreadableEvent]);
    expect(store.entries.get(ID)?.state).toBe("unreadable");
    expect(store.entries.get(ID)?.files.has("reply.json")).toBe(true);
    expect(store.entries.get(ID)?.files.has("reply.accepted.json")).toBe(false);
  });

  it("serve leaves a request with an unreadable request.json alone and says so once", async () => {
    const { store, broker, events } = setup();
    addWaitingWithReply(store, { request: "unreadable" });
    for (let poll = 0; poll < 3; poll += 1) {
      await broker.pollOnce();
    }
    expect(events.filter((event) => event.type === "error")).toEqual([unreadableEvent]);
    expect(stateOf(store, ID)).toBe("waiting");
    expect(store.entries.get(ID)?.files.has("reply.accepted.json")).toBe(false);
    expect(store.entries.get(ID)?.files.has("reply.json")).toBe(true);
  });

  it("serve stops at an unreadable reply.accepted.json, keeps every file, and says so once", async () => {
    const { store, broker, events } = setup();
    addWaitingWithReply(store, {});
    store.putFile(ID, "reply.accepted.json", "{broken");
    for (let poll = 0; poll < 3; poll += 1) {
      await broker.pollOnce();
    }
    expect(events.filter((event) => event.type === "error")).toEqual([unreadableEvent]);
    expect(stateOf(store, ID)).toBe("waiting");
    expect(store.entries.get(ID)?.files.get("reply.accepted.json")).toBe("{broken");
    expect(store.entries.get(ID)?.files.has("reply.json")).toBe(true);
  });

  it("serve keeps accepting replies for the other requests", async () => {
    const { store, broker } = setup();
    addWaitingWithReply(store, { state: "unreadable" });
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Fine"));
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toMatchObject({ kind: "replied", body: "Fine" });
  });

  it("serve does not read the request.json of a request it saved itself", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    await broker.pollOnce();
    expect(store.count("readRequest")).toBe(0);
    expect(stateOf(store, id)).toBe("waiting");
  });

  it("answer does not list a request with an unreadable request.json or state.json", async () => {
    const { store, broker, events } = setup();
    store.addRaw(ID, {
      request: "unreadable",
      state: createStateFile(ID, "waiting", NOW, null),
    });
    const other = "20260101T000002000Z-000002";
    store.addRaw(other, {
      request: createRequestFile(other, NOW, request),
      state: "unreadable",
    });
    for (let round = 0; round < 3; round += 1) {
      const listing = await broker.listWaiting(new Set());
      expect(listing.waiting).toEqual([]);
    }
    expect(events.filter((event) => event.type === "error")).toEqual([
      unreadableEvent,
      { type: "error", id: other, reason: "unreadable" },
    ]);
    expect(store.entries.get(ID)?.request).toBe("unreadable");
    expect(store.entries.get(other)?.state).toBe("unreadable");
  });
});

describe("the waiting list for answer (FR5.2)", () => {
  async function addWaiting(store: FakeStore, id: string, files: Record<string, string> = {}) {
    store.addRaw(id, {
      request: createRequestFile(id, NOW, request),
      state: createStateFile(id, "waiting", NOW, null),
    });
    for (const [name, bytes] of Object.entries(files)) {
      store.putFile(id, name as "reply.json" | "reply.accepted.json", bytes);
    }
  }

  it("lists waiting requests in id order", async () => {
    const { store, broker } = setup();
    await addWaiting(store, "20260101T000002000Z-000002");
    await addWaiting(store, "20260101T000001000Z-000001");
    const listing = await broker.listWaiting(new Set());
    expect(listing.waiting.map((item) => item.id)).toEqual([
      "20260101T000001000Z-000001",
      "20260101T000002000Z-000002",
    ]);
    expect(listing.waiting[0]?.request.conversation[0]?.content).toBe("Hello");
  });

  it("leaves out requests that have a reply file, are finished, or are skipped by the caller", async () => {
    const { store, broker } = setup();
    await addWaiting(store, "20260101T000001000Z-000001", { "reply.json": replyBytes("x") });
    await addWaiting(store, "20260101T000002000Z-000002", {
      "reply.accepted.json": replyBytes("x"),
    });
    store.addRaw("20260101T000003000Z-000003", {
      request: createRequestFile("20260101T000003000Z-000003", NOW, request),
      state: createStateFile("20260101T000003000Z-000003", "replied", NOW, NOW),
    });
    await addWaiting(store, "20260101T000004000Z-000004");
    await addWaiting(store, "20260101T000005000Z-000005");
    const listing = await broker.listWaiting(new Set(["20260101T000004000Z-000004"]));
    expect(listing.waiting.map((item) => item.id)).toEqual(["20260101T000005000Z-000005"]);
  });

  it("does not read finished requests again on later listings (NFR8.4)", async () => {
    const { store, broker } = setup();
    for (let index = 1; index <= 5; index += 1) {
      const id = `20260101T00000${index}000Z-00000${index}`;
      store.addRaw(id, {
        request: createRequestFile(id, NOW, request),
        state: createStateFile(id, "replied", NOW, NOW),
      });
    }
    await broker.listWaiting(new Set());
    const reads = store.count("readState");
    expect(reads).toBe(5);
    await broker.listWaiting(new Set());
    expect(store.count("readState")).toBe(reads);
  });

  it("reports unsupported requests separately and ignores unreadable ones and stray directories", async () => {
    const { store, broker } = setup();
    store.addRaw("20260101T000001000Z-000001", {
      request: "unsupported",
      state: createStateFile("20260101T000001000Z-000001", "waiting", NOW, null),
    });
    store.addRaw("20260101T000002000Z-000002", {
      request: "unreadable",
      state: createStateFile("20260101T000002000Z-000002", "waiting", NOW, null),
    });
    store.addRaw("20260101T000003000Z-000003", {
      request: createRequestFile("20260101T000003000Z-000003", NOW, request),
      state: "missing",
    });
    const listing = await broker.listWaiting(new Set());
    expect(listing.waiting).toEqual([]);
    expect(listing.unsupported).toEqual(["20260101T000001000Z-000001"]);
  });

  it("skips a request it could not read this time and reads it again next time", async () => {
    const { store, broker, events } = setup();
    await addWaiting(store, "20260101T000001000Z-000001");
    store.fail("readState");
    const first = await broker.listWaiting(new Set());
    expect(first.waiting).toEqual([]);
    expect(events).toEqual([
      { type: "error", id: "20260101T000001000Z-000001", reason: "read failed" },
    ]);
    const second = await broker.listWaiting(new Set());
    expect(second.waiting).toHaveLength(1);
  });
});

describe("placing and confirming a reply", () => {
  it("places a reply that carries the source and the written time", async () => {
    const { store, broker, clock } = setup();
    const { id } = await submitWaiting(broker);
    const result = await broker.placeReply(id, "Hi");
    expect(result.kind).toBe("placed");
    const stored = store.entries.get(id)?.files.get("reply.json");
    expect(stored).toBeDefined();
    expect(JSON.parse(stored ?? "{}")).toEqual({
      formatVersion: 1,
      kind: "text",
      body: "Hi",
      source: "imbehind-answer",
      writtenAt: clock.now().toISOString(),
    });
    if (result.kind === "placed") {
      expect(result.bytes).toBe(stored);
    }
  });

  it("reports too late when the request is not waiting, or already has a reply", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    await broker.placeReply(id, "first");
    expect((await broker.placeReply(id, "second")).kind).toBe("too-late");
    const finished = "20260101T000009000Z-000009";
    store.addRaw(finished, {
      request: createRequestFile(finished, NOW, request),
      state: createStateFile(finished, "replied", NOW, NOW),
    });
    expect((await broker.placeReply(finished, "x")).kind).toBe("too-late");
  });

  it("reports too late when reply.accepted.json is already there", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    store.putFile(id, "reply.accepted.json", replyBytes("other"));
    expect((await broker.placeReply(id, "mine")).kind).toBe("too-late");
  });

  it("lets an input/output failure through so the caller can show it", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    store.fail("placeReply");
    await expect(broker.placeReply(id, "Hi")).rejects.toBeInstanceOf(IoFailure);
  });

  it("confirms only a reply whose bytes are the ones this answer wrote", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    const placed = await broker.placeReply(id, "Hi");
    if (placed.kind !== "placed") {
      throw new Error("expected the reply to be placed");
    }
    expect(await broker.confirmReply(id, placed.bytes)).toEqual({ kind: "pending" });
    await broker.pollOnce();
    expect(await broker.confirmReply(id, placed.bytes)).toEqual({ kind: "sent" });
    expect(await broker.confirmReply(id, `${placed.bytes} `)).toEqual({ kind: "elsewhere" });
    expect(stateOf(store, id)).toBe("replied");
  });

  it("answers unreadable when the state.json content cannot be read", async () => {
    const { store, broker } = setup();
    const id = "20260101T000001000Z-000001";
    store.addRaw(id, {
      request: createRequestFile(id, NOW, request),
      state: "unreadable",
    });
    expect(await broker.confirmReply(id, "x")).toEqual({ kind: "unreadable" });
  });

  it("answers pending while state.json is missing", async () => {
    const { store, broker } = setup();
    const id = "20260101T000001000Z-000001";
    store.addRaw(id, { request: createRequestFile(id, NOW, request), state: "missing" });
    expect(await broker.confirmReply(id, "x")).toEqual({ kind: "pending" });
  });
});

describe("json replies", () => {
  it("has one reply check: json is checked, text is not, shape is not looked at", () => {
    const { broker } = setup();
    expect(broker.checkReply("json", '{"passed": true}')).toEqual({ ok: true });
    expect(broker.checkReply("json", '{"passed":')).toEqual({
      ok: false,
      reason: "unexpected end of input at line 1",
    });
    expect(broker.checkReply("text", '{"passed":')).toEqual({ ok: true });
  });

  it("places a json reply with kind json and the body exactly as given", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    const body = '{ "passed":   true }';
    const result = await broker.placeReply(id, body, "json");
    expect(result.kind).toBe("placed");
    const stored = JSON.parse(store.entries.get(id)?.files.get("reply.json") ?? "{}");
    expect(stored).toMatchObject({ formatVersion: 1, kind: "json", body });
  });

  it("accepts a json reply with the same steps as a text reply and passes the body as typed", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    const body = '{ "passed":   true }';
    store.putFile(id, "reply.json", serializeFile(createReplyFile(body, NOW, "json")));
    await broker.pollOnce();
    await settle();
    const entry = store.entries.get(id);
    expect(entry?.files.has("reply.json")).toBe(false);
    expect(entry?.files.has("reply.accepted.json")).toBe(true);
    expect(stateOf(store, id)).toBe("replied");
    expect(outcomeOf()).toEqual({ kind: "replied", id, body });
    expect(events).toEqual([{ type: "replied", id }]);
  });

  it("lists a waiting json request with its reply kind and required shape", async () => {
    const { broker } = setup();
    const submitted = await broker.submit({
      ...request,
      replyKind: "json",
      requiredShape: { type: "object" },
    });
    const listing = await broker.listWaiting(new Set());
    expect(listing.waiting.map((item) => item.id)).toEqual([submitted.id]);
    expect(listing.waiting[0]?.request.replyKind).toBe("json");
    expect(listing.waiting[0]?.request.requiredShape).toEqual({ type: "object" });
  });
});

describe("where the whole conversation can be read", () => {
  it("returns the place of request.json that the store gives, without reading anything", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    const callsBefore = { ...store.calls };
    expect(broker.requestFilePath(id)).toBe(store.requestFilePath(id));
    expect(broker.requestFilePath(id)).toMatch(/request\.json$/);
    expect(store.calls).toEqual(callsBefore);
  });
});

describe("subscribing to events", () => {
  it("stops sending events to a handler that unsubscribed", async () => {
    const { store, broker } = setup();
    const received: BrokerEvent[] = [];
    const unsubscribe = broker.subscribe((event) => received.push(event));
    unsubscribe();
    const { id } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    await broker.pollOnce();
    expect(received).toEqual([]);
  });
});

describe("how a request ends", () => {
  const skipBytes = serializeFile(createReplyFile("", NOW, "skip"));

  it("ends a request as skipped when the accepted reply is a skip, with no body", async () => {
    const { store, broker, events, clock } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", skipBytes);
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toEqual({ kind: "skipped", id });
    expect(store.entries.get(id)?.state).toEqual({
      formatVersion: 1,
      id,
      state: "skipped",
      updatedAt: clock.now().toISOString(),
      endedAt: clock.now().toISOString(),
      endReason: "skipped by the human",
    });
    expect(store.entries.get(id)?.files.get("reply.accepted.json")).toBe(skipBytes);
    expect(store.entries.get(id)?.files.has("reply.json")).toBe(false);
    expect(events).toEqual([{ type: "skipped", id }]);
  });

  it("writes a null end reason when a request is replied", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    await broker.pollOnce();
    expect(store.entries.get(id)?.state).toMatchObject({ state: "replied", endReason: null });
  });

  it("places a skip reply with an empty body when asked", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    const result = await broker.placeReply(id, "", "skip");
    expect(result.kind).toBe("placed");
    expect(JSON.parse(store.entries.get(id)?.files.get("reply.json") ?? "{}")).toMatchObject({
      kind: "skip",
      body: "",
    });
  });

  it("does not use a reply.json it cannot read, leaves the claim free and tries again later", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("fixed"));
    store.fail("readReply", 2, "unreadable");
    await broker.pollOnce();
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("waiting");
    expect(store.count("acceptReply")).toBe(0);
    expect(events).toEqual([
      { type: "error", id, reason: "unreadable" },
      { type: "error", id, reason: "unreadable" },
    ]);
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "fixed" });
    expect(events.at(-2)).toEqual({ type: "replied", id });
    expect(events.at(-1)).toEqual({ type: "recovered", id });
  });

  it("lets a disconnect win when the only reply.json cannot be read", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    store.fail("readReply", 1, "unreadable");
    await broker.pollOnce();
    await broker.cancel(id);
    expect(stateOf(store, id)).toBe("cancelled");
    expect(outcomeOf()).toEqual({ kind: "cancelled", id });
  });

  it("ends a request as cancelled when the client disconnects", async () => {
    const { store, broker, events, clock } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    await broker.cancel(id);
    await settle();
    expect(outcomeOf()).toEqual({ kind: "cancelled", id });
    expect(store.entries.get(id)?.state).toMatchObject({
      state: "cancelled",
      endedAt: clock.now().toISOString(),
      endReason: "client disconnected",
    });
    expect(events).toEqual([{ type: "cancelled", id }]);
  });

  it("does not use a reply file that arrives after the disconnect", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    await broker.cancel(id);
    store.putFile(id, "reply.json", replyBytes("too late"));
    await broker.pollOnce();
    expect(store.count("acceptReply")).toBe(0);
    expect(stateOf(store, id)).toBe("cancelled");
  });

  it("ignores a disconnect for a request it does not wait for, and a second disconnect", async () => {
    const { store, broker, events } = setup();
    await broker.cancel("20260101T000009000Z-000009");
    const { id } = await submitWaiting(broker);
    await broker.cancel(id);
    await broker.cancel(id);
    expect(store.count("writeState")).toBe(1);
    expect(events).toEqual([{ type: "cancelled", id }]);
  });

  it("ends a request as timed_out when the wait limit passes on the injected clock", async () => {
    const { store, broker, events, clock } = setup(3);
    const { id, outcomeOf } = await submitWaiting(broker);
    await clock.advance(2999);
    expect(outcomeOf()).toBeUndefined();
    expect(stateOf(store, id)).toBe("waiting");
    await clock.advance(1);
    expect(outcomeOf()).toEqual({ kind: "timed_out", id, limitSeconds: 3 });
    expect(store.entries.get(id)?.state).toMatchObject({
      state: "timed_out",
      endedAt: clock.now().toISOString(),
      endReason: "wait limit of 3 seconds reached",
    });
    expect(events).toEqual([{ type: "timed_out", id }]);
  });

  it("counts the limit from the time the request arrived, not from when it was stored", async () => {
    const { clock } = setup(1);
    const slow = new FakeStore();
    const original = slow.createRequest.bind(slow);
    slow.createRequest = async (...args) => {
      await clock.advance(400);
      await original(...args);
    };
    const late = new ExchangeBroker({
      store: slow,
      clock,
      pollIntervalMs: 500,
      waitLimitSeconds: 1,
    });
    const { id } = await submitWaiting(late);
    await clock.advance(599);
    expect(slow.entries.get(id)?.state).toMatchObject({ state: "waiting" });
    await clock.advance(1);
    expect(slow.entries.get(id)?.state).toMatchObject({ state: "timed_out" });
  });

  it("places no timer when the limit is 0 or not given, and the request stays waiting", async () => {
    for (const limit of [0, undefined]) {
      const { store, broker, clock } = setup(limit);
      const { id, outcomeOf } = await submitWaiting(broker);
      expect(clock.sleeping).toBe(0);
      await clock.advance(31 * 60 * 1000);
      expect(outcomeOf()).toBeUndefined();
      expect(stateOf(store, id)).toBe("waiting");
    }
  });

  it("does not time out a request that was not stored", async () => {
    const { store, broker, clock } = setup(5);
    store.fail("createRequest");
    await expect(broker.submit(request)).rejects.toBeInstanceOf(IoFailure);
    expect(clock.sleeping).toBe(0);
  });

  it("removes the timer of a request once it has ended, whichever way it ended", async () => {
    const { store, broker, clock } = setup(60);
    const replied = await submitWaiting(broker);
    const cancelled = await submitWaiting(broker);
    const skipped = await submitWaiting(broker);
    expect(clock.sleeping).toBe(3);
    store.putFile(replied.id, "reply.json", replyBytes("Hi"));
    store.putFile(skipped.id, "reply.json", skipBytes);
    await broker.pollOnce();
    expect(clock.sleeping).toBe(1);
    await broker.cancel(cancelled.id);
    expect(clock.sleeping).toBe(0);
    const writes = store.count("writeState");
    await clock.advance(120_000);
    expect(store.count("writeState")).toBe(writes);
  });

  it("removes the timer of a timed out request and forgets the waiter", async () => {
    const { store, broker, clock } = setup(1);
    const { id } = await submitWaiting(broker);
    await clock.advance(1000);
    expect(clock.sleeping).toBe(0);
    await broker.cancel(id);
    expect(store.count("writeState")).toBe(1);
  });

  it("on shutdown cancels every timer, answers nobody and leaves the files waiting", async () => {
    const { store, broker, clock, events } = setup(60);
    const first = await submitWaiting(broker);
    const second = await submitWaiting(broker);
    broker.shutdown();
    expect(clock.sleeping).toBe(0);
    await broker.cancel(first.id);
    await clock.advance(120_000);
    expect(first.outcomeOf()).toBeUndefined();
    expect(second.outcomeOf()).toBeUndefined();
    expect(stateOf(store, first.id)).toBe("waiting");
    expect(stateOf(store, second.id)).toBe("waiting");
    expect(events).toEqual([]);
  });
});

describe("a poll after or during shutdown accepts nothing", () => {
  function waitingWithReply(store: FakeStore, id: string): void {
    const entry = store.entries.get(id);
    entry?.files.set("reply.json", replyBytes("late"));
  }

  it("does not accept a reply.json that is there when the poll starts after shutdown", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    waitingWithReply(store, id);
    broker.shutdown();
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("waiting");
    expect(store.entries.get(id)?.files.has("reply.accepted.json")).toBe(false);
    expect(store.entries.get(id)?.files.has("reply.json")).toBe(true);
    expect(store.count("writeState")).toBe(0);
    expect(outcomeOf()).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("does not accept a reply when shutdown comes while the poll is reading the files", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    waitingWithReply(store, id);
    let release: () => void = () => {};
    store.gate(
      "readReply",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const poll = broker.pollOnce();
    for (let round = 0; round < 100 && store.count("readReply") < 1; round += 1) {
      await settle();
    }
    expect(store.count("readReply")).toBe(1);
    broker.shutdown();
    store.gate("readReply", undefined);
    release();
    await poll;
    expect(stateOf(store, id)).toBe("waiting");
    expect(store.entries.get(id)?.files.has("reply.accepted.json")).toBe(false);
    expect(store.count("acceptReply")).toBe(0);
    expect(store.count("writeState")).toBe(0);
    expect(outcomeOf()).toBeUndefined();
    expect(events).toEqual([]);
  });

  it("does not finish an ending when shutdown comes after the reply was linked", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    waitingWithReply(store, id);
    let release: () => void = () => {};
    store.gate(
      "acceptReply",
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    const poll = broker.pollOnce();
    for (let round = 0; round < 100 && store.count("acceptReply") < 1; round += 1) {
      await settle();
    }
    broker.shutdown();
    store.gate("acceptReply", undefined);
    release();
    await poll;
    expect(stateOf(store, id)).toBe("waiting");
    expect(store.count("writeState")).toBe(0);
    expect(outcomeOf()).toBeUndefined();
    expect(events).toEqual([]);
  });
});

describe("only the first ending counts", () => {
  /** Makes an operation of the store wait. Returns the function that lets it go on. */
  function hold(store: FakeStore, operation: string): () => void {
    let release: () => void = () => {};
    store.gate(
      operation,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      store.gate(operation, undefined);
      release();
    };
  }

  async function reached(store: FakeStore, operation: string, times = 1): Promise<void> {
    for (let round = 0; round < 100 && store.count(operation) < times; round += 1) {
      await settle();
    }
    expect(store.count(operation)).toBeGreaterThanOrEqual(times);
  }

  it("keeps the reply when the client disconnects after the reply claimed the request", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    const release = hold(store, "acceptReply");
    const polling = broker.pollOnce();
    await reached(store, "acceptReply");
    await broker.cancel(id);
    release();
    await polling;
    await settle();
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "Hi" });
    expect(stateOf(store, id)).toBe("replied");
    expect(store.count("writeState")).toBe(1);
    expect(events).toEqual([{ type: "replied", id }]);
  });

  it("keeps the disconnect when it claimed the request before the reply was claimed", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    const release = hold(store, "readReply");
    const polling = broker.pollOnce();
    await reached(store, "readReply");
    await broker.cancel(id);
    release();
    await polling;
    await settle();
    expect(outcomeOf()).toEqual({ kind: "cancelled", id });
    expect(stateOf(store, id)).toBe("cancelled");
    expect(store.count("acceptReply")).toBe(0);
    expect(events).toEqual([{ type: "cancelled", id }]);
  });

  it("writes the state once when the disconnect comes during the state write", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    const release = hold(store, "writeState");
    const polling = broker.pollOnce();
    await reached(store, "writeState");
    await broker.cancel(id);
    release();
    await polling;
    await settle();
    expect(store.count("writeState")).toBe(1);
    expect(stateOf(store, id)).toBe("replied");
    expect(outcomeOf()).toMatchObject({ kind: "replied" });
  });

  it("keeps the reply when the wait limit passes after the reply claimed the request", async () => {
    const { store, broker, clock } = setup(10);
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    const release = hold(store, "acceptReply");
    const polling = broker.pollOnce();
    await reached(store, "acceptReply");
    await clock.advance(10_000);
    release();
    await polling;
    await settle();
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "Hi" });
    expect(stateOf(store, id)).toBe("replied");
    expect(store.count("writeState")).toBe(1);
  });

  it("keeps the wait limit when it claimed the request before the reply was claimed", async () => {
    const { store, broker, clock } = setup(10);
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    const release = hold(store, "readReply");
    const polling = broker.pollOnce();
    await reached(store, "readReply");
    await clock.advance(10_000);
    release();
    await polling;
    await settle();
    expect(outcomeOf()).toEqual({ kind: "timed_out", id, limitSeconds: 10 });
    expect(store.count("acceptReply")).toBe(0);
    expect(store.count("writeState")).toBe(1);
  });

  it("lets the wait limit win over a disconnect that comes during its state write", async () => {
    const { store, broker, clock } = setup(10);
    const { id, outcomeOf } = await submitWaiting(broker);
    const release = hold(store, "writeState");
    const advancing = clock.advance(10_000);
    await reached(store, "writeState");
    await broker.cancel(id);
    release();
    await advancing;
    await settle();
    expect(outcomeOf()).toEqual({ kind: "timed_out", id, limitSeconds: 10 });
    expect(stateOf(store, id)).toBe("timed_out");
    expect(store.count("writeState")).toBe(1);
  });

  it("lets the disconnect win over a wait limit that comes during its state write", async () => {
    const { store, broker, clock } = setup(10);
    const { id, outcomeOf } = await submitWaiting(broker);
    const release = hold(store, "writeState");
    const cancelling = broker.cancel(id);
    await reached(store, "writeState");
    await clock.advance(10_000);
    release();
    await cancelling;
    await settle();
    expect(outcomeOf()).toEqual({ kind: "cancelled", id });
    expect(stateOf(store, id)).toBe("cancelled");
    expect(store.count("writeState")).toBe(1);
  });

  it("gives the claim back when the work fails before reply.accepted.json exists, and tries again", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    store.fail("acceptReply");
    await broker.pollOnce();
    expect(outcomeOf()).toBeUndefined();
    expect(stateOf(store, id)).toBe("waiting");
    expect(events).toEqual([{ type: "error", id, reason: "link failed" }]);
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "Hi" });
    expect(events.slice(1)).toEqual([
      { type: "replied", id },
      { type: "recovered", id },
    ]);
  });

  it("applies a disconnect that came while the claim was held and then given back", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    const release = hold(store, "acceptReply");
    store.fail("acceptReply");
    const polling = broker.pollOnce();
    await reached(store, "acceptReply");
    await broker.cancel(id);
    release();
    await polling;
    await settle();
    expect(outcomeOf()).toEqual({ kind: "cancelled", id });
    expect(stateOf(store, id)).toBe("cancelled");
    expect(store.count("acceptReply")).toBe(1);
  });

  it("applies a wait limit that came while the claim was held and then given back", async () => {
    const { store, broker, clock } = setup(10);
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    const release = hold(store, "acceptReply");
    store.fail("acceptReply");
    const polling = broker.pollOnce();
    await reached(store, "acceptReply");
    await clock.advance(10_000);
    release();
    await polling;
    await settle();
    expect(outcomeOf()).toEqual({ kind: "timed_out", id, limitSeconds: 10 });
    expect(stateOf(store, id)).toBe("timed_out");
  });

  it("keeps the claim and retries the state write when a cancelled state cannot be written", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.fail("writeState");
    await broker.cancel(id);
    expect(stateOf(store, id)).toBe("waiting");
    expect(events).toEqual([
      { type: "cancelled", id },
      { type: "error", id, reason: "write failed" },
    ]);
    store.putFile(id, "reply.json", replyBytes("late"));
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("cancelled");
    expect(store.count("acceptReply")).toBe(0);
    expect(outcomeOf()).toEqual({ kind: "cancelled", id });
    expect(events.slice(2)).toEqual([{ type: "recovered", id }]);
  });

  it("answers a timed out client at once and retries the state write when it fails", async () => {
    const { store, broker, clock } = setup(1);
    const { id, outcomeOf } = await submitWaiting(broker);
    store.fail("writeState", 2);
    await clock.advance(1000);
    expect(outcomeOf()).toEqual({ kind: "timed_out", id, limitSeconds: 1 });
    expect(stateOf(store, id)).toBe("waiting");
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("waiting");
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("timed_out");
    expect(store.entries.get(id)?.state).toMatchObject({
      endReason: "wait limit of 1 seconds reached",
    });
  });

  it("finishes removing reply.json and writing the state after the client was answered", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    store.fail("removeReply");
    await broker.pollOnce();
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "Hi" });
    expect(stateOf(store, id)).toBe("waiting");
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("replied");
    expect(store.entries.get(id)?.files.has("reply.json")).toBe(false);
  });

  it("does not use a reply when the request was claimed after the poll had read its state", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    const release = hold(store, "readState");
    const polling = broker.pollOnce();
    await reached(store, "readState");
    await broker.cancel(id);
    release();
    await polling;
    await settle();
    expect(outcomeOf()).toEqual({ kind: "cancelled", id });
    expect(store.count("acceptReply")).toBe(0);
    expect(stateOf(store, id)).toBe("cancelled");
  });

  it("does not claim a request twice when two polls overlap its ending", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    const release = hold(store, "acceptReply");
    const first = broker.pollOnce();
    await reached(store, "acceptReply");
    const second = broker.pollOnce();
    await settle();
    release();
    await Promise.all([first, second]);
    expect(store.count("acceptReply")).toBe(1);
    expect(store.count("writeState")).toBe(1);
  });
});

describe("checking a reply file before it is accepted (BR27)", () => {
  const jsonRequest: ConversationRequest = { ...request, replyKind: "json" };

  async function submitJson(broker: ExchangeBroker) {
    const submitted = await broker.submit(jsonRequest);
    let outcome: ExchangeOutcome | undefined;
    submitted.outcome.then((value) => {
      outcome = value;
    });
    return { id: submitted.id, outcomeOf: () => outcome };
  }

  function hold(store: FakeStore, operation: string): () => void {
    let release: () => void = () => {};
    store.gate(
      operation,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      store.gate(operation, undefined);
      release();
    };
  }

  async function reached(store: FakeStore, operation: string): Promise<void> {
    for (let round = 0; round < 100 && store.count(operation) < 1; round += 1) {
      await settle();
    }
    expect(store.count(operation)).toBeGreaterThanOrEqual(1);
  }

  it("accepts the bytes it verified, even when reply.json is rewritten afterwards", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("first"));
    const release = hold(store, "acceptReply");
    const polling = broker.pollOnce();
    await reached(store, "acceptReply");
    store.putFile(id, "reply.json", replyBytes("second"));
    release();
    await polling;
    await settle();
    expect(store.entries.get(id)?.files.get("reply.accepted.json")).toBe(replyBytes("first"));
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "first" });
    expect(stateOf(store, id)).toBe("replied");
  });

  it("reads reply.json once and does not read it again to accept it", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    await broker.pollOnce();
    expect(store.count("readReply")).toBe(1);
    expect(stateOf(store, id)).toBe("replied");
  });

  it("accepts a reply that starts with a byte order mark and keeps the file as written", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", `﻿${replyBytes("Hi")}`);
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "Hi" });
    expect(store.entries.get(id)?.files.get("reply.accepted.json")).toBe(`﻿${replyBytes("Hi")}`);
  });

  it("hands the body over as written, with no change of line ends", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(
      id,
      "reply.json",
      serializeFile({ formatVersion: 1, kind: "text", body: "a\r\nb\n\n" }),
    );
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "a\r\nb\n\n" });
  });

  it("accepts a skip reply written by hand as skipped, for a json request too", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitJson(broker);
    store.putFile(id, "reply.json", serializeFile({ formatVersion: 1, kind: "skip", body: "" }));
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toEqual({ kind: "skipped", id });
    expect(stateOf(store, id)).toBe("skipped");
  });

  it("checks the body as json by the kind of the request, not by the kind of the reply", async () => {
    const { store, broker } = setup();
    const textRequest = await submitWaiting(broker);
    store.putFile(
      textRequest.id,
      "reply.json",
      serializeFile({ formatVersion: 1, kind: "json", body: "not json" }),
    );
    const jsonOne = await submitJson(broker);
    store.putFile(
      jsonOne.id,
      "reply.json",
      serializeFile({ formatVersion: 1, kind: "text", body: "not json" }),
    );
    await broker.pollOnce();
    await settle();
    expect(textRequest.outcomeOf()).toEqual({
      kind: "replied",
      id: textRequest.id,
      body: "not json",
    });
    expect(jsonOne.outcomeOf()).toEqual({
      kind: "invalid_reply",
      id: jsonOne.id,
      reason: "reply body is not valid JSON (unexpected character at line 1, column 2)",
    });
  });

  it("uses the reply kind of a request that an earlier run saved (read from request.json)", async () => {
    const { store, broker, events } = setup();
    const id = "20260101T000000000Z-abcdef";
    store.addRaw(id, {
      request: createRequestFile(id, NOW, jsonRequest),
      state: createStateFile(id, "waiting", NOW, null),
    });
    store.putFile(id, "reply.json", replyBytes("not json"));
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("invalid_reply");
    expect(events).toEqual([
      {
        type: "invalid_reply",
        id,
        reason: "reply body is not valid JSON (unexpected character at line 1, column 2)",
      },
    ]);
  });

  it("treats a reply.json that vanished after the listing as no reply", async () => {
    const { store, broker, events } = setup();
    const { id } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    const release = hold(store, "readReply");
    const polling = broker.pollOnce();
    await reached(store, "readReply");
    store.entries.get(id)?.files.delete("reply.json");
    release();
    await polling;
    expect(stateOf(store, id)).toBe("waiting");
    expect(events).toEqual([]);
  });
});

describe("ending a request with an invalid reply file (BR28)", () => {
  function hold(store: FakeStore, operation: string): () => void {
    let release: () => void = () => {};
    store.gate(
      operation,
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    return () => {
      store.gate(operation, undefined);
      release();
    };
  }

  it("keeps reply.json, makes no reply.accepted.json, and writes the reason", async () => {
    const { store, broker, clock } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", "{broken");
    await broker.pollOnce();
    await settle();
    const entry = store.entries.get(id);
    expect(entry?.files.get("reply.json")).toBe("{broken");
    expect(entry?.files.has("reply.accepted.json")).toBe(false);
    expect(store.count("acceptReply")).toBe(0);
    expect(store.count("removeReply")).toBe(0);
    const now = clock.now().toISOString();
    expect(entry?.state).toEqual(
      createStateFile(id, "invalid_reply", now, now, "reply file is not valid JSON"),
    );
    expect(outcomeOf()).toEqual({
      kind: "invalid_reply",
      id,
      reason: "reply file is not valid JSON",
    });
  });

  it("gives every reason of the reply file check to the state, the outcome and the event alike", async () => {
    const cases: Array<[unknown, string]> = [
      [{ formatVersion: 1, kind: "text" }, "reply file is missing a required field"],
      [{ formatVersion: 3, kind: "text", body: "x" }, "reply file has an unknown format version"],
      [{ formatVersion: 1, kind: "audio", body: "x" }, "reply file has an unknown kind"],
      [
        { formatVersion: 1, kind: "text", body: "" },
        "reply file has a body that does not fit its kind",
      ],
    ];
    for (const [content, reason] of cases) {
      const { store, broker, events } = setup();
      const { id, outcomeOf } = await submitWaiting(broker);
      store.putFile(id, "reply.json", serializeFile(content));
      await broker.pollOnce();
      await settle();
      expect(store.entries.get(id)?.state).toMatchObject({
        state: "invalid_reply",
        endReason: reason,
      });
      expect(outcomeOf()).toEqual({ kind: "invalid_reply", id, reason });
      expect(events).toEqual([{ type: "invalid_reply", id, reason }]);
    }
  });

  it("says too large for a file over the limit without reading its content", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putOversizeReply(id);
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toEqual({
      kind: "invalid_reply",
      id,
      reason: "reply file is larger than 10 MB",
    });
    expect(store.entries.get(id)?.files.has("reply.json")).toBe(true);
  });

  it("says not valid JSON for bytes that are not UTF-8", async () => {
    const { store, broker } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putRawReply(id, Uint8Array.from([0x7b, 0xff, 0x7d]));
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toEqual({
      kind: "invalid_reply",
      id,
      reason: "reply file is not valid JSON",
    });
  });

  it("writes the line for a request that this serve holds no connection for", async () => {
    const { store, broker, events } = setup();
    const id = "20260101T000000000Z-abcdef";
    store.addRaw(id, {
      request: createRequestFile(id, NOW, request),
      state: createStateFile(id, "waiting", NOW, null),
    });
    store.putFile(id, "reply.json", "{broken");
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("invalid_reply");
    expect(events).toEqual([{ type: "invalid_reply", id, reason: "reply file is not valid JSON" }]);
  });

  it("does not read reply.json of a request that has reply.accepted.json", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.accepted.json", replyBytes("first"));
    store.putFile(id, "reply.json", "{broken");
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "first" });
    expect(events).toEqual([{ type: "replied", id }]);
    expect(store.entries.get(id)?.state).toMatchObject({ state: "replied" });
  });

  it("cannot take a reply after an invalid reply.json: the first arrival is the one", async () => {
    const { store, broker } = setup();
    const { id } = await submitWaiting(broker);
    store.putFile(id, "reply.json", "{broken");
    await broker.pollOnce();
    expect(await broker.placeReply(id, "late")).toEqual({ kind: "too-late" });
    expect(await broker.confirmReply(id, undefined)).toEqual({ kind: "ended" });
  });

  it("lets abandoned win for a request that waited before the start, and does not read its reply", async () => {
    const { store, broker } = setup();
    const id = "20260101T000000000Z-abcdef";
    store.addRaw(id, {
      request: createRequestFile(id, NOW, request),
      state: createStateFile(id, "waiting", NOW, null),
    });
    store.putFile(id, "reply.json", "{broken");
    await broker.abandon(await broker.snapshotWaiting());
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("abandoned");
    expect(store.count("readReply")).toBe(0);
  });

  it("claims the request: a disconnect or the wait limit that comes during the write loses", async () => {
    const { store, broker, clock, events } = setup(10);
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", "{broken");
    const release = hold(store, "writeState");
    const polling = broker.pollOnce();
    for (let round = 0; round < 100 && store.count("writeState") < 1; round += 1) {
      await settle();
    }
    await broker.cancel(id);
    await clock.advance(10_000);
    release();
    await polling;
    await settle();
    expect(store.count("writeState")).toBe(1);
    expect(stateOf(store, id)).toBe("invalid_reply");
    expect(outcomeOf()).toMatchObject({ kind: "invalid_reply" });
    expect(events).toEqual([{ type: "invalid_reply", id, reason: "reply file is not valid JSON" }]);
  });

  it("answers the client at once and retries only the state write when it fails", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", "{broken");
    store.fail("writeState", 2);
    await broker.pollOnce();
    await settle();
    expect(outcomeOf()).toEqual({
      kind: "invalid_reply",
      id,
      reason: "reply file is not valid JSON",
    });
    expect(stateOf(store, id)).toBe("waiting");
    // The line comes only when state.json is written, and the failure is reported.
    expect(events).toEqual([{ type: "error", id, reason: "write failed" }]);
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("waiting");
    store.putFile(id, "reply.json", replyBytes("now valid"));
    await broker.pollOnce();
    await settle();
    expect(stateOf(store, id)).toBe("invalid_reply");
    expect(store.entries.get(id)?.state).toMatchObject({
      endReason: "reply file is not valid JSON",
    });
    expect(store.count("readReply")).toBe(1);
    expect(store.count("acceptReply")).toBe(0);
    expect(events.filter((event) => event.type === "invalid_reply")).toEqual([
      { type: "invalid_reply", id, reason: "reply file is not valid JSON" },
    ]);
    expect(events.at(-1)).toEqual({ type: "recovered", id });
  });

  it("keeps the ending when a disconnect comes between the failed write and the retry", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", "{broken");
    store.fail("writeState", 1);
    await broker.pollOnce();
    await broker.cancel(id);
    await broker.pollOnce();
    await settle();
    expect(stateOf(store, id)).toBe("invalid_reply");
    expect(outcomeOf()).toMatchObject({ kind: "invalid_reply" });
    expect(events.some((event) => event.type === "cancelled")).toBe(false);
  });
});

describe("the size of the file an answer writes", () => {
  const empty = serializeFile(createReplyFile("", NOW)).length;

  it("lets a reply of exactly the limit through and refuses one byte more", () => {
    const { broker } = setup();
    expect(broker.replyFitsLimit("a".repeat(MAX_FILE_BYTES - empty), "text")).toBe(true);
    expect(broker.replyFitsLimit("a".repeat(MAX_FILE_BYTES - empty + 1), "text")).toBe(false);
  });

  it("counts the bytes of the written file, not the characters of the body", () => {
    const { broker } = setup();
    const fits = Math.floor((MAX_FILE_BYTES - empty) / 2);
    expect(broker.replyFitsLimit("é".repeat(fits), "text")).toBe(true);
    expect(broker.replyFitsLimit("é".repeat(fits + 1), "text")).toBe(false);
  });

  it("counts the quotes and line ends that the written form escapes", () => {
    const { broker } = setup();
    expect(broker.replyFitsLimit('"'.repeat(6_000_000), "json")).toBe(false);
    expect(broker.replyFitsLimit("\n".repeat(6_000_000), "text")).toBe(false);
    expect(broker.replyFitsLimit("short", "text")).toBe(true);
  });
});

describe("what a screen learns about the reply it placed", () => {
  const ID = "20260101T000001000Z-000001";
  const placedBytes = replyBytes("mine");

  function endedWith(
    store: FakeStore,
    state: Parameters<typeof createStateFile>[1] | "other",
    reason: string | null,
    accepted?: string,
  ) {
    store.addRaw(ID, {
      request: createRequestFile(ID, NOW, request),
      state: {
        ...createStateFile(ID, state === "other" ? "replied" : state, NOW, NOW, reason),
        state,
      },
    });
    if (accepted !== undefined) {
      store.putFile(ID, "reply.accepted.json", accepted);
    }
  }

  it("is sent or skipped when the accepted bytes are the ones it placed", async () => {
    const a = setup();
    endedWith(a.store, "replied", null, placedBytes);
    expect(await a.broker.confirmReply(ID, placedBytes)).toEqual({ kind: "sent" });
    const skip = serializeFile(createReplyFile("", NOW, "skip"));
    const b = setup();
    endedWith(b.store, "skipped", "skipped by the human", skip);
    expect(await b.broker.confirmReply(ID, skip)).toEqual({ kind: "skipped" });
  });

  it("is elsewhere when the accepted bytes differ, or when it placed nothing", async () => {
    const a = setup();
    endedWith(a.store, "replied", null, replyBytes("theirs"));
    expect(await a.broker.confirmReply(ID, placedBytes)).toEqual({ kind: "elsewhere" });
    expect(await a.broker.confirmReply(ID, undefined)).toEqual({ kind: "elsewhere" });
    const b = setup();
    endedWith(b.store, "skipped", "skipped by the human", replyBytes("theirs"));
    expect(await b.broker.confirmReply(ID, placedBytes)).toEqual({ kind: "elsewhere" });
  });

  it("is elsewhere when no accepted reply can be found for a replied request", async () => {
    const a = setup();
    endedWith(a.store, "replied", null);
    expect(await a.broker.confirmReply(ID, placedBytes)).toEqual({ kind: "elsewhere" });
  });

  it("is cancelled for a cancelled request", async () => {
    const a = setup();
    endedWith(a.store, "cancelled", "client disconnected");
    expect(await a.broker.confirmReply(ID, placedBytes)).toEqual({ kind: "cancelled" });
  });

  it("is timed out with the limit read from the end reason, or without it when it cannot be read", async () => {
    const a = setup();
    endedWith(a.store, "timed_out", "wait limit of 5 seconds reached");
    expect(await a.broker.confirmReply(ID, placedBytes)).toEqual({
      kind: "timed_out",
      limitSeconds: 5,
    });
    for (const reason of [null, "something else", "wait limit of x seconds reached"]) {
      const b = setup();
      endedWith(b.store, "timed_out", reason);
      expect(await b.broker.confirmReply(ID, placedBytes)).toEqual({
        kind: "timed_out",
        limitSeconds: undefined,
      });
    }
  });

  it("is ended for any other state that is not waiting", async () => {
    const a = setup();
    endedWith(a.store, "other", null);
    expect(await a.broker.confirmReply(ID, placedBytes)).toEqual({ kind: "ended" });
  });

  it("is pending while the request waits", async () => {
    const a = setup();
    endedWith(a.store, "waiting", null);
    expect(await a.broker.confirmReply(ID, placedBytes)).toEqual({ kind: "pending" });
  });
});

describe("abandoning the requests an earlier run left waiting (BR22)", () => {
  const A = "20261009T100000000Z-aaaaaa";
  const B = "20261009T100001000Z-bbbbbb";
  const C = "20261009T100002000Z-cccccc";

  function addRequest(
    store: FakeStore,
    id: string,
    state: "waiting" | "replied" | "skipped" = "waiting",
  ) {
    store.addRaw(id, {
      request: createRequestFile(id, NOW, request),
      state: createStateFile(id, state, NOW, state === "waiting" ? null : NOW),
    });
  }

  it("lists the ids of the requests that wait, in id order, and no others", async () => {
    const { store, broker } = setup();
    addRequest(store, C);
    addRequest(store, A);
    addRequest(store, B, "replied");
    store.addRaw("20261009T100003000Z-dddddd", { request: "unreadable", state: "unreadable" });
    store.addRaw("20261009T100004000Z-eeeeee", { request: "unreadable", state: "missing" });
    expect(await broker.snapshotWaiting()).toEqual([A, C]);
  });

  it("fails with an IoFailure when the storage cannot be read", async () => {
    const { store, broker } = setup();
    store.fail("listIds");
    await expect(broker.snapshotWaiting()).rejects.toBeInstanceOf(IoFailure);
  });

  it("sets state, endedAt, updatedAt and endReason, one request at a time in the given order", async () => {
    const { store, broker, events, clock } = setup();
    addRequest(store, A);
    addRequest(store, B);
    await broker.abandon([A, B]);
    const expected = createStateFile(
      A,
      "abandoned",
      clock.now().toISOString(),
      clock.now().toISOString(),
      "server restarted",
    );
    expect(store.entries.get(A)?.state).toEqual(expected);
    expect(store.entries.get(B)?.state).toEqual({ ...expected, id: B });
    expect(events).toEqual([
      { type: "abandoned", id: A },
      { type: "abandoned", id: B },
    ]);
  });

  it("reads the state again and leaves a request that is no longer waiting", async () => {
    const { store, broker, events } = setup();
    addRequest(store, A, "replied");
    await broker.abandon([A]);
    expect(stateOf(store, A)).toBe("replied");
    expect(events).toEqual([]);
  });

  it("abandons a request that has a reply file without reading the reply", async () => {
    const { store, broker } = setup();
    addRequest(store, A);
    store.putFile(A, "reply.json", replyBytes("late"));
    await broker.abandon([A]);
    expect(stateOf(store, A)).toBe("abandoned");
    expect(store.count("readReply")).toBe(0);
    await broker.pollOnce();
    expect(stateOf(store, A)).toBe("abandoned");
    expect(store.count("readReply")).toBe(0);
  });

  it("does not touch a request that arrives after the list was made", async () => {
    const { store, broker } = setup();
    addRequest(store, A);
    const snapshot = await broker.snapshotWaiting();
    const later = await submitWaiting(broker);
    await broker.abandon(snapshot);
    expect(stateOf(store, A)).toBe("abandoned");
    expect(stateOf(store, later.id)).toBe("waiting");
  });

  it("keeps a request out of the poll when it could not be abandoned, and says so once", async () => {
    const { store, broker, events } = setup();
    addRequest(store, A);
    store.putFile(A, "reply.json", replyBytes("late"));
    store.fail("writeState", 2);
    await broker.abandon([A]);
    expect(stateOf(store, A)).toBe("waiting");
    expect(events).toEqual([{ type: "error", id: A, reason: "abandon failed" }]);
    await broker.pollOnce();
    expect(stateOf(store, A)).toBe("waiting");
    expect(events.some((event) => event.type === "replied")).toBe(false);
    expect(store.count("readReply")).toBe(0);
  });

  it("tries again every 5 seconds, and stops keeping the request out when it works", async () => {
    const { store, broker, events, clock } = setup();
    addRequest(store, A);
    store.fail("writeState", 1);
    await broker.abandon([A]);
    expect(store.count("writeState")).toBe(1);
    await clock.advance(4999);
    await broker.pollOnce();
    expect(store.count("writeState")).toBe(1);
    await clock.advance(1);
    await broker.pollOnce();
    expect(store.count("writeState")).toBe(2);
    expect(stateOf(store, A)).toBe("abandoned");
    expect(events.filter((event) => event.type === "abandoned")).toEqual([
      { type: "abandoned", id: A },
    ]);
    await clock.advance(10000);
    await broker.pollOnce();
    expect(store.count("writeState")).toBe(2);
  });

  it("goes on trying while it keeps failing, and says the failure only once", async () => {
    const { store, broker, events, clock } = setup();
    addRequest(store, A);
    store.fail("writeState", 3);
    await broker.abandon([A]);
    await clock.advance(5000);
    await broker.pollOnce();
    await clock.advance(5000);
    await broker.pollOnce();
    expect(store.count("writeState")).toBe(3);
    expect(events.filter((event) => event.type === "error")).toHaveLength(1);
    await clock.advance(5000);
    await broker.pollOnce();
    expect(stateOf(store, A)).toBe("abandoned");
  });

  it("still shows the kept-out request in the list for answer", async () => {
    const { store, broker } = setup();
    addRequest(store, A);
    store.fail("writeState", 1);
    await broker.abandon([A]);
    const listing = await broker.listWaiting(new Set());
    expect(listing.waiting.map((item) => item.id)).toEqual([A]);
  });

  it("does not list an abandoned request for answer", async () => {
    const { store, broker } = setup();
    addRequest(store, A);
    addRequest(store, B);
    await broker.abandon([A]);
    const listing = await broker.listWaiting(new Set());
    expect(listing.waiting.map((item) => item.id)).toEqual([B]);
  });
});

describe("what the sweeper learns about a request", () => {
  const ID_1 = "20261009T100000000Z-aaaaaa";

  it("gives the time a request ended for every known state except waiting", async () => {
    for (const state of [
      "replied",
      "skipped",
      "cancelled",
      "timed_out",
      "abandoned",
      "invalid_reply",
    ]) {
      const { store, broker } = setup();
      store.addRaw(ID_1, {
        request: createRequestFile(ID_1, NOW, request),
        state: { ...createStateFile(ID_1, "replied", NOW, NOW), state } as never,
      });
      expect(await broker.finishedAt(ID_1), state).toBe(Date.parse(NOW));
    }
  });

  it("gives nothing for waiting, unreadable, unknown or missing states and for a bad endedAt", async () => {
    const cases: Array<ReturnType<typeof createStateFile> | "unreadable" | "missing"> = [
      createStateFile(ID_1, "waiting", NOW, null),
      "unreadable",
      "missing",
      { ...createStateFile(ID_1, "replied", NOW, NOW), state: "other" },
      createStateFile(ID_1, "replied", NOW, null),
      createStateFile(ID_1, "replied", NOW, "yesterday"),
    ];
    for (const state of cases) {
      const { store, broker } = setup();
      store.addRaw(ID_1, { request: createRequestFile(ID_1, NOW, request), state });
      expect(await broker.finishedAt(ID_1)).toBeUndefined();
    }
  });

  it("passes the failure to read the state on", async () => {
    const { store, broker } = setup();
    store.fail("readState");
    await expect(broker.finishedAt(ID_1)).rejects.toBeInstanceOf(IoFailure);
  });

  it("lists the request ids and removes a request through the store", async () => {
    const { store, broker } = setup();
    store.addRaw(ID_1, {
      request: createRequestFile(ID_1, NOW, request),
      state: createStateFile(ID_1, "replied", NOW, NOW),
    });
    expect(await broker.listRequestIds()).toEqual([ID_1]);
    expect(await broker.removeRequest(ID_1)).toBe("removed");
    expect(await broker.listRequestIds()).toEqual([]);
  });
});
