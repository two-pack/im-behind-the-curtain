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
