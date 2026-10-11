import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { waitFor } from "../helpers/io.js";
import { ScriptedReader } from "../helpers/scripted-reader.js";
import { answerEverything, startAnswer, startServe, storedStates } from "../helpers/system.js";

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
    ).rejects.toMatchObject({
      status: 400,
      code: "unsupported_content",
      type: "invalid_request_error",
    });
  });

  it("accepts a message whose content is an array of text parts", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["Hi"]));
    const completion = await clientFor(serve.baseUrl).chat.completions.create({
      model: "whatever",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Hello, " },
            { type: "text", text: "world" },
          ],
        },
      ],
    });
    expect(completion.choices[0]?.message.content).toBe("Hi");
    await waitFor(() => answer.stdout().includes("Sent."));
    expect(answer.stdout()).toContain("User:\n  Hello, world\n");
  });
});

describe("many requests, skipping and waiting too long with the OpenAI SDK", () => {
  // The SDK sends a request again after a 503 or a 504 unless maxRetries is 0.
  function client(baseUrl: string): OpenAI {
    return new OpenAI({ apiKey: "k", baseURL: `${baseUrl}/v1`, maxRetries: 0, timeout: 20_000 });
  }

  it("gives each of ten simultaneous requests its own answer (NFR8.1)", async () => {
    const serve = await startServe();
    const answering = answerEverything(serve.storageDir, 10);
    const questions = Array.from({ length: 10 }, (_, index) => `question ${index}`);

    const completions = await Promise.all(
      questions.map((question) =>
        client(serve.baseUrl).chat.completions.create({
          model: "whatever",
          messages: [{ role: "user", content: question }],
        }),
      ),
    );
    await answering;

    completions.forEach((completion, index) => {
      expect(completion.choices[0]?.message.content).toBe(`answer to question ${index}`);
    });
    expect(new Set(completions.map((completion) => completion.id)).size).toBe(10);
  });

  it("raises a 503 error with the code skipped_by_human when the human skips, also for a stream", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["EOF", "y", "EOF", "y"]));
    await expect(
      client(serve.baseUrl).chat.completions.create({
        model: "whatever",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).rejects.toMatchObject({ status: 503, code: "skipped_by_human", type: "server_error" });
    await expect(
      client(serve.baseUrl).chat.completions.create({
        model: "whatever",
        messages: [{ role: "user", content: "Hello again" }],
        stream: true,
      }),
    ).rejects.toMatchObject({ status: 503, code: "skipped_by_human" });
    await waitFor(() => answer.stdout().split("Skipped.").length - 1 === 2);
    expect(await storedStates(serve.storageDir)).toEqual(["skipped", "skipped"]);
  });

  it("raises a 504 error with the code reply_timeout after the wait limit", async () => {
    const serve = await startServe({ args: ["--timeout", "1"] });
    await expect(
      client(serve.baseUrl).chat.completions.create({
        model: "whatever",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).rejects.toMatchObject({
      status: 504,
      code: "reply_timeout",
      message: expect.stringContaining(
        "No reply within 1 seconds. Increase the server timeout or reply sooner.",
      ),
    });
    expect(await storedStates(serve.storageDir)).toEqual(["timed_out"]);
  });

  it("ends the request as cancelled when the SDK gives up waiting", async () => {
    const serve = await startServe();
    const impatient = new OpenAI({
      apiKey: "k",
      baseURL: `${serve.baseUrl}/v1`,
      maxRetries: 0,
      timeout: 500,
    });
    await expect(
      impatient.chat.completions.create({
        model: "whatever",
        messages: [{ role: "user", content: "Hello" }],
      }),
    ).rejects.toBeInstanceOf(OpenAI.APIConnectionTimeoutError);
    await waitFor(async () => (await storedStates(serve.storageDir))[0] === "cancelled");
    expect(serve.stdout()).toMatch(/cancelled {2}[0-9a-f]{6} {2}client disconnected\n/);
  });
});

describe("the model list with the official OpenAI SDK", () => {
  it("reads the list of models without an error", async () => {
    const serve = await startServe();
    const client = new OpenAI({
      apiKey: "any-key-is-accepted",
      baseURL: `${serve.baseUrl}/v1`,
      maxRetries: 0,
      timeout: 20_000,
    });

    const page = await client.models.list();
    expect(page.data).toEqual([
      { id: "imbehind", object: "model", created: 1791800000, owned_by: "imbehind" },
    ]);

    const seen: string[] = [];
    for await (const model of client.models.list()) {
      seen.push(model.id);
    }
    expect(seen).toEqual(["imbehind"]);
    expect(await storedStates(serve.storageDir).catch(() => [])).toEqual([]);
  });
});
