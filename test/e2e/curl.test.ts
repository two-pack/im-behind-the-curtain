import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { main } from "../../src/cli.js";
import { MAX_FILE_BYTES } from "../../src/model.js";
import { BarrierReader } from "../helpers/barrier-reader.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { makeTempDir } from "../helpers/fs.js";
import { makeIo, waitFor } from "../helpers/io.js";
import { ScriptedReader } from "../helpers/scripted-reader.js";
import {
  answerEverything,
  freePort,
  postChat,
  requestFiles,
  startAnswer,
  startServe,
  storedStates,
  waitForRequestId,
  writeReplyByHand,
} from "../helpers/system.js";

interface CurlResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the curl program. The body goes through standard input so no shell quoting is needed. */
function curl(args: string[], input?: string): Promise<CurlResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

describe("a round trip with curl (NFR4.1)", () => {
  it("sends a request without an API key, a human types Hi, and curl receives the answer", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["Hi"]));
    const body = '{"model":"whatever","messages":[{"role":"user","content":"Hello"}]}';

    const result = await curl(
      [
        "--silent",
        "--show-error",
        "--max-time",
        "20",
        "-X",
        "POST",
        `${serve.baseUrl}/v1/chat/completions`,
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        "@-",
      ],
      body,
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const completion = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(completion).toMatchObject({
      object: "chat.completion",
      model: "whatever",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    expect(String(completion.id)).toMatch(/^chatcmpl-\d{8}T\d{9}Z-[0-9a-f]{6}$/);
    expect(Number.isInteger(completion.created)).toBe(true);

    await waitFor(() => answer.stdout().includes("Sent."));
    expect(answer.stdout()).toContain("User:\n  Hello\n");
    expect(serve.stdout()).toMatch(/received {3}[0-9a-f]{6} {2}chat\/completions {2}text/);
    expect(serve.stdout()).toMatch(/replied {4}[0-9a-f]{6}/);
  });

  const URL_PATH = "/v1/chat/completions";
  const SCHEMA = {
    type: "object",
    properties: { passed: { type: "boolean" }, reason: { type: "string" } },
    required: ["passed", "reason"],
  };

  it("returns a structured-output reply exactly as typed, after a refused bad reply", async () => {
    const serve = await startServe();
    const typed = '{"passed": true,   "reason": "The dashboard is shown."}';
    const answer = startAnswer(serve.storageDir, new ScriptedReader(['{"passed":', typed]));
    const body = JSON.stringify({
      model: "whatever",
      messages: [{ role: "user", content: "Did the login succeed?" }],
      response_format: { type: "json_schema", json_schema: { name: "result", schema: SCHEMA } },
    });

    const result = await curl(
      [
        "--silent",
        "--show-error",
        "--max-time",
        "20",
        "-X",
        "POST",
        `${serve.baseUrl}${URL_PATH}`,
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        "@-",
      ],
      body,
    );

    expect(result.code).toBe(0);
    const completion = JSON.parse(result.stdout) as { choices: { message: { content: string } }[] };
    expect(completion.choices[0]?.message.content).toBe(typed);
    await waitFor(() => answer.stdout().includes("Sent."));
    const screen = answer.stdout();
    expect(screen).toContain("Reply:    JSON");
    expect(screen).toContain("Required shape:");
    expect(screen).toContain(
      "Not sent: your reply is not valid JSON (unexpected end of input at line 1).",
    );
    expect(serve.stdout()).toMatch(/received {3}[0-9a-f]{6} {2}chat\/completions {2}json\n/);
  });

  it("streams the reply as server-sent events that end with [DONE]", async () => {
    const serve = await startServe();
    startAnswer(serve.storageDir, new ScriptedReader(["Hi"]));
    const body =
      '{"model":"whatever","stream":true,"messages":[{"role":"user","content":"Hello"}]}';

    const result = await curl(
      [
        "--silent",
        "--show-error",
        "--no-buffer",
        "--max-time",
        "20",
        "-i",
        "-X",
        "POST",
        `${serve.baseUrl}${URL_PATH}`,
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        "@-",
      ],
      body,
    );

    expect(result.code).toBe(0);
    const [head = "", ...rest] = result.stdout.split("\r\n\r\n");
    expect(head.toLowerCase()).toContain("content-type: text/event-stream");
    const events = rest
      .join("\r\n\r\n")
      .split("\n\n")
      .filter((block) => block !== "");
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.startsWith("data: "))).toBe(true);
    expect(events[3]).toBe("data: [DONE]");
    const contents = events
      .slice(0, 3)
      .map((event) => JSON.parse(event.slice("data: ".length)).choices[0].delta.content);
    expect(contents).toEqual(["", "Hi", undefined]);
    expect(serve.stdout()).toMatch(/chat\/completions {2}text {2}stream\n/);
  });

  it("rejects a request from a browser page (Origin header) and does not show it", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader([]));
    const result = await curl(
      [
        "--silent",
        "-X",
        "POST",
        `${serve.baseUrl}/v1/chat/completions`,
        "-H",
        "Origin: https://evil.example",
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        "@-",
      ],
      '{"model":"m","messages":[{"role":"user","content":"x"}]}',
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      error: { message: "Cross-origin requests are not accepted.", code: "invalid_request" },
    });
    expect(answer.stdout()).not.toContain("Request 1 of");
  });
});

interface CurlReply {
  status: number;
  body: {
    error?: { message: string; type: string; code: string };
    choices?: { message: { content: string | null }; finish_reason?: string }[];
  };
}

/** POSTs a body with curl and returns the status and the JSON body. Write errors are tolerated. */
async function curlPost(baseUrl: string, body: string): Promise<CurlReply> {
  const result = await curl(
    [
      "--silent",
      "--max-time",
      "30",
      "-w",
      "\n%{http_code}",
      "-X",
      "POST",
      `${baseUrl}/v1/chat/completions`,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      "@-",
    ],
    body,
  ).catch(() => undefined);
  const text = result?.stdout ?? "";
  const split = text.lastIndexOf("\n");
  return {
    status: Number(text.slice(split + 1)),
    body: split > 0 ? (JSON.parse(text.slice(0, split)) as CurlReply["body"]) : {},
  };
}

async function storedRequests(storageDir: string): Promise<string[]> {
  return readdir(path.join(storageDir, "requests")).catch(() => []);
}

describe("requests that are turned away or let through", () => {
  const MESSAGES = [{ role: "user", content: "Hello" }];

  async function refused(body: string) {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader([]));
    const reply = await curlPost(serve.baseUrl, body);
    expect(await storedRequests(serve.storageDir)).toEqual([]);
    expect(answer.stdout()).not.toContain("Request 1 of");
    return reply;
  }

  it("answers 400 when messages is missing", async () => {
    const reply = await refused(JSON.stringify({ model: "m" }));
    expect(reply.status).toBe(400);
    expect(reply.body.error).toEqual({
      message: '"messages" must be a non-empty array.',
      type: "invalid_request_error",
      code: "invalid_request",
    });
  });

  it("answers 400 when n is 2", async () => {
    const reply = await refused(JSON.stringify({ model: "m", messages: MESSAGES, n: 2 }));
    expect(reply.status).toBe(400);
    expect(reply.body.error?.message).toBe('Only one choice can be returned; "n" must be 1.');
  });

  it("answers 400 and names an unsupported role", async () => {
    const reply = await refused(
      JSON.stringify({ model: "m", messages: [{ role: "critic", content: "x" }] }),
    );
    expect(reply.status).toBe(400);
    expect(reply.body.error?.message).toBe('Unsupported message role: "critic".');
  });

  it("answers 413 for a body larger than 10 MB", async () => {
    const big = JSON.stringify({
      model: "m",
      messages: [{ role: "user", content: "a".repeat(10485760) }],
    });
    expect(Buffer.byteLength(big)).toBeGreaterThan(10485760);
    const reply = await refused(big);
    expect(reply.status).toBe(413);
    expect(reply.body.error).toEqual({
      message: "Request body is larger than 10 MB.",
      type: "invalid_request_error",
      code: "request_too_large",
    });
  });

  it("accepts a request with an unknown field and shows the conversation", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["Hi"]));
    const reply = await curlPost(
      serve.baseUrl,
      JSON.stringify({
        model: "m",
        foo: { bar: 1 },
        messages: [{ role: "user", content: "Hello", foo: 2 }],
      }),
    );
    expect(reply.status).toBe(200);
    await waitFor(() => answer.stdout().includes("Sent."));
    expect(answer.stdout()).toContain("User:\n  Hello\n");
    expect(answer.stdout()).not.toContain("foo");
  });
});

describe("an image as a data URL, with curl", () => {
  /** A 1x1 PNG, as base64. */
  const PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const PNG_FILE = "message-1-part-2.png";

  function imageBody(): string {
    const content = [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: `data:image/png;base64,${PNG_BASE64}` } },
      { type: "text", text: "Be brief." },
    ];
    return JSON.stringify({ model: "m", messages: [{ role: "user", content }] });
  }

  it("saves the picture, shows two lines to the human, and returns the reply to curl", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["A pixel."]));
    const reply = await curlPost(serve.baseUrl, imageBody());
    expect(reply.status).toBe(200);
    expect(reply.body.choices?.[0]?.message.content).toBe("A pixel.");
    await waitFor(() => answer.stdout().includes("Sent."));

    const id = await waitForRequestId(serve.storageDir);
    const saved = path.join(serve.storageDir, "requests", id, PNG_FILE);
    const expected = Buffer.from(PNG_BASE64, "base64");
    expect(await readFile(saved)).toEqual(expected);
    expect(answer.stdout()).toContain(
      `  What is this?\n  [image] image/png, ${expected.length} bytes\n    saved: ${saved}\n  Be brief.\n`,
    );
    expect(await requestFiles(serve.storageDir, id)).toEqual([
      PNG_FILE,
      "reply.accepted.json",
      "request.json",
      "state.json",
    ]);
    const stored = JSON.parse(
      await readFile(path.join(serve.storageDir, "requests", id, "request.json"), "utf8"),
    ) as { formatVersion: number; conversation: Record<string, unknown>[] };
    expect(stored.formatVersion).toBe(3);
    expect(stored.conversation[0]).toMatchObject({
      content: "What is this?Be brief.",
      attachments: [{ at: 13, kind: "image", mediaType: "image/png", file: PNG_FILE }],
    });
    expect(serve.stdout()).not.toContain(PNG_BASE64);
    expect(serve.stdout()).not.toContain("What is this?");
  });

  it("deletes the saved picture with the request after the retention time", async () => {
    const serve = await startServe({
      args: ["--timeout", "0", "--retention", "1", "--sweep-interval", "1"],
    });
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["Done."]));
    const reply = await curlPost(serve.baseUrl, imageBody());
    expect(reply.status).toBe(200);
    await waitFor(() => answer.stdout().includes("Sent."));
    await waitFor(
      async () => (await readdir(path.join(serve.storageDir, "requests"))).length === 0,
      8000,
    );
  });
});

describe("requests that are turned away as unsupported", () => {
  const IMAGES = "Images are not supported. A human reads requests as text.";
  const USER = { role: "user", content: "Hello" };

  async function refusedAs(request: Record<string, unknown>, message: string) {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader([]));
    const reply = await curlPost(serve.baseUrl, JSON.stringify({ model: "m", ...request }));
    expect(reply.status).toBe(400);
    expect(reply.body.error).toEqual({
      message,
      type: "invalid_request_error",
      code: "unsupported_content",
    });
    expect(await storedRequests(serve.storageDir)).toEqual([]);
    expect(answer.stdout()).not.toContain("Request 1 of");
  }

  it("refuses an image part that is not a readable data URL", async () => {
    const content = [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "https://example.com/cat.png" } },
    ];
    await refusedAs({ messages: [{ role: "user", content }] }, IMAGES);
  });

  it("refuses an audio part and names its type", async () => {
    const content = [{ type: "input_audio", input_audio: { data: "AAAA", format: "wav" } }];
    await refusedAs(
      { messages: [{ role: "user", content }] },
      'Unsupported content part type: "input_audio".',
    );
  });

  it("refuses n of 2 or more even when the request has tools", async () => {
    const serve = await startServe();
    const reply = await curlPost(
      serve.baseUrl,
      JSON.stringify({
        model: "m",
        messages: [USER],
        tools: [{ type: "function" }],
        n: 2,
      }),
    );
    expect(reply.status).toBe(400);
    expect(reply.body.error).toMatchObject({ code: "invalid_request" });
  });

  it("accepts empty tools and gets the reply", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["Hi"]));
    const reply = await curlPost(
      serve.baseUrl,
      JSON.stringify({ model: "m", messages: [USER], tools: [] }),
    );
    expect(reply.status).toBe(200);
    await waitFor(() => answer.stdout().includes("Sent."));
  });
});

describe("a round trip with tools, sent with curl", () => {
  const USER = { role: "user", content: "What is the weather in Tokyo?" };
  const TOOL = {
    type: "function",
    function: { name: "get_weather", parameters: { type: "object" } },
  };
  const CALLS = [
    {
      id: "call_1",
      type: "function",
      index: 0,
      function: {
        name: "get_weather",
        arguments: '{"city": "Tokyo"}',
        note: "extra",
      },
    },
  ];

  it("stores the tools as sent, shows them, and returns the typed tool_calls", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader([JSON.stringify(CALLS)]));
    const original = {
      model: "m",
      messages: [USER],
      tools: [TOOL],
      tool_choice: "auto",
    };
    const reply = await curlPost(serve.baseUrl, JSON.stringify(original));

    expect(reply.status).toBe(200);
    expect(reply.body.choices?.[0]).toEqual({
      index: 0,
      message: { role: "assistant", content: null, tool_calls: CALLS },
      finish_reason: "tool_calls",
    });
    await waitFor(() => answer.stdout().includes("Sent."));
    expect(answer.stdout()).toContain("Tools: get_weather\n");
    const id = await waitForRequestId(serve.storageDir);
    const stored = JSON.parse(
      await readFile(path.join(serve.storageDir, "requests", id, "request.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      formatVersion: 3,
      toolDefinitions: "tools",
    });
    expect(stored.originalRequest).toEqual(original);
  });

  it("returns a typed text reply to a request with tools as text", async () => {
    const serve = await startServe();
    startAnswer(serve.storageDir, new ScriptedReader(["It is sunny."]));
    const reply = await curlPost(
      serve.baseUrl,
      JSON.stringify({ model: "m", messages: [USER], tools: [TOOL] }),
    );
    expect(reply.body.choices?.[0]).toEqual({
      index: 0,
      message: { role: "assistant", content: "It is sunny." },
      finish_reason: "stop",
    });
  });

  it("accepts the history of a tool call: the screen shows the call and the tool message", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["It is sunny."]));
    const messages = [
      USER,
      { role: "assistant", content: null, tool_calls: CALLS },
      { role: "tool", tool_call_id: "call_1", content: "sunny, 24 C" },
    ];
    const reply = await curlPost(serve.baseUrl, JSON.stringify({ model: "m", messages }));
    expect(reply.status).toBe(200);
    await waitFor(() => answer.stdout().includes("Sent."));
    expect(answer.stdout()).toContain('tool_call: get_weather({"city": "Tokyo"})');
    expect(answer.stdout()).toContain("Tool:\n  sunny, 24 C\n");
  });

  it("returns function_call for a request that defines functions only", async () => {
    const serve = await startServe();
    startAnswer(serve.storageDir, new ScriptedReader([JSON.stringify(CALLS)]));
    const reply = await curlPost(
      serve.baseUrl,
      JSON.stringify({
        model: "m",
        messages: [USER],
        functions: [{ name: "get_weather" }],
      }),
    );
    expect(reply.body.choices?.[0]).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: null,
        function_call: { name: "get_weather", arguments: '{"city": "Tokyo"}' },
      },
      finish_reason: "function_call",
    });
  });

  it("asks the human to type again for tool calls that do not fit, and sends nothing before", async () => {
    const serve = await startServe();
    const bad = JSON.stringify([{ id: "", type: "function", function: { name: "f" } }]);
    const answer = startAnswer(serve.storageDir, new ScriptedReader([bad, JSON.stringify(CALLS)]));
    const reply = await curlPost(
      serve.baseUrl,
      JSON.stringify({ model: "m", messages: [USER], tools: [TOOL] }),
    );
    expect(reply.status).toBe(200);
    await waitFor(() => answer.stdout().includes("Sent."));
    expect(answer.stdout()).toContain(
      "Not sent: your tool calls are not valid (call 1 needs a non-empty string id).",
    );
  });
});

/** A body with one user message. */
function chatBody(content: string): string {
  return JSON.stringify({ model: "m", messages: [{ role: "user", content }] });
}

describe("many requests, skipping, leaving and waiting too long with curl", () => {
  it("returns each of ten simultaneous requests its own answer (NFR8.1)", async () => {
    const serve = await startServe();
    const answering = answerEverything(serve.storageDir, 10);
    const questions = Array.from({ length: 10 }, (_, index) => `question ${index}`);

    const replies = await Promise.all(
      questions.map((question) => curlPost(serve.baseUrl, chatBody(question))),
    );
    await answering;

    replies.forEach((reply, index) => {
      expect(reply.status).toBe(200);
      expect(reply.body.choices?.[0]?.message.content).toBe(`answer to question ${index}`);
    });
    expect(await storedStates(serve.storageDir)).toEqual(Array(10).fill("replied"));
  });

  it("answers 503 when the human skips, and the screen says Skipped.", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["EOF", "y"]));

    const reply = await curlPost(serve.baseUrl, chatBody("Hello"));

    expect(reply.status).toBe(503);
    expect(reply.body.error).toEqual({
      message: "The human skipped this request.",
      type: "server_error",
      code: "skipped_by_human",
    });
    await waitFor(() => answer.stdout().includes("Skipped."));
    expect(answer.stdout()).not.toContain("Sent.");
    expect(serve.stdout()).toMatch(/skipped {4}[0-9a-f]{6}\n/);
    expect(await storedStates(serve.storageDir)).toEqual(["skipped"]);
  });

  it("ends the request as cancelled when curl goes away, and the screen says so while typing", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["WAIT"]));

    const result = await curl(
      [
        "--silent",
        "--max-time",
        "2",
        "-X",
        "POST",
        `${serve.baseUrl}/v1/chat/completions`,
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        "@-",
      ],
      chatBody("Hello"),
    );

    expect(result.code).toBe(28);
    await waitFor(() => answer.stdout().includes("Cancelled: the client disconnected."), 10_000);
    expect(serve.stdout()).toMatch(/cancelled {2}[0-9a-f]{6} {2}client disconnected\n/);
    expect(await storedStates(serve.storageDir)).toEqual(["cancelled"]);
    expect(serve.stderr()).toBe("");
  });

  it("answers 504 after the wait limit of one second, and the request is gone from the list", async () => {
    const serve = await startServe({ args: ["--timeout", "1"] });

    const reply = await curlPost(serve.baseUrl, chatBody("Hello"));

    expect(reply.status).toBe(504);
    expect(reply.body.error).toEqual({
      message: "No reply within 1 seconds. Increase the server timeout or reply sooner.",
      type: "server_error",
      code: "reply_timeout",
    });
    expect(await storedStates(serve.storageDir)).toEqual(["timed_out"]);
    expect(serve.stdout()).toMatch(/timed_out {2}[0-9a-f]{6}\n/);
    const answer = startAnswer(serve.storageDir, new ScriptedReader([]));
    await waitFor(() => answer.stdout().includes("Waiting for requests..."));
    expect(answer.stdout()).not.toContain("Request 1 of");
  });

  it("also takes the wait limit written as --timeout=1", async () => {
    const serve = await startServe({ args: ["--timeout=1"] });
    const reply = await curlPost(serve.baseUrl, chatBody("Hello"));
    expect(reply.status).toBe(504);
  });

  it("waits 1800 seconds by default and then answers 504", async () => {
    const clock = new FakeClock();
    const serve = await startServe({ clock });
    const pending = curlPost(serve.baseUrl, chatBody("Hello"));
    await waitFor(async () => (await storedStates(serve.storageDir)).length === 1);

    await clock.advance(1799 * 1000);
    expect(await storedStates(serve.storageDir)).toEqual(["waiting"]);
    await clock.advance(1000);

    const reply = await pending;
    expect(reply.status).toBe(504);
    expect(reply.body.error?.message).toBe(
      "No reply within 1800 seconds. Increase the server timeout or reply sooner.",
    );
    expect(await storedStates(serve.storageDir)).toEqual(["timed_out"]);
  });

  it("keeps the request waiting for ever when the limit is 0, even after 30 minutes", async () => {
    const clock = new FakeClock();
    const serve = await startServe({ clock, args: ["--timeout", "0"] });
    let answered = false;
    const pending = curlPost(serve.baseUrl, chatBody("Hello")).then((reply) => {
      answered = true;
      return reply;
    });
    await waitFor(async () => (await storedStates(serve.storageDir)).length === 1);

    for (let minute = 0; minute < 31; minute += 1) {
      await clock.advance(60 * 1000);
    }

    expect(answered).toBe(false);
    expect(await storedStates(serve.storageDir)).toEqual(["waiting"]);
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["late but welcome"]));
    // The clock of serve only moves when the test moves it, so the polls need pushes.
    await waitFor(async () => {
      await clock.advance(500);
      return answered;
    });
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(reply.body.choices?.[0]?.message.content).toBe("late but welcome");
    await waitFor(() => answer.stdout().includes("Sent."));
  });

  it("uses only the first of two screens that answer the same request", async () => {
    const serve = await startServe();
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const readerA = new BarrierReader("from A", gate);
    const readerB = new BarrierReader("from B", gate);
    const answerA = startAnswer(serve.storageDir, readerA);
    const answerB = startAnswer(serve.storageDir, readerB);
    const pending = curlPost(serve.baseUrl, chatBody("Hello"));
    await waitFor(() => readerA.arrived && readerB.arrived);

    open();
    const reply = await pending;

    const both = () => [answerA.stdout(), answerB.stdout()];
    await waitFor(
      () =>
        both().some((text) => text.includes("Not sent:")) &&
        both().some((text) => text.includes("Sent.")),
    );
    const winner = answerA.stdout().includes("Sent.") ? "from A" : "from B";
    expect(reply.body.choices?.[0]?.message.content).toBe(winner);
    expect(await storedStates(serve.storageDir)).toEqual(["replied"]);
  });
});

describe("the model list with curl", () => {
  it("returns the model list to a plain GET without an API key", async () => {
    const serve = await startServe();
    const result = await curl([
      "--silent",
      "--show-error",
      "--max-time",
      "20",
      "-i",
      `${serve.baseUrl}/v1/models`,
    ]);
    expect(result.code).toBe(0);
    const [head = "", body = ""] = result.stdout.split("\r\n\r\n");
    expect(head.split("\r\n")[0]).toBe("HTTP/1.1 200 OK");
    expect(head.toLowerCase()).toContain("content-type: application/json");
    expect(JSON.parse(body)).toEqual({
      object: "list",
      data: [{ id: "imbehind", object: "model", created: 1791800000, owned_by: "imbehind" }],
    });
    expect(
      serve
        .stdout()
        .split("\n")
        .filter((line) => line !== ""),
    ).toHaveLength(1);
  });
});

describe("choosing the port and the host", () => {
  async function listensOn(serve: Awaited<ReturnType<typeof startServe>>, port: number) {
    expect(serve.port).toBe(port);
    const result = await curl(["--silent", "--max-time", "20", `${serve.baseUrl}/v1/models`]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).data[0].id).toBe("imbehind");
  }

  it("listens on the port of --port, in both ways of writing it", async () => {
    for (const style of ["split", "equals"]) {
      const port = await freePort();
      const dir = await makeTempDir();
      const args = style === "split" ? ["--port", String(port)] : [`--port=${port}`];
      const serve = await startServe({ raw: true, args: [...args, "--dir", dir] });
      await listensOn(serve, port);
      expect(serve.storageDir).toBe(dir);
      await serve.stop();
    }
  });

  it("listens on the port of IMBEHIND_PORT, and --port wins when both are given", async () => {
    const dir = await makeTempDir();
    const fromEnv = await freePort();
    const byEnvironment = await startServe({
      raw: true,
      env: { IMBEHIND_PORT: String(fromEnv), IMBEHIND_DIR: dir },
    });
    await listensOn(byEnvironment, fromEnv);
    await byEnvironment.stop();

    const wanted = await freePort();
    const both = await startServe({
      raw: true,
      args: ["--port", String(wanted)],
      env: { IMBEHIND_PORT: String(fromEnv), IMBEHIND_DIR: dir },
    });
    await listensOn(both, wanted);
  });

  it("uses the storage directory of IMBEHIND_DIR and prints it in the first line", async () => {
    const dir = await makeTempDir();
    const port = await freePort();
    const serve = await startServe({
      raw: true,
      args: ["--port", String(port)],
      env: { IMBEHIND_DIR: dir },
    });
    expect(serve.stdout()).toContain(`(storage: ${dir})`);
    await serve.stop();
  });

  it("stops for --host 0.0.0.0 with exit 2 and the sentence, and listens nowhere", async () => {
    const t = makeIo();
    const port = await freePort();
    const dir = path.join(await makeTempDir(), "never-created");
    const exit = await main(
      ["serve", "--host", "0.0.0.0", "--port", String(port), "--dir", dir],
      t.io,
    );
    expect(exit).toBe(2);
    expect(t.err.lines()).toEqual([
      "Error: 0.0.0.0 is not a local address. imbehind only listens on this machine (127.0.0.0/8, ::1, localhost).",
    ]);
    expect(t.out.text()).toBe("");
    const probe = await curl(["--silent", "--max-time", "2", `http://127.0.0.1:${port}/v1/models`]);
    expect(probe.code).not.toBe(0);
  });
});

describe("old requests are deleted", () => {
  it("deletes a request that ended, within about two seconds of its retention, every second", async () => {
    const serve = await startServe({
      args: ["--timeout", "1", "--retention", "1", "--sweep-interval", "1"],
    });
    const reply = await curlPost(serve.baseUrl, chatBody("Hello"));
    expect(reply.status).toBe(504);
    const endedAt = Date.now();
    await waitFor(
      async () => (await readdir(path.join(serve.storageDir, "requests"))).length === 0,
      8000,
    );
    expect(Date.now() - endedAt).toBeLessThan(4500);
  });

  it("keeps a request that still waits and deletes the one that was answered", async () => {
    const serve = await startServe({
      args: ["--timeout", "0", "--retention", "1", "--sweep-interval", "1"],
    });
    const answering = answerEverything(serve.storageDir, 1);
    const first = await curlPost(serve.baseUrl, chatBody("first"));
    await answering;
    expect(first.status).toBe(200);
    const second = fetch(`${serve.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatBody("second"),
    }).catch(() => undefined);
    await waitFor(async () => (await storedStates(serve.storageDir)).length >= 1);
    await new Promise((resolve) => setTimeout(resolve, 3500));
    expect(await storedStates(serve.storageDir)).toEqual(["waiting"]);
    await serve.stop();
    await second;
  });
});

describe("a restart and a second serve", () => {
  it("ends the requests that waited, prints abandoned lines after the first line, and hides them from answer", async () => {
    const first = await startServe();
    const dropped = fetch(`${first.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: chatBody("left behind"),
    }).catch(() => "dropped");
    await waitFor(async () => (await storedStates(first.storageDir)).length === 1);
    expect(await first.stop()).toBe(130);
    await dropped;
    expect(await storedStates(first.storageDir)).toEqual(["waiting"]);

    const second = await startServe({ storageDir: first.storageDir });
    await waitFor(() => second.stdout().includes("server restarted"));
    const lines = second
      .stdout()
      .split("\n")
      .filter((line) => line !== "");
    expect(lines[0]).toMatch(/^Listening on /);
    expect(lines[1]).toMatch(/^\d\d:\d\d:\d\d abandoned {2}[0-9a-f]{6} {2}server restarted$/);
    expect(await storedStates(first.storageDir)).toEqual(["abandoned"]);
    const answer = startAnswer(first.storageDir, new ScriptedReader([]));
    await waitFor(() => answer.stdout().includes("Waiting for requests..."));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(answer.stdout()).not.toContain("Request 1 of");
  });

  it("stops a second serve on the same storage directory and leaves the first one working", async () => {
    const first = await startServe();
    const t = makeIo();
    const exit = await main(["serve"], t.io, {
      settings: { port: 0, storageDir: first.storageDir },
    });
    expect(exit).toBe(1);
    expect(t.err.lines()).toEqual([
      `Error: ${first.storageDir} is already used by another imbehind serve.`,
    ]);
    expect(t.out.text()).toBe("");
    startAnswer(first.storageDir, new ScriptedReader(["Hi"]));
    const reply = await postChat(first.baseUrl, "Hello");
    expect(reply.status).toBe(200);
  });
});

describe("a reply file written by hand", () => {
  const URL_PATH = "/v1/chat/completions";
  const JSON_REQUEST = {
    model: "whatever",
    messages: [{ role: "user", content: "Did it pass?" }],
    response_format: { type: "json_object" },
  };
  const TEXT_REQUEST = { model: "whatever", messages: [{ role: "user", content: "Hello" }] };

  interface Outcome {
    status: number;
    body: { choices?: { message: { content: string } }[]; error?: Record<string, string> };
  }

  /** Sends a request with curl, and gives the HTTP status and the JSON body. */
  async function curlChat(baseUrl: string, request: unknown): Promise<Outcome> {
    const result = await curl(
      [
        "--silent",
        "--show-error",
        "--max-time",
        "30",
        "-X",
        "POST",
        `${baseUrl}${URL_PATH}`,
        "-H",
        "Content-Type: application/json",
        "--data-binary",
        "@-",
        "--write-out",
        "\n%{http_code}",
      ],
      JSON.stringify(request),
    );
    expect(result.code).toBe(0);
    const split = result.stdout.lastIndexOf("\n");
    return {
      status: Number(result.stdout.slice(split + 1)),
      body: JSON.parse(result.stdout.slice(0, split)) as Outcome["body"],
    };
  }

  const reply = (kind: string, body: string, version = 1) =>
    JSON.stringify({ formatVersion: version, kind, body });

  it("hands a valid reply file to the client and marks the request replied", async () => {
    const serve = await startServe();
    const pending = curlChat(serve.baseUrl, TEXT_REQUEST);
    const id = await waitForRequestId(serve.storageDir);
    await writeReplyByHand(serve.storageDir, id, reply("text", "Hi by hand"));
    const outcome = await pending;
    expect(outcome.status).toBe(200);
    expect(outcome.body.choices?.[0]?.message.content).toBe("Hi by hand");
    expect(await storedStates(serve.storageDir)).toEqual(["replied"]);
    await waitFor(async () =>
      (await requestFiles(serve.storageDir, id)).includes("reply.accepted.json"),
    );
    expect(await requestFiles(serve.storageDir, id)).toEqual([
      "reply.accepted.json",
      "request.json",
      "state.json",
    ]);
    expect(serve.stdout()).toMatch(/replied {4}[0-9a-f]{6}/);
  });

  const invalid: Array<[string, unknown, string, string]> = [
    [
      "JSON that is cut off",
      TEXT_REQUEST,
      '{"formatVersion":1,"kind":"text","body":"Hi"',
      "reply file is not valid JSON",
    ],
    [
      "a body that is not JSON for a request that asks for JSON",
      JSON_REQUEST,
      reply("text", "not json"),
      "reply body is not valid JSON (unexpected character at line 1, column 2)",
    ],
    [
      "a format version this version does not know",
      TEXT_REQUEST,
      reply("text", "Hi", 2),
      "reply file has an unknown format version",
    ],
  ];

  it.each(invalid)(
    "answers 502 invalid_reply for %s, keeps reply.json, and writes the line",
    async (_name, request, content, reason) => {
      const serve = await startServe();
      const pending = curlChat(serve.baseUrl, request);
      const id = await waitForRequestId(serve.storageDir);
      await writeReplyByHand(serve.storageDir, id, content);
      const outcome = await pending;
      expect(outcome.status).toBe(502);
      expect(outcome.body).toEqual({
        error: {
          message: `The reply file was invalid: ${reason}.`,
          type: "server_error",
          code: "invalid_reply",
        },
      });
      expect(await storedStates(serve.storageDir)).toEqual(["invalid_reply"]);
      expect(await requestFiles(serve.storageDir, id)).toEqual([
        "reply.json",
        "request.json",
        "state.json",
      ]);
      const state = JSON.parse(
        await readFile(path.join(serve.storageDir, "requests", id, "state.json"), "utf8"),
      ) as { endReason: string };
      expect(state.endReason).toBe(reason);
      expect(serve.stdout()).toContain(`invalid_reply  ${id.slice(-6)}  ${reason}\n`);
    },
  );

  it("uses only the reply that came first when an answer and a tool both reply", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["from answer"]));
    const outcome = await curlChat(serve.baseUrl, TEXT_REQUEST);
    expect(outcome.body.choices?.[0]?.message.content).toBe("from answer");
    await waitFor(() => answer.stdout().includes("Sent."));
    const id = await waitForRequestId(serve.storageDir);
    await writeReplyByHand(serve.storageDir, id, reply("text", "from a tool"));
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(await storedStates(serve.storageDir)).toEqual(["replied"]);
    const accepted = JSON.parse(
      await readFile(path.join(serve.storageDir, "requests", id, "reply.accepted.json"), "utf8"),
    ) as { body: string; source: string };
    expect(accepted).toMatchObject({ body: "from answer", source: "imbehind-answer" });
  });

  it("refuses a reply file over 10 MB and takes one of exactly 10 MB", async () => {
    const serve = await startServe();
    const head = '{"formatVersion":1,"kind":"text","body":"';
    const tail = '"}';
    const padded = (total: number): string =>
      `${head}${"a".repeat(total - head.length - tail.length)}${tail}`;

    const tooBig = curlChat(serve.baseUrl, TEXT_REQUEST);
    const firstId = await waitForRequestId(serve.storageDir, 0);
    await writeReplyByHand(serve.storageDir, firstId, padded(MAX_FILE_BYTES + 1));
    const refused = await tooBig;
    expect(refused.status).toBe(502);
    expect(refused.body.error?.message).toBe(
      "The reply file was invalid: reply file is larger than 10 MB.",
    );

    const fits = curlChat(serve.baseUrl, TEXT_REQUEST);
    const secondId = await waitForRequestId(serve.storageDir, 1);
    await writeReplyByHand(serve.storageDir, secondId, padded(MAX_FILE_BYTES));
    const accepted = await fits;
    expect(accepted.status).toBe(200);
    expect(accepted.body.choices?.[0]?.message.content.length).toBe(
      MAX_FILE_BYTES - head.length - tail.length,
    );
    expect(await storedStates(serve.storageDir)).toEqual(["invalid_reply", "replied"]);
  });
});

describe("answer when no serve runs", () => {
  it("works while serve runs, and ends with exit 1 and a reason once serve has stopped", async () => {
    const serve = await startServe();
    const running = makeIo(undefined, undefined, false, "interactive");
    const answering = main(["answer"], running.io, { settings: { storageDir: serve.storageDir } });
    await waitFor(() => running.out.text().includes("Waiting for requests..."));
    running.interrupt();
    expect(await answering).toBe(130);

    await serve.stop();
    const stopped = makeIo();
    const exit = await main(["answer"], stopped.io, { settings: { storageDir: serve.storageDir } });
    expect(exit).toBe(1);
    expect(stopped.err.lines()).toEqual([
      `Error: imbehind serve is not running for ${serve.storageDir}.`,
      "Start it with: imbehind serve",
    ]);
    expect(stopped.out.text()).toBe("");
  });
});
