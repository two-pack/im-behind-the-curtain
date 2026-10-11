import { describe, expect, it } from "vitest";
import {
  buildCompletion,
  errorBody,
  parseChatCompletionsRequest,
} from "../src/chat-completions/adapter.js";

function body(value: unknown): string {
  return JSON.stringify(value);
}

function rejectionOf(text: string) {
  const result = parseChatCompletionsRequest(text);
  expect(result.ok).toBe(false);
  if (result.ok) {
    throw new Error("expected a rejection");
  }
  return result.rejection;
}

const VALID = { model: "whatever", messages: [{ role: "user", content: "Hello" }] };

describe("checking the request body", () => {
  it("rejects a body that is not JSON, or not a JSON object", () => {
    for (const text of ["not json", "", "[]", "42", "null", '"text"', "{"]) {
      expect(rejectionOf(text)).toEqual({
        status: 400,
        code: "invalid_request",
        message: "Request body is not valid JSON.",
      });
    }
  });

  it("rejects a missing, non-array or empty messages", () => {
    for (const value of [
      { model: "m" },
      { model: "m", messages: "x" },
      { model: "m", messages: [] },
    ]) {
      expect(rejectionOf(body(value)).message).toBe('"messages" must be a non-empty array.');
    }
  });

  it("rejects a missing or non-string model, and accepts an empty string", () => {
    const messages = VALID.messages;
    expect(rejectionOf(body({ messages })).message).toBe('"model" must be a string.');
    expect(rejectionOf(body({ messages, model: 5 })).message).toBe('"model" must be a string.');
    expect(parseChatCompletionsRequest(body({ messages, model: "" })).ok).toBe(true);
  });

  it("checks messages before model, and stops at the first failed check", () => {
    expect(rejectionOf(body({})).message).toBe('"messages" must be a non-empty array.');
  });

  it("rejects a message that is not an object", () => {
    for (const bad of [5, null, "x", []]) {
      const message = rejectionOf(body({ model: "m", messages: [bad] })).message;
      expect(message).toBe("Each message must be an object.");
    }
  });

  it("rejects an unsupported role and names it", () => {
    const tool = rejectionOf(body({ model: "m", messages: [{ role: "tool", content: "x" }] }));
    expect(tool.message).toBe('Unsupported message role: "tool".');
    expect(tool.code).toBe("invalid_request");
    expect(tool.status).toBe(400);
  });

  it("cuts a long role name to 64 characters", () => {
    const role = "r".repeat(100);
    const message = rejectionOf(body({ model: "m", messages: [{ role, content: "x" }] })).message;
    expect(message).toBe(`Unsupported message role: "${"r".repeat(64)}".`);
  });

  it("does not print a role that is not a string", () => {
    const message = rejectionOf(
      body({ model: "m", messages: [{ role: 7, content: "x" }] }),
    ).message;
    expect(message).toBe('Unsupported message role: "".');
  });

  it("rejects content that is neither a string nor null", () => {
    for (const content of [[{ type: "text", text: "x" }], 5, {}, true]) {
      const message = rejectionOf(
        body({ model: "m", messages: [{ role: "user", content }] }),
      ).message;
      expect(message).toBe("Message content must be a string or null in this version.");
    }
    const missing = rejectionOf(body({ model: "m", messages: [{ role: "user" }] }));
    expect(missing.message).toBe("Message content must be a string or null in this version.");
  });

  it("decides by the first offending message, and by role before content", () => {
    const first = rejectionOf(
      body({
        model: "m",
        messages: [{ role: "user", content: "ok" }, { role: "bad", content: [] }, { content: [] }],
      }),
    );
    expect(first.message).toBe('Unsupported message role: "bad".');
  });
});

describe("converting to the shared form", () => {
  it("keeps roles and order, and turns null content into an empty string", () => {
    const result = parseChatCompletionsRequest(
      body({
        model: "gpt-whatever",
        messages: [
          { role: "system", content: "Be brief." },
          { role: "developer", content: "Reply in English." },
          { role: "user", content: null },
          { role: "assistant", content: "Sure." },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.request.conversation).toEqual([
      { role: "system", content: "Be brief." },
      { role: "developer", content: "Reply in English." },
      { role: "user", content: "" },
      { role: "assistant", content: "Sure." },
    ]);
    expect(result.request.format).toBe("chat.completions");
    expect(result.request.model).toBe("gpt-whatever");
    expect(result.request.replyKind).toBe("text");
    expect(result.request.requiredShape).toBeNull();
    expect(result.request.includeUsage).toBe(false);
  });

  it("ignores unknown fields and treats stream as false", () => {
    const original = {
      ...VALID,
      stream: true,
      temperature: 0.2,
      n: 3,
      tools: [{ type: "function" }],
      response_format: { type: "json_object" },
      surprise: { nested: true },
    };
    const result = parseChatCompletionsRequest(body(original));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.stream).toBe(false);
      expect(result.request.replyKind).toBe("text");
      expect(result.request.originalRequest).toEqual(original);
    }
  });
});

describe("building the response", () => {
  it("builds a Chat Completions body with zero usage", () => {
    const completion = buildCompletion({
      requestId: "20261009T140512123Z-a1b2c3",
      model: "whatever",
      content: "Hi",
      nowSeconds: 1791813940,
    });
    expect(completion).toEqual({
      id: "chatcmpl-20261009T140512123Z-a1b2c3",
      object: "chat.completion",
      created: 1791813940,
      model: "whatever",
      choices: [{ index: 0, message: { role: "assistant", content: "Hi" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });
});

describe("building an error body", () => {
  it("uses invalid_request_error for client mistakes and server_error for storage", () => {
    expect(errorBody("invalid_request", "bad")).toEqual({
      error: { message: "bad", type: "invalid_request_error", code: "invalid_request" },
    });
    expect(errorBody("not_found", "Not found.").error.type).toBe("invalid_request_error");
    expect(errorBody("method_not_allowed", "x").error.type).toBe("invalid_request_error");
    expect(errorBody("storage_error", "The request could not be stored.")).toEqual({
      error: {
        message: "The request could not be stored.",
        type: "server_error",
        code: "storage_error",
      },
    });
  });
});
