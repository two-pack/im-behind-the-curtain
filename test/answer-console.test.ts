import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  AnswerConsole,
  createReplyReader,
  normalizeReply,
  type ReadResult,
  type ServeStatus,
} from "../src/answer/answer-console.js";
import { ExchangeBroker } from "../src/broker/exchange-broker.js";
import { Logger, Screen } from "../src/log.js";
import {
  type ConversationRequest,
  createReplyFile,
  createRequestFile,
  createStateFile,
  MAX_FILE_BYTES,
  type Message,
  serializeFile,
} from "../src/model.js";
import type { AnswerInputMode } from "../src/platform.js";
import { FakeClock, settle } from "./helpers/fake-clock.js";
import { FakeStore } from "./helpers/fake-store.js";
import { ScriptedReader, type StdinStep, type Step } from "./helpers/scripted-reader.js";

const ID = "20261009T140512123Z-a1b2c3";
const ID2 = "20261009T140513000Z-d4e5f6";
const RECEIVED_AT = new Date(2026, 9, 9, 14, 5, 12).toISOString();
const PROMPT = "Type your reply. Finish with Ctrl+D (Windows: Ctrl+Z, then Enter).";
const WAITING = "Waiting for requests... (press Ctrl+C to quit)";
const NOT_SENT = "Not sent: this request was already answered in another window.";
const SKIP_PROMPT = "Skip this request? The client will receive an error. [y/N] ";
const CANCELLED = "Cancelled: the client disconnected. Your reply will not be sent.";

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

const STORAGE_DIR = "/home/alice/.local/share/imbehind";

interface SetupOptions {
  /** Left out, the screen is built without a mode, which must mean `interactive`. */
  inputMode?: AnswerInputMode;
  stdin?: StdinStep[];
}

function setup(
  steps: Step[],
  store = new FakeStore(),
  serveStatus: ServeStatus = { kind: "running" },
  options: SetupOptions = {},
) {
  const clock = new FakeClock();
  const out: string[] = [];
  const err: string[] = [];
  const stdout = { write: (text: string) => out.push(text) };
  const stderr = { write: (text: string) => err.push(text) };
  const logger = new Logger({ out: stdout, err: stderr, clock });
  let serveChecks = 0;
  const makeBroker = () => new ExchangeBroker({ store, clock, pollIntervalMs: 500 });
  const broker = makeBroker();
  const serveBroker = makeBroker();
  const reader = new ScriptedReader(steps, (text) => out.push(`${text}\n`), options.stdin);
  const answer = new AnswerConsole({
    broker,
    screen: new Screen(stdout),
    errorScreen: new Screen(stderr),
    logger,
    clock,
    reader,
    pollIntervalMs: 500,
    storageDir: STORAGE_DIR,
    checkServe: async () => {
      serveChecks += 1;
      return serveStatus;
    },
    ...(options.inputMode === undefined ? {} : { inputMode: options.inputMode }),
  });
  const controller = new AbortController();
  return {
    serveChecks: () => serveChecks,
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

describe("the check that a serve runs", () => {
  it("ends with exit 1 and the two lines of A-10 on standard error when serve is not running", async () => {
    const t = setup([], new FakeStore(), { kind: "not-running" });
    t.addWaiting();
    expect(await t.start()).toBe(1);
    expect(t.stderr()).toEqual([
      `Error: imbehind serve is not running for ${STORAGE_DIR}.`,
      "Start it with: imbehind serve",
    ]);
    expect(t.stdout()).toEqual([]);
  });

  it("ends with exit 1 and one line when the storage directory cannot be read", async () => {
    const t = setup([], new FakeStore(), { kind: "unreadable", detail: "permission denied" });
    expect(await t.start()).toBe(1);
    expect(t.stderr()).toEqual([`Error: cannot read ${STORAGE_DIR}: permission denied.`]);
    expect(t.stdout()).toEqual([]);
  });

  it("keeps an unreadable serve.lock apart from a missing or foreign one: one line with the reason, never the not-running lines", async () => {
    for (const detail of ["input/output error", "not a directory"]) {
      const t = setup([], new FakeStore(), { kind: "unreadable", detail });
      t.addWaiting();
      expect(await t.start()).toBe(1);
      expect(t.stderr()).toEqual([`Error: cannot read ${STORAGE_DIR}: ${detail}.`]);
      expect(t.stdout()).toEqual([]);
    }
  });

  it("looks at nothing in the storage when it ends, and asks only once", async () => {
    const t = setup([], new FakeStore(), { kind: "not-running" });
    await t.start();
    expect(t.serveChecks()).toBe(1);
    expect(t.store.count("listIds")).toBe(0);
    expect(t.store.count("readState")).toBe(0);
  });

  it("shows the requests as before when serve is running, and asks only once", async () => {
    const t = setup([]);
    const running = t.start();
    await settle();
    t.controller.abort();
    expect(await running).toBe(130);
    expect(t.serveChecks()).toBe(1);
    expect(t.stdout()).toEqual([WAITING]);
    expect(t.stderr()).toEqual([]);
  });
});

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

  it("says Not sent when another window already put a reply, once serve has used it", async () => {
    const t = setup([
      () => {
        t.store.putFile(ID, "reply.json", serializeFile(createReplyFile("theirs", RECEIVED_AT)));
        return "mine";
      },
    ]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.stdout()).not.toContain(NOT_SENT);
    expect(t.replyBody()).toBe("theirs");
    await t.serveBroker.pollOnce();
    await t.clock.advance(500);
    expect(t.stdout()).toContain(NOT_SENT);
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
  it("stops with exit 1 and a clear line when the input ends at the skip question", async () => {
    const t = setup(["EOF", "EOF"]);
    t.addWaiting();
    const exit = await t.start();
    expect(exit).toBe(1);
    expect(t.stderr()).toEqual([
      "Error: input ended. Nothing was sent; the request is still waiting.",
    ]);
    expect(t.reader.asked).toEqual([SKIP_PROMPT]);
    expect(t.replyBody()).toBeUndefined();
    expect(t.store.entries.get(ID)?.state).toMatchObject({ state: "waiting" });
  });

  it("goes back to typing when the skip question is answered with no, and keeps no count of earlier ends", async () => {
    const t = setup(["EOF", "n", "EOF", "", "answer"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.stderr()).toEqual([]);
    expect(t.reader.asked).toEqual([SKIP_PROMPT, SKIP_PROMPT]);
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

const ID3 = "20261009T140514000Z-0a0b0c";
const ID4 = "20261009T140515000Z-0d0e0f";

type Setup = ReturnType<typeof setup>;

/** Ends a request the way serve does, so the screen can see it in state.json. */
function end(t: Setup, id: string, state: "cancelled" | "timed_out" | "replied", reason?: string) {
  const entry = t.store.entries.get(id);
  if (entry === undefined) {
    throw new Error("the request should exist");
  }
  entry.state = createStateFile(id, state, RECEIVED_AT, RECEIVED_AT, reason ?? null);
}

describe("the order of the requests", () => {
  it("shows the request with the smallest id first, whatever order they were stored in", async () => {
    const t = setup([]);
    t.addWaiting(ID3);
    t.addWaiting(ID);
    t.addWaiting(ID2);
    const running = t.start();
    await settle();
    expect(t.stdout()[0]).toBe(separator(1, 3, "a1b2c3"));
    t.controller.abort();
    await running;
  });

  it("shows the smaller id first when the arrival times are the same", async () => {
    const t = setup([]);
    t.addWaiting(ID2);
    t.addWaiting(ID);
    const running = t.start();
    await settle();
    expect(t.stdout()[0]).toBe(separator(1, 2, "a1b2c3"));
    expect(t.store.entries.get(ID)?.request).toMatchObject({ receivedAt: RECEIVED_AT });
    expect(t.store.entries.get(ID2)?.request).toMatchObject({ receivedAt: RECEIVED_AT });
    t.controller.abort();
    await running;
  });

  it("counts again after a reply: the next request is shown with the new count", async () => {
    const t = setup(["a", "b"]);
    t.addWaiting(ID);
    t.addWaiting(ID2);
    const running = t.start();
    await settle();
    t.addWaiting(ID3);
    await t.serveBroker.pollOnce();
    await t.clock.advance(500);
    const separators = t.stdout().filter((line) => line.startsWith("--- Request"));
    expect(separators).toEqual([separator(1, 2, "a1b2c3"), separator(1, 2, "d4e5f6")]);
    t.controller.abort();
    await running;
  });
});

describe("skipping a request", () => {
  it("asks before skipping when nothing was typed, and places a skip reply for y", async () => {
    const t = setup(["EOF", "y"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.reader.asked).toEqual([SKIP_PROMPT]);
    expect(t.replyKind()).toBe("skip");
    expect(t.replyBody()).toBe("");
    expect(t.stdout()).not.toContain("Skipped.");
    await t.serveBroker.pollOnce();
    await t.clock.advance(500);
    expect(t.stdout()).toContain("Skipped.");
    expect(t.stdout()).not.toContain("Sent.");
    t.controller.abort();
    await running;
  });

  it("skips for an upper case Y too", async () => {
    const t = setup(["EOF", "Y"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.replyKind()).toBe("skip");
    t.controller.abort();
    await running;
  });

  it("does not skip for Enter alone, n or any other answer, and asks for the reply again", async () => {
    for (const answer of ["", "n", "N", "yes", " y", "ok"]) {
      const t = setup(["EOF", answer, "typed"]);
      t.addWaiting();
      const running = t.start();
      await settle();
      expect(t.replyKind()).toBe("text");
      expect(t.replyBody()).toBe("typed");
      expect(t.reader.calls).toBe(2);
      t.controller.abort();
      await running;
    }
  });

  it("still refuses a reply that only has empty lines, without asking to skip", async () => {
    const t = setup(["\n\n", "typed"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.reader.asked).toEqual([]);
    expect(t.stdout()).toContain("The reply is empty. Type a reply, or press Ctrl+C to quit.");
    t.controller.abort();
    await running;
  });

  it("asks to skip a request for JSON too", async () => {
    const t = setup(["EOF", "y"]);
    t.addWaiting(ID, undefined, { replyKind: "json" });
    const running = t.start();
    await settle();
    expect(t.replyKind()).toBe("skip");
    t.controller.abort();
    await running;
  });

  it("leaves the request waiting and exits 130 on Ctrl+C at the question", async () => {
    const t = setup(["EOF", "INTERRUPT"]);
    t.addWaiting();
    const exit = await t.start();
    expect(exit).toBe(130);
    expect(t.stdout()).toContain("Quit. Request a1b2c3 is still waiting.");
    expect(t.replyBody()).toBeUndefined();
    expect(t.store.entries.get(ID)?.state).toMatchObject({ state: "waiting" });
  });

  it("says another window answered first when the question is answered after that", async () => {
    const t = setup([
      "EOF",
      () => {
        const entry = t.store.entries.get(ID);
        entry?.files.set(
          "reply.accepted.json",
          serializeFile(createReplyFile("theirs", RECEIVED_AT)),
        );
        end(t, ID, "replied");
        return "y";
      },
    ]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.stdout()).toContain(NOT_SENT);
    expect(t.stdout()).not.toContain("Skipped.");
    expect(t.replyKind()).toBeUndefined();
    t.controller.abort();
    await running;
  });
});

describe("a request that ends while the person is busy", () => {
  it("tells at once, stops the typing and goes on to the next request when the client left", async () => {
    const t = setup(["WAIT", "WAIT"]);
    t.addWaiting(ID);
    t.addWaiting(ID2);
    const running = t.start();
    await settle();
    expect(t.stdout()).not.toContain(CANCELLED);
    end(t, ID, "cancelled", "client disconnected");
    await t.clock.advance(500);
    const lines = t.stdout();
    expect(lines).toContain(CANCELLED);
    expect(lines.indexOf(CANCELLED)).toBeLessThan(lines.indexOf(separator(1, 1, "d4e5f6")));
    expect(t.replyBody(ID)).toBeUndefined();
    expect(t.reader.calls).toBe(2);
    t.controller.abort();
    expect(await running).toBe(130);
  });

  it("tells the wait limit that was used when the request timed out", async () => {
    const t = setup(["WAIT"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    end(t, ID, "timed_out", "wait limit of 30 seconds reached");
    await t.clock.advance(500);
    expect(t.stdout()).toContain(
      "Timed out: the request waited longer than 30 seconds. Your reply will not be sent.",
    );
    t.controller.abort();
    await running;
  });

  it("tells the timeout without a number when the end reason cannot be read", async () => {
    const t = setup(["WAIT"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    end(t, ID, "timed_out", "unknown");
    await t.clock.advance(500);
    expect(t.stdout()).toContain(
      "Timed out: the request waited longer than the wait limit. Your reply will not be sent.",
    );
    t.controller.abort();
    await running;
  });

  it("tells at the skip question, without Skipped., and goes on", async () => {
    const t = setup(["EOF", "WAIT"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.reader.asked).toEqual([SKIP_PROMPT]);
    end(t, ID, "cancelled", "client disconnected");
    await t.clock.advance(500);
    expect(t.stdout()).toContain(CANCELLED);
    expect(t.stdout()).not.toContain("Skipped.");
    expect(t.stdout().filter((line) => line === WAITING)).toHaveLength(1);
    t.controller.abort();
    await running;
  });

  it("tells while the reply is being sent, without Sent., and goes on", async () => {
    const t = setup(["Hi"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.replyBody()).toBe("Hi");
    end(t, ID, "cancelled", "client disconnected");
    await t.clock.advance(500);
    expect(t.stdout()).toContain(CANCELLED);
    expect(t.stdout()).not.toContain("Sent.");
    t.controller.abort();
    await running;
  });

  it("tells the wait limit after a skip was placed", async () => {
    const t = setup(["EOF", "y"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    end(t, ID, "timed_out", "wait limit of 2 seconds reached");
    await t.clock.advance(500);
    expect(t.stdout()).toContain(
      "Timed out: the request waited longer than 2 seconds. Your reply will not be sent.",
    );
    expect(t.stdout()).not.toContain("Skipped.");
    t.controller.abort();
    await running;
  });

  it("does not interrupt the typing when another window answered; it tells when the typing ends", async () => {
    const t = setup(["WAIT", "later"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    t.store.entries
      .get(ID)
      ?.files.set("reply.accepted.json", serializeFile(createReplyFile("theirs", RECEIVED_AT)));
    end(t, ID, "replied");
    await t.clock.advance(1500);
    expect(t.stdout()).not.toContain(NOT_SENT);
    expect(t.reader.calls).toBe(1);
    t.controller.abort();
    await running;
  });

  it("stops watching when the typing is over: no timer is left behind", async () => {
    const t = setup(["WAIT"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.clock.sleeping).toBe(1);
    t.controller.abort();
    await running;
    expect(t.clock.sleeping).toBe(0);
  });

  it("writes one error line and goes on watching when the state cannot be read during the typing", async () => {
    const t = setup(["WAIT"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    t.store.fail("readState", 2);
    await t.clock.advance(1000);
    const failures = t.stdout().filter((line) => line.includes(" error "));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/ error {6}a1b2c3 {2}read failed$/);
    end(t, ID, "cancelled", "client disconnected");
    await t.clock.advance(500);
    expect(t.stdout()).toContain(CANCELLED);
    t.controller.abort();
    await running;
  });
});

describe("new requests while the person types", () => {
  const NEW = (count: number) => `New request received. ${count} requests are waiting.`;

  it("says how many requests are waiting and keeps the typing going", async () => {
    const t = setup(["WAIT"]);
    t.addWaiting(ID);
    const running = t.start();
    await settle();
    t.addWaiting(ID2);
    await t.clock.advance(500);
    expect(t.stdout()).toContain(NEW(2));
    expect(t.reader.calls).toBe(1);
    expect(t.stdout().filter((line) => line.startsWith("--- Request"))).toHaveLength(1);
    t.controller.abort();
    await running;
  });

  it("writes one line for several new requests, with the count now", async () => {
    const t = setup(["WAIT"]);
    t.addWaiting(ID);
    const running = t.start();
    await settle();
    t.addWaiting(ID2);
    t.addWaiting(ID3);
    t.addWaiting(ID4);
    await t.clock.advance(500);
    expect(t.stdout().filter((line) => line.startsWith("New request"))).toEqual([NEW(4)]);
    t.controller.abort();
    await running;
  });

  it("says nothing again for a request it already told about, or when requests only go away", async () => {
    const t = setup(["WAIT"]);
    t.addWaiting(ID);
    t.addWaiting(ID2);
    const running = t.start();
    await settle();
    await t.clock.advance(1500);
    expect(t.stdout().filter((line) => line.startsWith("New request"))).toEqual([]);
    end(t, ID2, "cancelled", "client disconnected");
    await t.clock.advance(500);
    expect(t.stdout().filter((line) => line.startsWith("New request"))).toEqual([]);
    t.addWaiting(ID3);
    await t.clock.advance(500);
    await t.clock.advance(500);
    expect(t.stdout().filter((line) => line.startsWith("New request"))).toEqual([NEW(2)]);
    t.controller.abort();
    await running;
  });

  it("tells when one request came and another went in the same time (the count stays the same)", async () => {
    const t = setup(["WAIT"]);
    t.addWaiting(ID);
    t.addWaiting(ID2);
    const running = t.start();
    await settle();
    end(t, ID2, "cancelled", "client disconnected");
    t.addWaiting(ID3);
    await t.clock.advance(500);
    expect(t.stdout().filter((line) => line.startsWith("New request"))).toEqual([NEW(2)]);
    t.controller.abort();
    await running;
  });

  it("counts the shown request while its state is waiting, even when another window put a reply on it", async () => {
    const t = setup(["WAIT"]);
    t.addWaiting(ID);
    const running = t.start();
    await settle();
    // Another window put a reply on the shown request (it is still waiting), and a new one came.
    t.store.entries
      .get(ID)
      ?.files.set("reply.json", serializeFile(createReplyFile("x", RECEIVED_AT)));
    t.addWaiting(ID2);
    await t.clock.advance(500);
    expect(t.stdout().filter((line) => line.startsWith("New request"))).toEqual([NEW(2)]);
    t.controller.abort();
    await running;
  });

  it("does not count the shown request once its state has left waiting", async () => {
    const t = setup(["WAIT"]);
    t.addWaiting(ID);
    const running = t.start();
    await settle();
    t.store.entries
      .get(ID)
      ?.files.set("reply.accepted.json", serializeFile(createReplyFile("x", RECEIVED_AT)));
    end(t, ID, "replied");
    t.addWaiting(ID2);
    await t.clock.advance(500);
    expect(t.stdout().filter((line) => line.startsWith("New request"))).toEqual([]);
    t.controller.abort();
    await running;
  });

  it("still tells once about a request it cannot show that arrives while the person types", async () => {
    const t = setup(["WAIT"]);
    t.addWaiting(ID);
    const running = t.start();
    await settle();
    t.store.addRaw(ID2, {
      request: "unsupported",
      state: createStateFile(ID2, "waiting", RECEIVED_AT, null),
    });
    await t.clock.advance(1500);
    const notices = t.stdout().filter((line) => line.includes("d4e5f6"));
    expect(notices).toEqual(["Cannot show request d4e5f6: this version does not support it."]);
    expect(t.stdout().filter((line) => line.startsWith("New request"))).toEqual([]);
    t.controller.abort();
    await running;
  });

  it("also tells while the skip question is open", async () => {
    const t = setup(["EOF", "WAIT"]);
    t.addWaiting(ID);
    const running = t.start();
    await settle();
    t.addWaiting(ID2);
    await t.clock.advance(500);
    expect(t.stdout()).toContain(NEW(2));
    t.controller.abort();
    await running;
  });
});

describe("what the screen says about the reply it placed", () => {
  it("says the request has already ended for a state it does not know", async () => {
    const t = setup(["Hi"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    const entry = t.store.entries.get(ID);
    if (entry !== undefined) {
      entry.state = { ...createStateFile(ID, "replied", RECEIVED_AT, RECEIVED_AT), state: "other" };
    }
    await t.clock.advance(500);
    expect(t.stdout()).toContain("Not sent: this request has already ended.");
    t.controller.abort();
    await running;
  });

  it("does not show a request that has already timed out", async () => {
    const t = setup(["Hi"]);
    t.addWaiting();
    end(t, ID, "timed_out", "wait limit of 5 seconds reached");
    const running = t.start();
    await settle();
    // A request that is not waiting is not shown at all.
    expect(t.stdout()).toEqual([WAITING]);
    expect(t.reader.calls).toBe(0);
    t.controller.abort();
    await running;
  });

  it("waits for as long as the request still waits, however many reads it takes", async () => {
    const t = setup(["Hi"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    for (let round = 0; round < 20; round += 1) {
      await t.clock.advance(500);
    }
    expect(t.stdout()).not.toContain("Sent.");
    await t.serveBroker.pollOnce();
    await t.clock.advance(500);
    expect(t.stdout()).toContain("Sent.");
    t.controller.abort();
    await running;
  });

  it("leaves a request alone that was left with Ctrl+C, and shows it again to the next screen", async () => {
    const t = setup(["INTERRUPT"]);
    t.addWaiting();
    expect(await t.start()).toBe(130);
    expect(t.store.entries.get(ID)?.state).toMatchObject({ state: "waiting" });
    const next = setup(["WAIT"], t.store);
    const running = next.start();
    await settle();
    expect(next.stdout()[0]).toBe(separator(1, 1, "a1b2c3"));
    next.controller.abort();
    await running;
  });
});

describe("asking one question and showing a line while typing", () => {
  function terminal() {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk: Buffer) => written.push(chunk.toString("utf8")));
    return { input, output, written, text: () => written.join("") };
  }

  it("reads one line and writes the question, as a terminal would show it", async () => {
    const t = terminal();
    const reader = createReplyReader(t.input, t.output, true);
    const reading = reader.readLine("Skip? [y/N] ", new AbortController().signal);
    t.input.write("y\r");
    expect(await reading).toEqual({ kind: "line", text: "y" });
    expect(t.text()).toContain("Skip? [y/N] ");
  });

  it("reads one line from a plain stream of lines, one question after the other", async () => {
    const reader = createReplyReader(Readable.from(["y\nn\n"]), new PassThrough(), false);
    const signal = new AbortController().signal;
    expect(await reader.readLine("first? ", signal)).toEqual({ kind: "line", text: "y" });
  });

  it("says the input ended when the end-of-input key is pressed, and moves to a new line", async () => {
    const t = terminal();
    const reader = createReplyReader(t.input, t.output, true);
    const reading = reader.readLine("Skip? [y/N] ", new AbortController().signal);
    t.input.write("\u0004");
    expect(await reading).toEqual({ kind: "end" });
    expect(t.text().endsWith("\n")).toBe(true);
  });

  it("says the input ended at once when the input has already ended", async () => {
    const input = Readable.from([]);
    const reader = createReplyReader(input, new PassThrough(), false);
    const signal = new AbortController().signal;
    await reader.readReply(signal);
    expect(await reader.readLine("Skip? ", signal)).toEqual({ kind: "end" });
  });

  it("can ask after a reply was ended with the end-of-input key, on the same terminal", async () => {
    const t = terminal();
    const reader = createReplyReader(t.input, t.output, true);
    const signal = new AbortController().signal;
    const reading = reader.readReply(signal);
    t.input.write("\u0004");
    expect(await reading).toEqual({ kind: "reply", text: "", gotInput: false });
    const asking = reader.readLine("Skip? [y/N] ", signal);
    t.input.write("y\r");
    expect(await asking).toEqual({ kind: "line", text: "y" });
  });

  it("gives interrupted when the signal aborts, when it is already aborted, and on Ctrl+C", async () => {
    const t = terminal();
    const reader = createReplyReader(t.input, t.output, true);
    const controller = new AbortController();
    const reading = reader.readLine("Skip? ", controller.signal);
    controller.abort();
    expect(await reading).toEqual({ kind: "interrupted" });
    expect(await reader.readLine("Skip? ", AbortSignal.abort())).toEqual({ kind: "interrupted" });
    const again = reader.readLine("Skip? ", new AbortController().signal);
    t.input.write("\u0003");
    expect(await again).toEqual({ kind: "interrupted" });
  });

  it("shows a line in the middle of the typing and draws the prompt and the typed text again", async () => {
    const t = terminal();
    const reader = createReplyReader(t.input, t.output, true);
    const reading = reader.readReply(new AbortController().signal);
    t.input.write("I think");
    await settle();
    const before = t.text();
    reader.notify("New request received. 2 requests are waiting.");
    await settle();
    const added = t.text().slice(before.length);
    expect(added.startsWith("\n")).toBe(false);
    expect(added).toContain("New request received. 2 requests are waiting.\n");
    expect(added).toContain("> I think");
    t.input.write(" it\r");
    t.input.write("\u0004");
    expect(await reading).toEqual({ kind: "reply", text: "I think it", gotInput: true });
  });

  it("shows a line on its own when nobody is typing", async () => {
    const t = terminal();
    const reader = createReplyReader(t.input, t.output, true);
    reader.notify("Hello.");
    await settle();
    expect(t.text()).toBe("Hello.\n");
  });
});

describe("reading the whole standard input", () => {
  const LIMIT = MAX_FILE_BYTES;

  function stdinReader(input: Readable) {
    return createReplyReader(input, new PassThrough(), false);
  }

  const never = () => new AbortController().signal;

  it("joins the chunks and gives the text", async () => {
    const result = await stdinReader(
      Readable.from([Buffer.from("one\r\n"), Buffer.from("two")]),
    ).readStdin(never());
    expect(result).toEqual({ kind: "text", text: "one\r\ntwo" });
  });

  it("decodes a character that is cut between two chunks", async () => {
    const bytes = Buffer.from("café \u{1f600}!", "utf8");
    const chunks = [bytes.subarray(0, 4), bytes.subarray(4, 7), bytes.subarray(7)];
    const result = await stdinReader(Readable.from(chunks)).readStdin(never());
    expect(result).toEqual({ kind: "text", text: "café \u{1f600}!" });
  });

  it("removes one byte order mark at the start and no other", async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf]);
    const once = await stdinReader(
      Readable.from([Buffer.concat([bom, Buffer.from("Hi")])]),
    ).readStdin(never());
    expect(once).toEqual({ kind: "text", text: "Hi" });
    const twice = await stdinReader(
      Readable.from([Buffer.concat([bom, bom, Buffer.from("Hi")])]),
    ).readStdin(never());
    expect(twice).toEqual({ kind: "text", text: "﻿Hi" });
  });

  it("refuses bytes that are not UTF-8 and does not replace them", async () => {
    const result = await stdinReader(Readable.from([Buffer.from([0x48, 0xff, 0x69])])).readStdin(
      never(),
    );
    expect(result).toEqual({ kind: "not-utf8" });
  });

  it("refuses UTF-16 text as not UTF-8", async () => {
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Hi", "utf16le")]);
    expect(await stdinReader(Readable.from([utf16])).readStdin(never())).toEqual({
      kind: "not-utf8",
    });
  });

  it("gives an empty text for an input with nothing in it, also when it has ended already", async () => {
    expect(await stdinReader(Readable.from([])).readStdin(never())).toEqual({
      kind: "text",
      text: "",
    });
    const ended = Readable.from([]);
    await stdinReader(ended).readStdin(never());
    expect(ended.readableEnded).toBe(true);
    expect(await stdinReader(ended).readStdin(never())).toEqual({ kind: "text", text: "" });
  });

  it("reads exactly the limit, and stops with too-large one byte over it", async () => {
    const exact = await stdinReader(Readable.from([Buffer.alloc(LIMIT, 0x61)])).readStdin(never());
    expect(exact.kind === "text" && exact.text.length).toBe(LIMIT);
    const over = await stdinReader(Readable.from([Buffer.alloc(LIMIT + 1, 0x61)])).readStdin(
      never(),
    );
    expect(over).toEqual({ kind: "too-large" });
  });

  it("stops reading early when the input is far over the limit", async () => {
    let produced = 0;
    const source = new Readable({
      read() {
        produced += 1;
        this.push(produced > 200 ? null : Buffer.alloc(1_000_000, 0x61));
      },
    });
    const result = await stdinReader(source).readStdin(never());
    expect(result).toEqual({ kind: "too-large" });
    expect(produced).toBeLessThan(20);
    expect(source.listenerCount("data")).toBe(0);
    expect(source.isPaused()).toBe(true);
  });

  it("gives read-failed when the input fails or closes before its end", async () => {
    const failing = new Readable({
      read() {
        this.destroy(new Error("boom"));
      },
    });
    expect(await stdinReader(failing).readStdin(never())).toEqual({ kind: "read-failed" });
    const closed = new Readable({
      read() {
        this.destroy();
      },
    });
    expect(await stdinReader(closed).readStdin(never())).toEqual({ kind: "read-failed" });
  });

  it("stops at once when the signal aborts, and leaves nothing listening", async () => {
    const source = new Readable({ read() {} });
    const controller = new AbortController();
    const reading = stdinReader(source).readStdin(controller.signal);
    source.push(Buffer.from("partial"));
    await settle();
    controller.abort();
    expect(await reading).toEqual({ kind: "interrupted" });
    expect(source.listenerCount("data")).toBe(0);
    expect(source.listenerCount("end")).toBe(0);
    expect(source.listenerCount("error")).toBe(0);
    expect(source.isPaused()).toBe(true);
  });

  it("gives interrupted without reading when the signal is aborted already", async () => {
    const source = new Readable({ read() {} });
    expect(await stdinReader(source).readStdin(AbortSignal.abort())).toEqual({
      kind: "interrupted",
    });
    expect(source.listenerCount("data")).toBe(0);
  });
});

describe("requests that have tools", () => {
  const TOOL_ORIGINAL = {
    model: "whatever",
    tools: [{ type: "function", function: { name: "get_weather" } }],
    functions: [{ name: "legacy" }],
  };
  const WITH_TOOLS: Partial<ConversationRequest> = {
    toolDefinitions: "both",
    originalRequest: TOOL_ORIGINAL,
  };
  const HINT =
    'To call a tool, type a JSON array of calls: [{"id": "call_1", "type": "function", "function": {"name": "...", "arguments": "..."}}]';
  const CALLS = JSON.stringify([
    {
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: "{}" },
    },
  ]);
  const BAD_CALLS = JSON.stringify([
    {
      id: "secret-token",
      type: "secret-token",
      function: { name: "f", arguments: "{}" },
    },
  ]);
  const AGAIN = "Type your reply again. Finish with Ctrl+D (Windows: Ctrl+Z, then Enter).";
  const JSON_AGAIN = "Type the JSON again. Finish with Ctrl+D (Windows: Ctrl+Z, then Enter).";

  it("shows the tool roles, the tool calls, the list of tools and how to call one", async () => {
    const t = setup([]);
    t.addWaiting(
      ID,
      [
        { role: "user", content: "Weather?" },
        {
          role: "assistant",
          content: "",
          tool_calls: [
            {
              id: "c1",
              type: "function",
              function: { name: "get_weather", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "sunny", tool_call_id: "c1" },
      ],
      WITH_TOOLS,
    );
    const running = t.start();
    await settle();
    expect(t.stdout().slice(5)).toEqual([
      "User:",
      "  Weather?",
      "",
      "Assistant:",
      "  tool_call: get_weather({})",
      "",
      "Tool:",
      "  sunny",
      "",
      "Tools: get_weather",
      "Functions: legacy",
      "",
      HINT,
      PROMPT,
    ]);
    t.controller.abort();
    await running;
  });

  it("shows no list and no hint for a request without definitions", async () => {
    const t = setup([]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.raw()).not.toContain("Tools:");
    expect(t.raw()).not.toContain("Functions:");
    expect(t.raw()).not.toContain("To call a tool");
    t.controller.abort();
    await running;
  });

  it("sends tool calls that fit, as typed, with the kind text", async () => {
    const t = setup([CALLS]);
    t.addWaiting(ID, undefined, WITH_TOOLS);
    const running = t.start();
    await settle();
    expect(t.replyBody()).toBe(CALLS);
    expect(t.replyKind()).toBe("text");
    t.controller.abort();
    await running;
  });

  it("sends a text reply to a request with tools", async () => {
    const t = setup(["No tool is needed."]);
    t.addWaiting(ID, undefined, WITH_TOOLS);
    const running = t.start();
    await settle();
    expect(t.replyBody()).toBe("No tool is needed.");
    t.controller.abort();
    await running;
  });

  it("does not send tool calls that do not fit, says which call and field, and asks again", async () => {
    const t = setup([BAD_CALLS, CALLS]);
    t.addWaiting(ID, undefined, WITH_TOOLS);
    const running = t.start();
    await settle();
    const lines = t.stdout();
    const at = lines.indexOf(
      'Not sent: your tool calls are not valid (call 1 needs the type "function").',
    );
    expect(at).toBeGreaterThan(0);
    expect(lines[at + 1]).toBe(AGAIN);
    expect(lines.filter((line) => line.startsWith("--- Request"))).toHaveLength(1);
    expect(t.reader.calls).toBe(2);
    expect(t.replyBody()).toBe(CALLS);
    expect(t.raw()).not.toContain("secret-token");
    t.controller.abort();
    await running;
  });

  it("asks for the JSON again when a json request gets tool calls that do not fit", async () => {
    const t = setup([BAD_CALLS, CALLS]);
    t.addWaiting(ID, undefined, { ...WITH_TOOLS, replyKind: "json" });
    const running = t.start();
    await settle();
    const lines = t.stdout();
    const at = lines.indexOf(
      'Not sent: your tool calls are not valid (call 1 needs the type "function").',
    );
    expect(lines[at + 1]).toBe(JSON_AGAIN);
    expect(t.replyBody()).toBe(CALLS);
    expect(t.replyKind()).toBe("json");
    t.controller.abort();
    await running;
  });

  it("still wants JSON for a json request that has tools", async () => {
    const t = setup(["plain words", CALLS]);
    t.addWaiting(ID, undefined, { ...WITH_TOOLS, replyKind: "json" });
    const running = t.start();
    await settle();
    expect(
      t.stdout().some((line) => line.startsWith("Not sent: your reply is not valid JSON")),
    ).toBe(true);
    expect(t.replyBody()).toBe(CALLS);
    t.controller.abort();
    await running;
  });

  it("refuses several calls for a request that defines functions only", async () => {
    const two = JSON.stringify([
      { id: "a", type: "function", function: { name: "f", arguments: "" } },
      { id: "b", type: "function", function: { name: "f", arguments: "" } },
    ]);
    const t = setup([two, CALLS]);
    t.addWaiting(ID, undefined, {
      toolDefinitions: "functions",
      originalRequest: {
        model: "whatever",
        functions: [{ name: "get_weather" }],
      },
    });
    const running = t.start();
    await settle();
    expect(t.stdout()).toContain(
      "Not sent: your tool calls are not valid (this request defines functions only, so exactly one call is allowed).",
    );
    expect(t.replyBody()).toBe(CALLS);
    t.controller.abort();
    await running;
  });
});

describe("replying from standard input", () => {
  const T = RECEIVED_AT;
  const stdinSetup = (stdin: StdinStep[], store?: FakeStore) =>
    setup([], store, { kind: "running" }, { inputMode: "stdin", stdin });
  const tailOfNotSent = "Nothing was sent; the request is still waiting.";

  /** Starts the screen and lets it read and place the reply. `running` ends with the exit code. */
  async function placed(t: ReturnType<typeof stdinSetup>) {
    const running = t.start();
    await settle();
    return { running };
  }

  it("takes an omitted mode as interactive: it shows the request and reads typed lines", async () => {
    const t = setup(["Hi"]);
    t.addWaiting();
    const running = t.start();
    await settle();
    expect(t.stdout()).toContain(PROMPT);
    expect(t.reader.calls).toBe(1);
    expect(t.reader.stdinCalls).toBe(0);
    t.controller.abort();
    await running;
  });

  it("sends the whole input to the only waiting request and tells so in one line, exit 0", async () => {
    const t = stdinSetup(["Hi\n"]);
    t.addWaiting();
    const { running } = await placed(t);
    expect(t.replyBody()).toBe("Hi");
    expect(t.replyKind()).toBe("text");
    await t.serveBroker.pollOnce();
    await t.clock.advance(500);
    expect(await running).toBe(0);
    expect(t.stdout()).toEqual(["Sent reply to request a1b2c3."]);
    expect(t.stderr()).toEqual([]);
    expect(t.reader.calls).toBe(0);
    expect(t.reader.asked).toEqual([]);
  });

  it("shows no conversation, no prompt and no question about skipping", async () => {
    const t = stdinSetup(["Hi"]);
    t.addWaiting();
    const { running } = await placed(t);
    expect(t.stdout()).toEqual([]);
    t.controller.abort();
    await running;
    expect(t.raw()).not.toContain("Request 1 of");
    expect(t.raw()).not.toContain(WAITING);
  });

  it("applies the normalizing of line ends and the end of the text before it sends", async () => {
    const t = stdinSetup(["line one\r\nline two\r\n\r\n"]);
    t.addWaiting();
    const { running } = await placed(t);
    expect(t.replyBody()).toBe("line one\nline two");
    t.controller.abort();
    await running;
  });

  describe("tool calls", () => {
    const CALLS = JSON.stringify([
      {
        id: "call_1",
        type: "function",
        function: { name: "f", arguments: "{}" },
      },
    ]);
    const BAD_CALLS = JSON.stringify([
      {
        id: "secret-token",
        type: "secret-token",
        function: { name: "f", arguments: "{}" },
      },
    ]);
    const WITH_TOOLS: Partial<ConversationRequest> = {
      toolDefinitions: "tools",
      originalRequest: {
        model: "whatever",
        tools: [{ function: { name: "f" } }],
      },
    };

    it("sends tool calls that fit", async () => {
      const t = stdinSetup([`${CALLS}\n`]);
      t.addWaiting(ID, [{ role: "user", content: "Hello" }], WITH_TOOLS);
      const { running } = await placed(t);
      expect(t.replyBody()).toBe(CALLS);
      await t.serveBroker.pollOnce();
      await t.clock.advance(500);
      expect(await running).toBe(0);
      expect(t.stdout()).toEqual(["Sent reply to request a1b2c3."]);
    });

    it("sends nothing and ends with exit 1 for tool calls that do not fit", async () => {
      const t = stdinSetup([`${BAD_CALLS}\n`]);
      t.addWaiting(ID, [{ role: "user", content: "Hello" }], WITH_TOOLS);
      const { running } = await placed(t);
      expect(await running).toBe(1);
      expect(t.stderr()).toEqual([
        `Error: the tool calls are not valid (call 1 needs the type "function"). ${tailOfNotSent}`,
      ]);
      expect(t.raw()).not.toContain("secret-token");
      expect(t.replyBody()).toBeUndefined();
      expect(t.store.count("placeReply")).toBe(0);
    });

    it("sends the same text as a plain reply when the request has no definitions", async () => {
      const t = stdinSetup([`${BAD_CALLS}\n`]);
      t.addWaiting();
      const { running } = await placed(t);
      expect(t.replyBody()).toBe(BAD_CALLS);
      t.controller.abort();
      await running;
    });

    it("refuses several calls for a request that defines functions only", async () => {
      const two = JSON.stringify([
        { id: "a", type: "function", function: { name: "f", arguments: "" } },
        { id: "b", type: "function", function: { name: "f", arguments: "" } },
      ]);
      const t = stdinSetup([two]);
      t.addWaiting(ID, [{ role: "user", content: "Hello" }], {
        toolDefinitions: "functions",
        originalRequest: { model: "whatever", functions: [{ name: "f" }] },
      });
      const { running } = await placed(t);
      expect(await running).toBe(1);
      expect(t.stderr()).toEqual([
        `Error: the tool calls are not valid (this request defines functions only, so exactly one call is allowed). ${tailOfNotSent}`,
      ]);
    });
  });

  it("sends a reply with a json kind to a request that asks for json", async () => {
    const t = stdinSetup(['{"passed": true}\n']);
    t.addWaiting(ID, [{ role: "user", content: "Hello" }], { replyKind: "json" });
    const { running } = await placed(t);
    expect(t.replyBody()).toBe('{"passed": true}');
    expect(t.replyKind()).toBe("json");
    t.controller.abort();
    await running;
  });

  it("answers the first of two waiting requests only", async () => {
    const t = stdinSetup(["Hi"]);
    t.addWaiting(ID2);
    t.addWaiting(ID);
    const { running } = await placed(t);
    expect(t.replyBody(ID)).toBe("Hi");
    expect(t.replyBody(ID2)).toBeUndefined();
    t.controller.abort();
    await running;
    expect(t.store.entries.get(ID2)?.state).toMatchObject({ state: "waiting" });
  });

  it("keeps the request it chose when one with a smaller id arrives while it reads", async () => {
    const holder: { add: () => void } = { add: () => {} };
    const t = stdinSetup([
      () => {
        holder.add();
        return "Hi";
      },
    ]);
    holder.add = () => t.addWaiting(ID);
    t.addWaiting(ID2);
    const { running } = await placed(t);
    expect(t.replyBody(ID2)).toBe("Hi");
    expect(t.replyBody(ID)).toBeUndefined();
    t.controller.abort();
    await running;
  });

  it("shows nothing while no request waits, then answers the one that arrives", async () => {
    const t = stdinSetup(["Hi"]);
    const running = t.start();
    await settle();
    for (let index = 0; index < 4; index += 1) {
      await t.clock.advance(500);
    }
    expect(t.stdout()).toEqual([]);
    expect(t.stderr()).toEqual([]);
    expect(t.reader.stdinCalls).toBe(0);
    t.addWaiting();
    await t.clock.advance(500);
    expect(t.reader.stdinCalls).toBe(1);
    expect(t.replyBody()).toBe("Hi");
    t.controller.abort();
    await running;
  });

  it("ends without a word and with exit 130 on Ctrl+C while it waits for a request", async () => {
    const t = stdinSetup(["Hi"]);
    const running = t.start();
    await settle();
    t.controller.abort();
    expect(await running).toBe(130);
    expect(t.stdout()).toEqual([]);
    expect(t.stderr()).toEqual([]);
  });

  it("does not mention a request it cannot show or a request that arrives, and reads nothing else", async () => {
    const t = stdinSetup(["WAIT"]);
    t.store.addRaw(ID2, {
      request: "unsupported",
      state: createStateFile(ID2, "waiting", T, null),
    });
    t.addWaiting();
    const running = t.start();
    await settle();
    t.addWaiting("20261009T140514000Z-0a0b0c");
    await t.clock.advance(2000);
    expect(t.stdout()).toEqual([]);
    expect(t.stderr()).toEqual([]);
    t.controller.abort();
    await running;
  });

  describe("what cannot be sent", () => {
    const failures: Array<[string, StdinStep, string]> = [
      [
        "an input that is not UTF-8",
        { kind: "not-utf8" },
        "Error: the input is not valid UTF-8. Nothing was sent; the request is still waiting.",
      ],
      [
        "an input that cannot be read",
        { kind: "read-failed" },
        "Error: could not read standard input. Nothing was sent; the request is still waiting.",
      ],
      [
        "an input over the limit",
        { kind: "too-large" },
        `Error: the reply is larger than 10 MB. ${tailOfNotSent}`,
      ],
      ["an empty input", "", `Error: the reply is empty. ${tailOfNotSent}`],
      ["an input of only line ends", "\r\n\n\n", `Error: the reply is empty. ${tailOfNotSent}`],
    ];

    it.each(failures)("%s: one Error line, exit 1, nothing placed", async (_name, step, line) => {
      const t = stdinSetup([step]);
      t.addWaiting();
      const { running } = await placed(t);
      expect(await running).toBe(1);
      expect(t.stderr()).toEqual([line]);
      expect(t.stdout()).toEqual([]);
      expect(t.replyBody()).toBeUndefined();
      expect(t.store.count("placeReply")).toBe(0);
      expect(t.store.entries.get(ID)?.state).toMatchObject({ state: "waiting" });
    });

    it("says not valid JSON with the position, for a request that asks for json", async () => {
      const t = stdinSetup(["not json"]);
      t.addWaiting(ID, [{ role: "user", content: "Hello" }], { replyKind: "json" });
      const { running } = await placed(t);
      expect(await running).toBe(1);
      expect(t.stderr()).toEqual([
        `Error: the reply is not valid JSON (unexpected character at line 1, column 2). ${tailOfNotSent}`,
      ]);
      expect(t.raw()).not.toContain("not json");
      expect(t.replyBody()).toBeUndefined();
    });

    it("checks empty before json", async () => {
      const t = stdinSetup(["\n"]);
      t.addWaiting(ID, [{ role: "user", content: "Hello" }], { replyKind: "json" });
      const { running } = await placed(t);
      expect(await running).toBe(1);
      expect(t.stderr()).toEqual([`Error: the reply is empty. ${tailOfNotSent}`]);
    });

    it("refuses a reply whose written form is over the limit, though its text is under it", async () => {
      const body = '"'.repeat(5_500_000);
      expect(body.length).toBeLessThan(MAX_FILE_BYTES);
      const t = stdinSetup([body]);
      t.addWaiting();
      const { running } = await placed(t);
      expect(await running).toBe(1);
      expect(t.stderr()).toEqual([`Error: the reply is larger than 10 MB. ${tailOfNotSent}`]);
      expect(t.replyBody()).toBeUndefined();
    });

    it("checks json before the size", async () => {
      const t = stdinSetup(['"'.repeat(5_500_000)]);
      t.addWaiting(ID, [{ role: "user", content: "Hello" }], { replyKind: "json" });
      const { running } = await placed(t);
      expect(await running).toBe(1);
      expect(t.stderr()[0]).toContain("Error: the reply is not valid JSON (");
    });

    it("refuses a valid json reply whose written form is over the limit", async () => {
      const body = `[${'"",'.repeat(2_200_000)}""]`;
      const t = stdinSetup([body]);
      t.addWaiting(ID, [{ role: "user", content: "Hello" }], { replyKind: "json" });
      const { running } = await placed(t);
      expect(await running).toBe(1);
      expect(t.stderr()).toEqual([`Error: the reply is larger than 10 MB. ${tailOfNotSent}`]);
    });

    it("sends a reply whose written form is exactly the limit", async () => {
      const base = serializeFile(createReplyFile("", T, "text")).length;
      const t = stdinSetup(["a".repeat(MAX_FILE_BYTES - base)]);
      t.addWaiting();
      const { running } = await placed(t);
      expect(Buffer.byteLength(t.store.entries.get(ID)?.files.get("reply.json") ?? "")).toBe(
        MAX_FILE_BYTES,
      );
      t.controller.abort();
      await running;
    });
  });

  describe("how the request ended", () => {
    const at = "2026-10-09T14:05:12.000Z";
    const endings: Array<[string, ReturnType<typeof createStateFile>, string]> = [
      [
        "cancelled",
        createStateFile(ID, "cancelled", at, at, "client disconnected"),
        "Error: request a1b2c3 was cancelled (the client disconnected). Nothing was sent.",
      ],
      [
        "timed out",
        createStateFile(ID, "timed_out", at, at, "wait limit of 30 seconds reached"),
        "Error: request a1b2c3 timed out (the wait limit passed). Nothing was sent.",
      ],
      [
        "answered in another window",
        createStateFile(ID, "replied", at, at),
        "Error: request a1b2c3 was already answered in another window. Nothing was sent.",
      ],
      [
        "skipped in another window",
        createStateFile(ID, "skipped", at, at, "skipped by the human"),
        "Error: request a1b2c3 was already answered in another window. Nothing was sent.",
      ],
      [
        "ended with an invalid reply",
        createStateFile(ID, "invalid_reply", at, at, "reply file is not valid JSON"),
        "Error: request a1b2c3 has already ended. Nothing was sent.",
      ],
      [
        "abandoned",
        createStateFile(ID, "abandoned", at, at, "server restarted"),
        "Error: request a1b2c3 has already ended. Nothing was sent.",
      ],
    ];

    it.each(endings)("stops the reading when the request is %s", async (_name, state, line) => {
      const t = stdinSetup(["WAIT"]);
      t.addWaiting();
      const { running } = await placed(t);
      const entry = t.store.entries.get(ID);
      if (entry !== undefined) {
        entry.state = state;
      }
      await t.clock.advance(500);
      expect(await running).toBe(1);
      expect(t.stderr()).toEqual([line]);
      expect(t.stdout()).toEqual([]);
      expect(t.replyBody()).toBeUndefined();
    });

    it.each(endings)(
      "tells the same after the reply was placed, when the request is %s",
      async (_name, state, line) => {
        const t = stdinSetup(["Hi"]);
        t.addWaiting();
        const { running } = await placed(t);
        expect(t.replyBody()).toBe("Hi");
        const entry = t.store.entries.get(ID);
        if (entry !== undefined) {
          entry.state = state;
        }
        await t.clock.advance(500);
        expect(await running).toBe(1);
        expect(t.stderr()).toEqual([line]);
        expect(t.stdout()).toEqual([]);
      },
    );

    it("says another window answered when a hand-written reply took the place", async () => {
      const t = stdinSetup([
        () => {
          t.store.putFile(ID, "reply.json", serializeFile(createReplyFile("theirs", T)));
          return "Hi";
        },
      ]);
      t.addWaiting();
      const { running } = await placed(t);
      await t.serveBroker.pollOnce();
      await t.clock.advance(500);
      expect(await running).toBe(1);
      expect(t.stderr()).toEqual([
        "Error: request a1b2c3 was already answered in another window. Nothing was sent.",
      ]);
      expect(t.store.entries.get(ID)?.files.get("reply.accepted.json")).toContain("theirs");
    });

    it("says the request has ended when the hand-written reply that took the place was invalid", async () => {
      const t = stdinSetup([
        () => {
          t.store.putFile(ID, "reply.json", "{broken");
          return "Hi";
        },
      ]);
      t.addWaiting();
      const { running } = await placed(t);
      await t.serveBroker.pollOnce();
      await t.clock.advance(500);
      expect(await running).toBe(1);
      expect(t.stderr()).toEqual(["Error: request a1b2c3 has already ended. Nothing was sent."]);
    });
  });

  describe("Ctrl+C and failures to write", () => {
    it("shows the Quit line and exits 130 when Ctrl+C comes while it reads", async () => {
      const t = stdinSetup(["WAIT"]);
      t.addWaiting();
      const { running } = await placed(t);
      t.controller.abort();
      expect(await running).toBe(130);
      expect(t.stdout()).toEqual(["Quit. Request a1b2c3 is still waiting."]);
      expect(t.stderr()).toEqual([]);
      expect(t.replyBody()).toBeUndefined();
    });

    it("keeps the placed reply, shows nothing and exits 130 when Ctrl+C comes after it was placed", async () => {
      const t = stdinSetup(["Hi"]);
      t.addWaiting();
      const { running } = await placed(t);
      t.controller.abort();
      expect(await running).toBe(130);
      expect(t.stdout()).toEqual([]);
      expect(t.stderr()).toEqual([]);
      expect(t.replyBody()).toBe("Hi");
    });

    it("says it could not write the reply, once, and exits 1 with the request still waiting", async () => {
      const t = stdinSetup(["Hi"]);
      t.addWaiting();
      t.store.fail("placeReply", 5);
      const { running } = await placed(t);
      expect(await running).toBe(1);
      expect(t.stderr()).toEqual(["Error: could not write the reply. input/output error."]);
      expect(t.stdout()).toEqual([]);
      expect(t.store.count("placeReply")).toBe(1);
      expect(t.store.entries.get(ID)?.state).toMatchObject({ state: "waiting" });
    });
  });

  describe("the size of what is typed", () => {
    const again = "Type your reply again. Finish with Ctrl+D (Windows: Ctrl+Z, then Enter).";

    it("refuses a typed reply whose written form is over the limit and asks again", async () => {
      const t = setup(['"'.repeat(5_500_000), "ok"]);
      t.addWaiting();
      const running = t.start();
      await settle();
      const lines = t.stdout();
      const at = lines.indexOf("Not sent: your reply is larger than 10 MB.");
      expect(at).toBeGreaterThan(-1);
      expect(lines[at + 1]).toBe(again);
      expect(t.reader.calls).toBe(2);
      expect(t.replyBody()).toBe("ok");
      t.controller.abort();
      await running;
    });

    it("asks for the json again for a request that asks for json", async () => {
      const t = setup([`[${'"",'.repeat(2_200_000)}""]`, "[]"]);
      t.addWaiting(ID, [{ role: "user", content: "Hello" }], { replyKind: "json" });
      const running = t.start();
      await settle();
      const lines = t.stdout();
      const at = lines.indexOf("Not sent: your reply is larger than 10 MB.");
      expect(at).toBeGreaterThan(-1);
      expect(lines[at + 1]).toBe(
        "Type the JSON again. Finish with Ctrl+D (Windows: Ctrl+Z, then Enter).",
      );
      expect(t.replyBody()).toBe("[]");
      t.controller.abort();
      await running;
    });
  });
});
