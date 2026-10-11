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
