import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { waitFor } from "../helpers/io.js";
import { ScriptedReader } from "../helpers/scripted-reader.js";
import { startAnswer, startServe } from "../helpers/system.js";

describe("a round trip with the official OpenAI SDK (NFR4.2)", () => {
  it("reads the response without an error and gets the typed text", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["Hi"]));
    const client = new OpenAI({
      apiKey: "any-key-is-accepted",
      baseURL: `${serve.baseUrl}/v1`,
      maxRetries: 0,
      timeout: 20_000,
    });

    const completion = await client.chat.completions.create({
      model: "whatever",
      messages: [{ role: "user", content: "Hello" }],
    });

    expect(completion.choices[0]?.message.content).toBe("Hi");
    expect(completion.choices[0]?.message.role).toBe("assistant");
    expect(completion.choices[0]?.finish_reason).toBe("stop");
    expect(completion.model).toBe("whatever");
    expect(completion.usage).toEqual({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    await waitFor(() => answer.stdout().includes("Sent."));
  });

  function clientFor(baseUrl: string): OpenAI {
    return new OpenAI({
      apiKey: "any-key-is-accepted",
      baseURL: `${baseUrl}/v1`,
      maxRetries: 0,
      timeout: 20_000,
    });
  }

  it("returns structured output to the SDK without streaming", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(['{"passed": true}']));
    const completion = await clientFor(serve.baseUrl).chat.completions.create({
      model: "whatever",
      messages: [{ role: "user", content: "Did it pass?" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "result",
          strict: true,
          schema: { type: "object", properties: { passed: { type: "boolean" } } },
        },
      },
    });
    expect(completion.choices[0]?.message.content).toBe('{"passed": true}');
    expect(JSON.parse(completion.choices[0]?.message.content ?? "")).toEqual({ passed: true });
    await waitFor(() => answer.stdout().includes("Sent."));
    expect(answer.stdout()).toContain("Reply:    JSON");
  });

  it("reads a streamed response chunk by chunk and gets the typed text (NFR4.2)", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["Hi"]));
    const stream = await clientFor(serve.baseUrl).chat.completions.create({
      model: "whatever",
      messages: [{ role: "user", content: "Hello" }],
      stream: true,
    });
    const chunks = [];
    let text = "";
    for await (const chunk of stream) {
      chunks.push(chunk);
      text += chunk.choices[0]?.delta?.content ?? "";
    }
    expect(text).toBe("Hi");
    expect(chunks).toHaveLength(3);
    expect(chunks[0]?.choices[0]?.delta?.role).toBe("assistant");
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe("stop");
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
    await waitFor(() => answer.stdout().includes("Sent."));
  });

  it("reads the usage chunk of a streamed response when asked, and a streamed structured output", async () => {
    const serve = await startServe();
    startAnswer(serve.storageDir, new ScriptedReader(['{"ok": 1}']));
    const stream = await clientFor(serve.baseUrl).chat.completions.create({
      model: "whatever",
      messages: [{ role: "user", content: "Hello" }],
      response_format: { type: "json_object" },
      stream: true,
      stream_options: { include_usage: true },
    });
    const chunks = [];
    let text = "";
    for await (const chunk of stream) {
      chunks.push(chunk);
      text += chunk.choices[0]?.delta?.content ?? "";
    }
    expect(text).toBe('{"ok": 1}');
    expect(chunks).toHaveLength(4);
    expect(chunks.at(-1)?.choices).toEqual([]);
    expect(chunks.at(-1)?.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("reads an error response as an SDK error without sending the request again", async () => {
    const serve = await startServe();
    const client = new OpenAI({
      apiKey: "k",
      baseURL: `${serve.baseUrl}/v1`,
      maxRetries: 0,
      timeout: 20_000,
    });
    await expect(
      client.chat.completions.create({
        model: "whatever",
        messages: [{ role: "tool", content: "x", tool_call_id: "1" }],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
