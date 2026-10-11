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

function setup() {
  const store = new FakeStore();
  const clock = new FakeClock();
  const events: BrokerEvent[] = [];
  const broker = new ExchangeBroker({ store, clock, pollIntervalMs: 500 });
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

  it("recovers when writing state.json fails after the link was made (NFR13.3)", async () => {
    const { store, broker, events } = setup();
    const { id, outcomeOf } = await submitWaiting(broker);
    store.putFile(id, "reply.json", replyBytes("Hi"));
    store.fail("writeState");
    await broker.pollOnce();
    await settle();
    expect(stateOf(store, id)).toBe("waiting");
    expect(outcomeOf()).toBeUndefined();
    expect(events).toEqual([{ type: "error", id, reason: "write failed" }]);
    await broker.pollOnce();
    await settle();
    expect(stateOf(store, id)).toBe("replied");
    expect(outcomeOf()).toEqual({ kind: "replied", id, body: "Hi" });
    expect(events.slice(1)).toEqual([
      { type: "recovered", id },
      { type: "replied", id },
    ]);
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

  it("does not accept a reply of a kind it does not know", async () => {
    const { store, broker, events } = setup();
    const { id } = await submitWaiting(broker);
    store.putFile(id, "reply.json", serializeFile({ formatVersion: 1, kind: "skip", body: "{}" }));
    await broker.pollOnce();
    expect(stateOf(store, id)).toBe("waiting");
    expect(store.count("acceptReply")).toBe(0);
    expect(events).toEqual([]);
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
    expect(await broker.confirmReply(id, placed.bytes)).toBe("pending");
    await broker.pollOnce();
    expect(await broker.confirmReply(id, placed.bytes)).toBe("confirmed");
    expect(await broker.confirmReply(id, `${placed.bytes} `)).toBe("not-ours");
    expect(stateOf(store, id)).toBe("replied");
  });

  it("answers not-ours when the state is something else", async () => {
    const { store, broker } = setup();
    const id = "20260101T000001000Z-000001";
    store.addRaw(id, {
      request: createRequestFile(id, NOW, request),
      state: { ...createStateFile(id, "replied", NOW, NOW), state: "other" },
    });
    expect(await broker.confirmReply(id, "x")).toBe("not-ours");
  });

  it("answers unreadable when the state.json content cannot be read", async () => {
    const { store, broker } = setup();
    const id = "20260101T000001000Z-000001";
    store.addRaw(id, {
      request: createRequestFile(id, NOW, request),
      state: "unreadable",
    });
    expect(await broker.confirmReply(id, "x")).toBe("unreadable");
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
