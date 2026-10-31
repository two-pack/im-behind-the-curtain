import { readFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import type { ChatCompletionContentPart } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import { waitFor } from "../helpers/io.js";
import {
  everyKindOfPart,
  FILE_ID,
  listenForConnections,
  PDF_BASE64,
  WAV_BASE64,
} from "../helpers/media-parts.js";
import { ScriptedReader } from "../helpers/scripted-reader.js";
import {
  answerEverything,
  startAnswer,
  startServe,
  storedStates,
  waitForRequestId,
  writeReplyByHand,
} from "../helpers/system.js";

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
        messages: [{ role: "user", content: "Hi" }],
        n: 2,
      }),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_request",
      type: "invalid_request_error",
    });
  });

  it("accepts an image as a data URL, saves it, and returns the typed reply", async () => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["It is a pixel."]));
    const completion = await clientFor(serve.baseUrl).chat.completions.create({
      model: "whatever",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is this?" },
            {
              type: "image_url",
              image_url: { url: `data:image/png;base64,${png}`, detail: "low" },
            },
          ],
        },
      ],
    });
    expect(completion.choices[0]?.message.content).toBe("It is a pixel.");
    await waitFor(() => answer.stdout().includes("Sent."));
    const id = await waitForRequestId(serve.storageDir);
    const saved = path.join(serve.storageDir, "requests", id, "message-1-part-2.png");
    const bytes = Buffer.from(png, "base64");
    expect(await readFile(saved)).toEqual(bytes);
    expect(answer.stdout()).toContain(
      `  [image] image/png, ${bytes.length} bytes\n    saved: ${saved}\n`,
    );
  });

  it("accepts audio, a file, an address, a file_id, unreadable parts and an unknown type", async () => {
    const listener = await listenForConnections();
    try {
      const serve = await startServe();
      const answer = startAnswer(serve.storageDir, new ScriptedReader(["Heard."]));
      // The SDK types know the first four kinds; the last ones are sent as the raw shapes.
      const content = everyKindOfPart(listener.address) as unknown as ChatCompletionContentPart[];
      const completion = await clientFor(serve.baseUrl).chat.completions.create({
        model: "whatever",
        messages: [{ role: "user", content }],
      });
      expect(completion.choices[0]?.message.content).toBe("Heard.");
      await waitFor(() => answer.stdout().includes("Sent."));
      const id = await waitForRequestId(serve.storageDir);
      const dir = path.join(serve.storageDir, "requests", id);
      expect(await readFile(path.join(dir, "message-1-part-2.wav"))).toEqual(
        Buffer.from(WAV_BASE64, "base64"),
      );
      expect(await readFile(path.join(dir, "message-1-part-3.pdf"))).toEqual(
        Buffer.from(PDF_BASE64, "base64"),
      );
      const shown = answer.stdout();
      expect(shown).toContain(
        `  [audio] audio/wav, 4 bytes\n    saved: ${path.join(dir, "message-1-part-2.wav")}\n`,
      );
      expect(shown).toContain(`  [image] ${listener.address}\n  [file] file_id: ${FILE_ID}\n`);
      expect(shown).toContain("  [file] (unreadable)\n  [audio] (unreadable)\n  [video_url]\n");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(listener.connections()).toBe(0);
    } finally {
      await listener.close();
    }
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

describe("tools with the official OpenAI SDK", () => {
  const TOOLS = [
    {
      type: "function" as const,
      function: {
        name: "get_weather",
        parameters: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      },
    },
  ];
  const MESSAGES = [{ role: "user" as const, content: "What is the weather in Tokyo?" }];
  const CALLS = [
    {
      id: "call_1",
      type: "function",
      function: {
        name: "get_weather",
        arguments: '{"city": "Tokyo"}',
        note: "extra",
      },
    },
    {
      id: "call_2",
      type: "function",
      function: { name: "get_time", arguments: "{}" },
    },
  ];

  function client(baseUrl: string): OpenAI {
    return new OpenAI({
      apiKey: "k",
      baseURL: `${baseUrl}/v1`,
      maxRetries: 0,
      timeout: 20_000,
    });
  }

  it("reads tool_calls from a response that is not streamed", async () => {
    const serve = await startServe();
    startAnswer(serve.storageDir, new ScriptedReader([JSON.stringify(CALLS)]));
    const completion = await client(serve.baseUrl).chat.completions.create({
      model: "whatever",
      messages: MESSAGES,
      tools: TOOLS,
    });
    const choice = completion.choices[0];
    expect(choice?.finish_reason).toBe("tool_calls");
    expect(choice?.message.content).toBeNull();
    expect(choice?.message.tool_calls).toEqual(CALLS);
  });

  it("builds the tool_calls of a streamed response, and drops the extra fields", async () => {
    const serve = await startServe();
    startAnswer(serve.storageDir, new ScriptedReader([JSON.stringify(CALLS)]));
    const stream = client(serve.baseUrl).chat.completions.stream({
      model: "whatever",
      messages: MESSAGES,
      tools: TOOLS,
    });
    const completion = await stream.finalChatCompletion();
    const choice = completion.choices[0];
    expect(choice?.finish_reason).toBe("tool_calls");
    expect(choice?.message.content).toBeNull();
    expect(choice?.message.tool_calls).toEqual([
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city": "Tokyo"}' },
      },
      {
        id: "call_2",
        type: "function",
        function: { name: "get_time", arguments: "{}" },
      },
    ]);
  });

  it("sends one chunk per call with an index, an id, a name and the whole arguments", async () => {
    const serve = await startServe();
    startAnswer(serve.storageDir, new ScriptedReader([JSON.stringify(CALLS)]));
    const stream = await client(serve.baseUrl).chat.completions.create({
      model: "whatever",
      messages: MESSAGES,
      tools: TOOLS,
      stream: true,
    });
    const deltas = [];
    let finish: string | null | undefined;
    for await (const chunk of stream) {
      deltas.push(chunk.choices[0]?.delta);
      finish = chunk.choices[0]?.finish_reason ?? finish;
    }
    expect(deltas[0]).toMatchObject({ role: "assistant", content: null });
    expect(deltas[1]?.tool_calls).toEqual([
      {
        index: 0,
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: '{"city": "Tokyo"}' },
      },
    ]);
    expect(deltas[2]?.tool_calls?.[0]).toMatchObject({
      index: 1,
      id: "call_2",
    });
    expect(finish).toBe("tool_calls");
  });

  it("reads function_call from a request that defines functions only, also streamed", async () => {
    const serve = await startServe();
    const one = JSON.stringify([CALLS[0]]);
    startAnswer(serve.storageDir, new ScriptedReader([one, one]));
    const completion = await client(serve.baseUrl).chat.completions.create({
      model: "whatever",
      messages: MESSAGES,
      functions: [{ name: "get_weather" }],
    });
    expect(completion.choices[0]?.finish_reason).toBe("function_call");
    expect(completion.choices[0]?.message.function_call).toEqual({
      name: "get_weather",
      arguments: '{"city": "Tokyo"}',
    });
    const streamed = await client(serve.baseUrl)
      .chat.completions.stream({
        model: "whatever",
        messages: MESSAGES,
        functions: [{ name: "get_weather" }],
      })
      .finalChatCompletion();
    expect(streamed.choices[0]?.message.function_call).toEqual({
      name: "get_weather",
      arguments: '{"city": "Tokyo"}',
    });
  });

  it("sends the result of a tool back and gets a text answer", async () => {
    const serve = await startServe();
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["It is sunny."]));
    const completion = await client(serve.baseUrl).chat.completions.create({
      model: "whatever",
      tools: TOOLS,
      messages: [
        ...MESSAGES,
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city": "Tokyo"}' },
            },
          ],
        },
        { role: "tool", tool_call_id: "call_1", content: "sunny, 24 C" },
      ],
    });
    expect(completion.choices[0]?.message.content).toBe("It is sunny.");
    expect(completion.choices[0]?.finish_reason).toBe("stop");
    await waitFor(() => answer.stdout().includes("Sent."));
    expect(answer.stdout()).toContain("Tool:\n  sunny, 24 C\n");
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

describe("a reply file written by hand, seen by the official OpenAI SDK", () => {
  it("raises a typed server error for an invalid reply file and does not send the request again", async () => {
    const serve = await startServe();
    const client = new OpenAI({
      apiKey: "any-key-is-accepted",
      baseURL: `${serve.baseUrl}/v1`,
      maxRetries: 0,
      timeout: 20_000,
    });
    const pending = client.chat.completions.create({
      model: "whatever",
      messages: [{ role: "user", content: "Hello" }],
    });
    const failure = pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    const id = await waitForRequestId(serve.storageDir);
    await writeReplyByHand(serve.storageDir, id, '{"formatVersion":1,"kind":"text","body":');

    const error = await failure;
    expect(error).toBeInstanceOf(OpenAI.InternalServerError);
    expect(error).toMatchObject({
      status: 502,
      code: "invalid_reply",
      type: "server_error",
    });
    expect((error as Error).message).toContain(
      "The reply file was invalid: reply file is not valid JSON.",
    );
    expect(await storedStates(serve.storageDir)).toEqual(["invalid_reply"]);
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
