import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BarrierReader } from "../helpers/barrier-reader.js";
import { FakeClock } from "../helpers/fake-clock.js";
import { waitFor } from "../helpers/io.js";
import { ScriptedReader } from "../helpers/scripted-reader.js";
import { answerEverything, startAnswer, startServe, storedStates } from "../helpers/system.js";

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
    choices?: { message: { content: string } }[];
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

describe("requests that are turned away as unsupported", () => {
  const TOOLS = "Tool calls are not supported. Send the request without tools.";
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

  it("refuses an image part", async () => {
    const content = [
      { type: "text", text: "What is this?" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
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

  it("refuses tools", async () => {
    await refusedAs({ messages: [USER], tools: [{ type: "function" }] }, TOOLS);
  });

  it("refuses a message with the role tool", async () => {
    await refusedAs(
      { messages: [USER, { role: "tool", content: "42", tool_call_id: "1" }] },
      TOOLS,
    );
  });

  it("refuses functions and a message with the role function", async () => {
    await refusedAs({ messages: [USER], functions: [{ name: "f" }] }, TOOLS);
    await refusedAs({ messages: [{ role: "function", name: "f", content: "42" }] }, TOOLS);
  });

  it("refuses an assistant message with tool_calls or function_call", async () => {
    const calls = [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }];
    await refusedAs({ messages: [USER, { role: "assistant", tool_calls: calls }] }, TOOLS);
    await refusedAs(
      { messages: [USER, { role: "assistant", function_call: { name: "f" } }] },
      TOOLS,
    );
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
