import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AnswerConsole,
  createReplyReader,
  normalizeReply,
  type ReadResult,
} from "../src/answer/answer-console.js";
import { ExchangeBroker } from "../src/broker/exchange-broker.js";
import { Logger, Screen } from "../src/log.js";
import {
  type ConversationRequest,
  createReplyFile,
  createRequestFile,
  createStateFile,
  type Message,
  serializeFile,
} from "../src/model.js";
import { FakeClock, settle } from "./helpers/fake-clock.js";
import { FakeStore } from "./helpers/fake-store.js";
import { ScriptedReader, type Step } from "./helpers/scripted-reader.js";

const ID = "20261009T140512123Z-a1b2c3";
const ID2 = "20261009T140513000Z-d4e5f6";
const RECEIVED_AT = new Date(2026, 9, 9, 14, 5, 12).toISOString();
const PROMPT = "Type your reply. Finish with Ctrl+D (Windows: Ctrl+Z, then Enter).";
const WAITING = "Waiting for requests... (press Ctrl+C to quit)";

function requestWith(
  conversation: Message[],
  model = "whatever",
  extra: Partial<ConversationRequest> = {},
): ConversationRequest {
  return {
    format: "chat.completions",
    model,
    replyKind: "text",
    requiredShape: null,
    stream: false,
    includeUsage: false,
    conversation,
    originalRequest: { model },
    ...extra,
  };
}

function separator(n: number, total: number, shortId: string): string {
  const head = `--- Request ${n} of ${total} (${shortId}) `;
  return head + "-".repeat(60 - head.length);
}

function setup(steps: Step[]) {
  const store = new FakeStore();
  const clock = new FakeClock();
  const out: string[] = [];
  const err: string[] = [];
  const stdout = { write: (text: string) => out.push(text) };
  const stderr = { write: (text: string) => err.push(text) };
  const logger = new Logger({ out: stdout, err: stderr, clock });
  const makeBroker = () => new ExchangeBroker({ store, clock, pollIntervalMs: 500 });
  const broker = makeBroker();
  const serveBroker = makeBroker();
  const reader = new ScriptedReader(steps);
  const answer = new AnswerConsole({
    broker,
    screen: new Screen(stdout),
    errorScreen: new Screen(stderr),
    logger,
    clock,
    reader,
    pollIntervalMs: 500,
  });
  const controller = new AbortController();
  return {
    store,
    clock,
    reader,
    serveBroker,
    controller,
    addWaiting(
      id = ID,
      conversation: Message[] = [{ role: "user", content: "Hello" }],
      extra: Partial<ConversationRequest> = {},
    ) {
      const request = requestWith(conversation, "whatever", extra);
      store.addRaw(id, {
        request: createRequestFile(id, RECEIVED_AT, request),
        state: createStateFile(id, "waiting", RECEIVED_AT, null),
      });
    },
    start: () => answer.run(controller.signal),
    stdout: () => out.join("").split("\n").slice(0, -1),
    stderr: () => err.join("").split("\n").slice(0, -1),
    raw: () => out.join("") + err.join(""),
    replyBody(id = ID): string | undefined {
      const bytes = store.entries.get(id)?.files.get("reply.json");
      return bytes === undefined ? undefined : (JSON.parse(bytes) as { body: string }).body;
    },
    replyKind(id = ID): string | undefined {
      const bytes = store.entries.get(id)?.files.get("reply.json");
      return bytes === undefined ? undefined : (JSON.parse(bytes) as { kind: string }).kind;
    },
  };
}

describe("when nothing is waiting", () => {
  it("shows one waiting line however long it waits, and exits 130 on Ctrl+C", async () => {
    const t = setup([]);
    const running = t.start();
    await settle();
    for (let index = 0; index < 5; index += 1) {
      await t.clock.advance(500);
    }
    expect(t.stdout()).toEqual([WAITING]);
    t.controller.abort();
    expect(await running).toBe(130);
  });

  it("shows a request that arrives later, and the waiting line again after it is done", async () => {
    const t = setup(["Hi"]);
    const running = t.start();
    await settle();
    t.addWaiting();
    await t.clock.advance(500);
    expect(t.stdout()).toContain(`${separator(1, 1, "a1b2c3")}`);
    await t.serveBroker.pollOnce();
    await t.clock.advance(500);
    expect(t.stdout().filter((line) => line === WAITING)).toHaveLength(2);
    t.controller.abort();
    await running;
  });
});

describe("showing a request", () => {
  it("shows the separator, time, model, reply kind and the conversation with role names", async () => {
    const t = setup([]);
    t.addWaiting(ID, [
      { role: "system", content: "Answer in one line." },
      { role: "developer", content: "Reply in English." },
      { role: "user", content: "Hello.\nSecond line" },
      { role: "assistant", content: "" },
    ]);
    const running = t.start();
    await settle();
    expect(t.stdout()).toEqual([
      separator(1, 1, "a1b2c3"),
      "Received: 2026-10-09 14:05:12",
      "Model:    whatever",
      "Reply:    text",
      "",
      "System:",
      "  Answer in one line.",
      "",
      "Developer:",
      "  Reply in English.",
      "",
      "User:",
      "  Hello.",
      "  Second line",
      "",
      "Assistant:",
      "  (empty)",
      "",
      PROMPT,
    ]);
    t.controller.abort();
    await running;
  });

  it("counts every waiting request and shows the smallest id first", async () => {
    const t = setup([]);
    t.addWaiting(ID2);
    t.addWaiting(ID);
    const running = t.start();
    await settle();
    expect(t.stdout()[0]).toBe(separator(1, 2, "a1b2c3"));
    t.controller.abort();
    await running;
  });

  it("does not show a request that already has a reply file or is finished", async () => {
    const t = setup([]);
    t.addWaiting(ID);
    t.store.putFile(ID, "reply.json", serializeFile(createReplyFile("x", RECEIVED_AT)));
    t.store.addRaw(ID2, {
      request: createRequestFile(ID2, RECEIVED_AT, requestWith([{ role: "user", content: "x" }])),
      state: createStateFile(ID2, "replied", RECEIVED_AT, RECEIVED_AT),
    });
    const running = t.start();
    await settle();
    expect(t.stdout()).toEqual([WAITING]);
    t.controller.abort();
    await running;
  });

  it("tells once that a request it cannot show was skipped", async () => {
    const t = setup([]);
    t.store.addRaw(ID, {
      request: "unsupported",
      state: createStateFile(ID, "waiting", RECEIVED_AT, null),
    });
    const running = t.start();
    await settle();
    await t.clock.advance(1500);
    const notices = t.stdout().filter((line) => line.includes("a1b2c3"));
    expect(notices).toEqual(["Cannot show request a1b2c3: this version does not support it."]);
    expect(t.store.entries.get(ID)?.state).toMatchObject({ state: "waiting" });
    t.controller.abort();
    await running;
  });
});

describe("normalizing the reply", () => {
  it("turns CRLF and CR into LF", () => {
    expect(normalizeReply("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("removes every newline at the end and keeps the ones in the middle", () => {
    expect(normalizeReply("a\n\nb\n\n\n")).toBe("a\n\nb");
    expect(normalizeReply("a\r\nb\r\n")).toBe("a\nb");
  });

  it("keeps spaces, and a reply of only spaces is not empty", () => {
    expect(normalizeReply("  x  \n")).toBe("  x  ");
    expect(normalizeReply("   ")).toBe("   ");
    expect(normalizeReply("\n\n")).toBe("");
  });
});

describe("sending a reply", () => {
  it("places the normalized reply, then shows Sent. when serve accepted it", async () => {
    const t = setup(["line one\r\nline two\r\n"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.replyBody()).toBe("line one\nline two");
    expect(t.stdout()).not.toContain("Sent.");
    await t.serveBroker.pollOnce();
    await t.clock.advance(500);
    expect(t.stdout()).toContain("Sent.");
    t.controller.abort();
    await running;
  });

  it("does not show the same request again after placing a reply", async () => {
    const t = setup(["Hi"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    await t.clock.advance(2000);
    expect(t.reader.calls).toBe(1);
    t.controller.abort();
    await running;
  });

  it("refuses an empty reply, shows a notice, and asks again for the same request", async () => {
    const t = setup(["\n\n", "second try"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.stdout()).toContain("The reply is empty. Type a reply, or press Ctrl+C to quit.");
    expect(t.reader.calls).toBe(2);
    expect(t.replyBody()).toBe("second try");
    t.controller.abort();
    await running;
  });

  it("says Not sent when another window already put a reply", async () => {
    const t = setup([
      () => {
        t.store.putFile(ID, "reply.json", serializeFile(createReplyFile("theirs", RECEIVED_AT)));
        return "mine";
      },
    ]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.stdout()).toContain("Not sent: this request was already answered in another window.");
    expect(t.replyBody()).toBe("theirs");
    t.controller.abort();
    await running;
  });

  it("says Not sent when the accepted reply is not the one this answer wrote", async () => {
    const t = setup(["mine"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    const entry = t.store.entries.get(ID);
    if (entry === undefined) {
      throw new Error("the request should exist");
    }
    entry.files.delete("reply.json");
    entry.files.set("reply.accepted.json", serializeFile(createReplyFile("theirs", RECEIVED_AT)));
    entry.state = createStateFile(ID, "replied", RECEIVED_AT, RECEIVED_AT);
    await t.clock.advance(500);
    expect(t.stdout()).toContain("Not sent: this request was already answered in another window.");
    expect(t.stdout()).not.toContain("Sent.");
    t.controller.abort();
    await running;
  });

  it("shows an error, keeps the request, and shows it again after an I/O failure", async () => {
    const t = setup(["first", "second"]);
    t.addWaiting();
    t.store.fail("placeReply");
    const running = t.start();
    await settle();
    expect(t.stderr()).toEqual(["Error: could not write the reply. input/output error."]);
    expect(t.stdout()).not.toContain(
      "Not sent: this request was already answered in another window.",
    );
    expect(t.replyBody()).toBeUndefined();
    await t.clock.advance(500);
    expect(t.stdout().filter((line) => line.startsWith("--- Request 1 of 1"))).toHaveLength(2);
    expect(t.replyBody()).toBe("second");
    t.controller.abort();
    await running;
  });

  it("keeps waiting when the state cannot be read while confirming", async () => {
    const t = setup(["Hi"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    await t.serveBroker.pollOnce();
    t.store.fail("readState");
    await t.clock.advance(500);
    expect(t.stdout()).not.toContain("Sent.");
    await t.clock.advance(500);
    expect(t.stdout()).toContain("Sent.");
    expect(t.stdout().some((line) => / error {6}a1b2c3 {2}read failed$/.test(line))).toBe(true);
    t.controller.abort();
    await running;
  });
});

describe("a state file that stays unreadable while confirming", () => {
  it("writes one unreadable line, keeps polling, and still shows Sent. once it is readable", async () => {
    const t = setup(["Hi"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    const entry = t.store.entries.get(ID);
    if (entry === undefined) {
      throw new Error("the request is missing");
    }
    entry.state = "unreadable";
    for (let index = 0; index < 3; index += 1) {
      await t.clock.advance(500);
    }
    const failures = t.stdout().filter((line) => line.includes(" error "));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^\d\d:\d\d:\d\d error {6}a1b2c3 {2}unreadable$/);
    expect(t.stdout()).not.toContain("Sent.");
    expect(t.stdout()).not.toContain(
      "Not sent: this request was already answered in another window.",
    );
    entry.state = createStateFile(ID, "waiting", RECEIVED_AT, null);
    await t.serveBroker.pollOnce();
    await t.clock.advance(500);
    expect(t.stdout()).toContain("Sent.");
    t.controller.abort();
    await running;
  });

  it("writes one read failed line when reading the state keeps throwing", async () => {
    const t = setup(["Hi"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    t.store.fail("readState", 3);
    for (let index = 0; index < 3; index += 1) {
      await t.clock.advance(500);
    }
    const failures = t.stdout().filter((line) => line.includes(" error "));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/ error {6}a1b2c3 {2}read failed$/);
    await t.serveBroker.pollOnce();
    await t.clock.advance(500);
    expect(t.stdout()).toContain("Sent.");
    t.controller.abort();
    await running;
  });
});

describe("closed input and Ctrl+C", () => {
  it("stops with Error: input closed. and exit 1 after two end-of-input signals in a row", async () => {
    const t = setup(["EOF", "EOF"]);
    t.addWaiting();
    const exit = await t.start();
    expect(exit).toBe(1);
    expect(t.stderr()).toEqual(["Error: input closed."]);
    expect(t.stdout()).toContain("The reply is empty. Type a reply, or press Ctrl+C to quit.");
    expect(t.replyBody()).toBeUndefined();
    expect(t.store.entries.get(ID)?.state).toMatchObject({ state: "waiting" });
  });

  it("does not count an end-of-input after typed lines as closed input", async () => {
    const t = setup(["EOF", "\n", "EOF", "answer"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.stderr()).toEqual([]);
    expect(t.replyBody()).toBe("answer");
    t.controller.abort();
    await running;
  });

  it("leaves the request waiting and exits 130 when Ctrl+C comes while typing", async () => {
    const t = setup(["INTERRUPT"]);
    t.addWaiting();
    const exit = await t.start();
    expect(exit).toBe(130);
    expect(t.replyBody()).toBeUndefined();
    expect(t.store.entries.get(ID)?.state).toMatchObject({ state: "waiting" });
    expect(t.stdout()).toContain("Quit. Request a1b2c3 is still waiting.");
  });

  it("keeps the placed reply, shows no Sent., and exits 130 on Ctrl+C while confirming", async () => {
    const t = setup(["Hi"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    t.controller.abort();
    expect(await running).toBe(130);
    expect(t.replyBody()).toBe("Hi");
    expect(t.stdout()).not.toContain("Sent.");
  });
});

describe("failures while listing", () => {
  it("writes one failure line and carries on when the storage cannot be read", async () => {
    const t = setup([]);
    t.store.fail("listIds", 3);
    const running = t.start();
    await settle();
    await t.clock.advance(1500);
    const failures = t.stdout().filter((line) => line.includes(" error "));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/^\d\d:\d\d:\d\d error {6}------ {2}read failed$/);
    t.addWaiting();
    await t.clock.advance(500);
    expect(t.stdout().some((line) => line.startsWith("--- Request 1 of 1"))).toBe(true);
    t.controller.abort();
    await running;
  });
});

describe("plain output (NFR14.1, NFR14.2)", () => {
  it("never writes color codes, and every status line starts with its word", async () => {
    const t = setup(["Hi", "INTERRUPT"]);
    t.addWaiting();
    t.addWaiting(ID2);
    const running = t.start();
    await settle();
    await t.serveBroker.pollOnce();
    await t.clock.advance(500);
    await running;
    expect(t.raw().includes("\u001b")).toBe(false);
    expect(t.stdout()).toContain("Sent.");
  });
});

describe("the reply reader", () => {
  function reader(input: Readable) {
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
    return { reader: createReplyReader(input, output, false), written };
  }

  async function read(source: string): Promise<{ result: ReadResult; prompts: number }> {
    const { reader: made, written } = reader(Readable.from([source]));
    const result = await made.readReply(new AbortController().signal);
    return { result, prompts: written.join("").split("> ").length - 1 };
  }

  it("joins the typed lines with newlines and shows a > prompt for each line", async () => {
    const { result, prompts } = await read("one\ntwo\n");
    expect(result).toEqual({ kind: "reply", text: "one\ntwo", gotInput: true });
    expect(prompts).toBeGreaterThanOrEqual(2);
  });

  it("moves to a new line when the input ends, so the next text does not follow the prompt", async () => {
    const { reader: made, written } = reader(Readable.from(["one\n"]));
    await made.readReply(new AbortController().signal);
    await settle();
    expect(written.join("").endsWith("\n")).toBe(true);
  });

  it("also moves to a new line when Ctrl+C interrupts the typing", async () => {
    const input = new PassThrough();
    const { reader: made, written } = reader(input);
    const controller = new AbortController();
    const reading = made.readReply(controller.signal);
    input.write("par");
    controller.abort();
    await reading;
    await settle();
    expect(written.join("").endsWith("\n")).toBe(true);
  });

  it("splits CRLF input into lines", async () => {
    const { result } = await read("one\r\ntwo\r\n");
    expect(result).toEqual({ kind: "reply", text: "one\ntwo", gotInput: true });
  });

  it("keeps empty lines in the middle", async () => {
    const { result } = await read("a\n\nb\n");
    expect(result).toEqual({ kind: "reply", text: "a\n\nb", gotInput: true });
  });

  it("reports input that ended without any text, and again at once the second time", async () => {
    const input = Readable.from([]);
    const { reader: made } = reader(input);
    const signal = new AbortController().signal;
    expect(await made.readReply(signal)).toEqual({ kind: "reply", text: "", gotInput: false });
    expect(await made.readReply(signal)).toEqual({ kind: "reply", text: "", gotInput: false });
  });

  it("returns interrupted when the signal aborts while waiting", async () => {
    const input = new PassThrough();
    const { reader: made } = reader(input);
    const controller = new AbortController();
    const reading = made.readReply(controller.signal);
    input.write("partial");
    controller.abort();
    expect(await reading).toEqual({ kind: "interrupted" });
  });

  it("returns interrupted at once when the signal is already aborted", async () => {
    const { reader: made } = reader(new PassThrough());
    expect(await made.readReply(AbortSignal.abort())).toEqual({ kind: "interrupted" });
  });

  it("returns interrupted when the terminal reports Ctrl+C", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const made = createReplyReader(input, output, true);
    const reading = made.readReply(new AbortController().signal);
    input.write("hel");
    input.write("\u0003");
    expect(await reading).toEqual({ kind: "interrupted" });
  });
});

describe("ending the input with Ctrl+Z and Enter on Windows", () => {
  const CTRL_Z = "\u001a";

  /** A terminal-mode reader fed key by key, as a Windows console would feed it. */
  function windowsReader() {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const reader = createReplyReader(input, output, true, { ctrlZEnds: true });
    const reading = reader.readReply(new AbortController().signal);
    return { input, reading };
  }

  it("ends the reply when Enter follows Ctrl+Z, and keeps the text typed before it", async () => {
    const { input, reading } = windowsReader();
    input.write("abc");
    input.write(CTRL_Z);
    input.write("\r");
    expect(await reading).toEqual({ kind: "reply", text: "abc", gotInput: true });
  });

  it("keeps earlier lines and ends on Ctrl+Z and Enter at the start of a line", async () => {
    const { input, reading } = windowsReader();
    input.write("one\r");
    input.write("two\r");
    input.write(CTRL_Z);
    input.write("\r");
    expect(await reading).toEqual({ kind: "reply", text: "one\ntwo", gotInput: true });
  });

  it("reports no input when nothing was typed before Ctrl+Z and Enter", async () => {
    const { input, reading } = windowsReader();
    input.write(CTRL_Z);
    input.write("\r");
    expect(await reading).toEqual({ kind: "reply", text: "", gotInput: false });
  });

  it("does not end the reply when another key comes between Ctrl+Z and Enter", async () => {
    const { input, reading } = windowsReader();
    input.write(CTRL_Z);
    input.write("x");
    input.write("\r");
    input.write("more\r");
    input.write(CTRL_Z);
    input.write("\r");
    expect(await reading).toEqual({ kind: "reply", text: "x\nmore", gotInput: true });
  });
});

describe("a request that asks for JSON", () => {
  const SHAPE = {
    type: "object",
    properties: { passed: { type: "boolean" } },
    required: ["passed"],
  };
  const JSON_PROMPT = "Type the JSON. Finish with Ctrl+D (Windows: Ctrl+Z, then Enter).";

  it("shows the reply kind, the required shape in a nested layout, and the JSON prompt", async () => {
    const t = setup([]);
    t.addWaiting(ID, [{ role: "user", content: "Did the login succeed?" }], {
      replyKind: "json",
      requiredShape: SHAPE,
    });
    const running = t.start();
    await settle();
    expect(t.stdout()).toEqual([
      separator(1, 1, "a1b2c3"),
      "Received: 2026-10-09 14:05:12",
      "Model:    whatever",
      "Reply:    JSON",
      "",
      "User:",
      "  Did the login succeed?",
      "",
      "Required shape:",
      "  {",
      '    "type": "object",',
      '    "properties": {',
      '      "passed": {',
      '        "type": "boolean"',
      "      }",
      "    },",
      '    "required": [',
      '      "passed"',
      "    ]",
      "  }",
      "",
      JSON_PROMPT,
    ]);
    t.controller.abort();
    await running;
  });

  it("says any JSON value is accepted when no shape was asked for", async () => {
    const t = setup([]);
    t.addWaiting(ID, [{ role: "user", content: "Hi" }], { replyKind: "json" });
    const running = t.start();
    await settle();
    const lines = t.stdout();
    expect(lines).toContain("Any JSON value is accepted as long as it is valid JSON.");
    expect(lines).not.toContain("Required shape:");
    expect(lines.at(-1)).toBe(JSON_PROMPT);
    expect(lines.at(-2)).toBe("");
    t.controller.abort();
    await running;
  });

  it("places a valid JSON reply exactly as typed, with kind json", async () => {
    const t = setup(['{ "passed":   true }\r\n']);
    t.addWaiting(ID, undefined, { replyKind: "json", requiredShape: SHAPE });
    const running = t.start();
    await settle();
    expect(t.replyBody()).toBe('{ "passed":   true }');
    expect(t.replyKind()).toBe("json");
    await t.serveBroker.pollOnce();
    await t.clock.advance(500);
    expect(t.stdout()).toContain("Sent.");
    t.controller.abort();
    await running;
  });

  it("does not send a reply that is not valid JSON, and asks again for the same request", async () => {
    const seen: (string | undefined)[] = [];
    const t = setup([
      '{"passed":',
      () => {
        seen.push(t.replyBody());
        return '{"passed": true}';
      },
    ]);
    t.addWaiting(ID, undefined, { replyKind: "json", requiredShape: SHAPE });
    const running = t.start();
    await settle();
    expect(seen).toEqual([undefined]);
    const lines = t.stdout();
    const at = lines.indexOf(
      "Not sent: your reply is not valid JSON (unexpected end of input at line 1).",
    );
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe(
      "Type the JSON again. Finish with Ctrl+D (Windows: Ctrl+Z, then Enter).",
    );
    expect(lines.filter((line) => line.startsWith("--- Request"))).toHaveLength(1);
    expect(t.reader.calls).toBe(2);
    expect(t.store.entries.get(ID)?.state).toMatchObject({ state: "waiting" });
    expect(t.replyBody()).toBe('{"passed": true}');
    t.controller.abort();
    await running;
  });

  it("keeps asking after several bad replies, and never prints what was typed (NFR10.2)", async () => {
    const t = setup(['{"secret-token": ZQZ}', "secret-token", '{"a": 1} secret-token', "42"]);
    t.addWaiting(ID, undefined, { replyKind: "json" });
    const running = t.start();
    await settle();
    expect(t.reader.calls).toBe(4);
    expect(t.replyBody()).toBe("42");
    expect(t.raw()).not.toMatch(/secret-token|ZQZ/);
    expect(t.stdout()).toContain(
      "Not sent: your reply is not valid JSON (unexpected character at line 1, column 18).",
    );
    t.controller.abort();
    await running;
  });

  it("sends a reply that does not match the required shape as typed", async () => {
    const t = setup(['{"reason": "x"}']);
    t.addWaiting(ID, undefined, { replyKind: "json", requiredShape: SHAPE });
    const running = t.start();
    await settle();
    expect(t.replyBody()).toBe('{"reason": "x"}');
    expect(t.stdout().some((line) => line.startsWith("Not sent: your reply is not valid"))).toBe(
      false,
    );
    t.controller.abort();
    await running;
  });

  it("handles an empty reply first, with the empty-reply notice and not a JSON error", async () => {
    const t = setup(["\n\n", "[]"]);
    t.addWaiting(ID, undefined, { replyKind: "json" });
    const running = t.start();
    await settle();
    expect(t.stdout()).toContain("The reply is empty. Type a reply, or press Ctrl+C to quit.");
    expect(t.stdout().some((line) => line.startsWith("Not sent: your reply is not valid"))).toBe(
      false,
    );
    expect(t.replyBody()).toBe("[]");
    t.controller.abort();
    await running;
  });

  it("does not check a text request, which accepts text that is not JSON", async () => {
    const t = setup(['{"passed":']);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.replyBody()).toBe('{"passed":');
    expect(t.replyKind()).toBe("text");
    t.controller.abort();
    await running;
  });
});

describe("a long conversation and unsafe text", () => {
  const FILE = `/fake-storage/requests/${ID}/request.json`;

  function users(count: number, first = 1): Message[] {
    return Array.from({ length: count }, (_, index) => ({
      role: "user" as const,
      content: `user ${first + index}`,
    }));
  }

  async function shown(
    conversation: Message[],
    extra: Partial<ConversationRequest> = {},
    model?: string,
  ): Promise<string[]> {
    const t = setup([]);
    t.addWaiting(ID, conversation, extra);
    if (model !== undefined) {
      const entry = t.store.entries.get(ID);
      if (entry !== undefined && typeof entry.request === "object") {
        entry.request.model = model;
      }
    }
    const running = t.start();
    await settle();
    const lines = t.stdout();
    t.controller.abort();
    await running;
    return lines;
  }

  it("shows the system message and the last three others, and says where the full text is", async () => {
    const lines = await shown([{ role: "system", content: "rules" }, ...users(6)]);
    expect(lines.slice(5, 17)).toEqual([
      "System:",
      "  rules",
      "",
      `(3 earlier messages omitted. Full conversation: ${FILE})`,
      "",
      "User:",
      "  user 4",
      "",
      "User:",
      "  user 5",
      "",
      "User:",
    ]);
    expect(lines.join("\n")).not.toContain("user 3");
  });

  it("shows every system and developer message, and the last three of the other five", async () => {
    const lines = await shown([
      { role: "system", content: "rules" },
      { role: "developer", content: "style" },
      ...users(5),
    ]);
    const text = lines.join("\n");
    expect(text).toContain("  rules");
    expect(text).toContain("  style");
    expect(text).toContain("  user 5");
    expect(text).toContain("  user 3");
    expect(text).not.toContain("  user 2");
    expect(text).toContain("(2 earlier messages omitted.");
  });

  it("omits nothing for exactly three other messages and one message for four", async () => {
    const three = (await shown(users(3))).join("\n");
    expect(three).not.toContain("omitted");
    const four = (await shown(users(4))).join("\n");
    expect(four).toContain(`(1 earlier message omitted. Full conversation: ${FILE})`);
    expect(four).not.toContain("user 1\n");
  });

  it("writes one omission line when a developer message sits between the omitted ones", async () => {
    const lines = await shown([
      { role: "user", content: "u1" },
      { role: "developer", content: "d1" },
      ...users(4, 2),
    ]);
    expect(lines.filter((line) => line.includes("earlier message"))).toEqual([
      `(2 earlier messages omitted. Full conversation: ${FILE})`,
    ]);
  });

  it("shows control characters in a visible form and writes none of them", async () => {
    const t = setup([]);
    t.addWaiting(ID, [{ role: "user", content: "\x1b[31mred\x1b[0m\x07 bell\x7f\x9b" }]);
    const running = t.start();
    await settle();
    t.controller.abort();
    await running;
    expect(t.stdout()).toContain("  \\x1b[31mred\\x1b[0m\\x07 bell\\x7f\\x9b");
    const forbidden = [...t.raw()].filter((char) => {
      const code = char.charCodeAt(0);
      return (code < 0x20 && char !== "\n") || (code >= 0x7f && code <= 0x9f);
    });
    expect(forbidden).toEqual([]);
  });

  it("shows (empty) for an empty message", async () => {
    const lines = await shown([{ role: "user", content: "" }]);
    expect(lines).toContain("  (empty)");
  });

  it("cuts a message of 1000 lines at 200 lines", async () => {
    const content = Array.from({ length: 1000 }, (_, index) => `line ${index + 1}`).join("\n");
    const lines = await shown([{ role: "user", content }]);
    expect(lines).toContain("  line 200");
    expect(lines).not.toContain("  line 201");
    expect(lines).toContain(`  (800 more lines omitted. Full conversation: ${FILE})`);
  });

  it("replaces control characters in the required shape and in the model name", async () => {
    const lines = await shown(
      [{ role: "user", content: "Hi" }],
      { replyKind: "json", requiredShape: { description: "a\x9bb" } },
      "gpt\n\x1b[2Jx",
    );
    expect(lines).toContain("Model:    gpt\\x0a\\x1b[2Jx");
    expect(lines).toContain('    "description": "a\\x9bb"');
  });

  it("keeps the first lines and the reply kind as before", async () => {
    const lines = await shown(users(5), { replyKind: "json" });
    expect(lines.slice(0, 4)).toEqual([
      separator(1, 1, "a1b2c3"),
      "Received: 2026-10-09 14:05:12",
      "Model:    whatever",
      "Reply:    JSON",
    ]);
  });
});
