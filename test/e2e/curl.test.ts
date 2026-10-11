import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { waitFor } from "../helpers/io.js";
import { ScriptedReader } from "../helpers/scripted-reader.js";
import { startAnswer, startServe } from "../helpers/system.js";

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
