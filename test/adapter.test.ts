import { describe, expect, it } from "vitest";
import {
  buildCompletion,
  buildStreamEvents,
  errorBody,
  MESSAGES,
  parseChatCompletionsRequest,
  replyTimeoutMessage,
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

  it("rejects content that is not a string, null, or an array of text parts", () => {
    for (const content of [5, {}, true]) {
      const message = rejectionOf(
        body({ model: "m", messages: [{ role: "user", content }] }),
      ).message;
      expect(message).toBe("Message content must be a string, null, or an array of text parts.");
    }
    const missing = rejectionOf(body({ model: "m", messages: [{ role: "user" }] }));
    expect(missing.message).toBe(
      "Message content must be a string, null, or an array of text parts.",
    );
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

describe("the content of a message", () => {
  const CONTENT_MESSAGE = "Message content must be a string, null, or an array of text parts.";

  function conversationOf(content: unknown) {
    const result = parseChatCompletionsRequest(
      body({ model: "m", messages: [{ role: "user", content }] }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error("expected the request to be accepted");
    }
    return result.request.conversation;
  }

  it("joins the text of an array of text parts without a separator", () => {
    const parts = [
      { type: "text", text: "Hello, " },
      { type: "text", text: "world" },
    ];
    expect(conversationOf(parts)).toEqual([{ role: "user", content: "Hello, world" }]);
  });

  it("keeps a null content and an empty array as an empty string", () => {
    expect(conversationOf(null)).toEqual([{ role: "user", content: "" }]);
    expect(conversationOf([])).toEqual([{ role: "user", content: "" }]);
  });

  it("rejects a part that is not a text part", () => {
    const bad: unknown[] = [
      [{ type: "image_url", image_url: { url: "x" } }],
      [{ type: "text", text: "a" }, { type: "input_audio" }],
      [{ type: "text" }],
      [{ type: "text", text: 5 }],
      [{ text: "no type" }],
      ["a string part"],
      [null],
      [[{ type: "text", text: "nested" }]],
    ];
    for (const content of bad) {
      const rejection = rejectionOf(body({ model: "m", messages: [{ role: "user", content }] }));
      expect(rejection).toEqual({ status: 400, code: "invalid_request", message: CONTENT_MESSAGE });
    }
  });
});

describe("the n field", () => {
  function withN(extra: Record<string, unknown>) {
    return parseChatCompletionsRequest(body({ ...VALID, ...extra }));
  }

  it("rejects an n of 2 or more with a fixed message", () => {
    for (const n of [2, 3, 100, 2.5]) {
      expect(rejectionOf(body({ ...VALID, n }))).toEqual({
        status: 400,
        code: "invalid_request",
        message: 'Only one choice can be returned; "n" must be 1.',
      });
    }
  });

  it("accepts an n that is 1, less than 1, null, not a number, or missing", () => {
    for (const extra of [{ n: 1 }, { n: 0 }, { n: -4 }, { n: 1.5 }, { n: null }, { n: "2" }, {}]) {
      expect(withN(extra).ok).toBe(true);
    }
  });
});

describe("the order of the checks", () => {
  const BAD_N = { n: 2 };

  it("checks messages, then model, then each message, then n", () => {
    expect(rejectionOf(body({ ...BAD_N })).message).toBe('"messages" must be a non-empty array.');
    expect(rejectionOf(body({ ...BAD_N, messages: VALID.messages })).message).toBe(
      '"model" must be a string.',
    );
    expect(
      rejectionOf(body({ ...BAD_N, model: "m", messages: [{ role: "critic", content: 5 }] }))
        .message,
    ).toBe('Unsupported message role: "critic".');
    expect(
      rejectionOf(body({ ...BAD_N, model: "m", messages: [{ role: "user", content: 5 }] })).message,
    ).toBe("Message content must be a string, null, or an array of text parts.");
    expect(rejectionOf(body({ ...VALID, ...BAD_N })).message).toBe(
      'Only one choice can be returned; "n" must be 1.',
    );
  });

  it("decides by the first message that fails, even when a later one fails differently", () => {
    const messages = [
      { role: "user", content: "ok" },
      { role: "user", content: 5 },
      { role: "critic", content: "x" },
    ];
    expect(rejectionOf(body({ model: "m", messages })).message).toBe(
      "Message content must be a string, null, or an array of text parts.",
    );
  });
});

describe("unknown fields", () => {
  it("accepts unknown fields at the top and inside a message, and keeps only role and content", () => {
    const result = parseChatCompletionsRequest(
      body({
        model: "m",
        foo: "bar",
        messages: [{ role: "user", content: "Hi", name: "alice", foo: { deep: true } }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.conversation).toEqual([{ role: "user", content: "Hi" }]);
      expect(result.request.originalRequest).toMatchObject({ foo: "bar" });
    }
  });
});

describe("the required shape of a json request", () => {
  const SCHEMA = {
    type: "object",
    properties: { passed: { type: "boolean" } },
    required: ["passed"],
  };

  function parsed(responseFormat: unknown) {
    const result = parseChatCompletionsRequest(body({ ...VALID, response_format: responseFormat }));
    if (!result.ok) {
      throw new Error("expected the request to be accepted");
    }
    return result.request;
  }

  it("keeps the content of schema as the required shape", () => {
    const request = parsed({ type: "json_schema", json_schema: { name: "x", schema: SCHEMA } });
    expect(request.replyKind).toBe("json");
    expect(request.requiredShape).toEqual(SCHEMA);
  });

  it("keeps the whole json_schema object when there is no schema inside it", () => {
    const wrapper = { name: "x", strict: true };
    expect(parsed({ type: "json_schema", json_schema: wrapper }).requiredShape).toEqual(wrapper);
  });

  it("has no required shape when json_schema or schema is not an object, or for json_object", () => {
    for (const responseFormat of [
      { type: "json_schema" },
      { type: "json_schema", json_schema: "x" },
      { type: "json_schema", json_schema: { name: "x", schema: "not an object" } },
      { type: "json_object" },
    ]) {
      const request = parsed(responseFormat);
      expect(request.replyKind).toBe("json");
      expect(request.requiredShape).toBeNull();
    }
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

  it("ignores unknown fields", () => {
    const original = {
      ...VALID,
      temperature: 0.2,
      n: 1,
      tools: [{ type: "function" }],
      response_format: { type: "json_object" },
      surprise: { nested: true },
    };
    const result = parseChatCompletionsRequest(body(original));
    expect(result.ok).toBe(true);
    if (result.ok) {
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

  it("builds the 503 and 504 bodies as server errors", () => {
    expect(errorBody("skipped_by_human", MESSAGES.skipped)).toEqual({
      error: {
        message: "The human skipped this request.",
        type: "server_error",
        code: "skipped_by_human",
      },
    });
    expect(errorBody("reply_timeout", replyTimeoutMessage(1800))).toEqual({
      error: {
        message: "No reply within 1800 seconds. Increase the server timeout or reply sooner.",
        type: "server_error",
        code: "reply_timeout",
      },
    });
  });

  it("builds the 413 body for a request that is too large", () => {
    expect(errorBody("request_too_large", MESSAGES.requestTooLarge)).toEqual({
      error: {
        message: "Request body is larger than 10 MB.",
        type: "invalid_request_error",
        code: "request_too_large",
      },
    });
  });
});

describe("the reply kind", () => {
  function kindOf(extra: Record<string, unknown>) {
    const result = parseChatCompletionsRequest(body({ ...VALID, ...extra }));
    if (!result.ok) {
      throw new Error("expected the request to be accepted");
    }
    return result.request.replyKind;
  }

  it("is json for response_format json_schema and json_object", () => {
    expect(kindOf({ response_format: { type: "json_schema" } })).toBe("json");
    expect(kindOf({ response_format: { type: "json_object" } })).toBe("json");
  });

  it("is text for any other type, a missing type, no response_format, or a non-object", () => {
    for (const responseFormat of [
      { type: "text" },
      { type: "other" },
      { type: 5 },
      {},
      "json_object",
      ["json_object"],
      null,
      5,
    ]) {
      expect(kindOf({ response_format: responseFormat })).toBe("text");
    }
    expect(kindOf({})).toBe("text");
  });
});

describe("reading stream and include_usage", () => {
  function flags(extra: Record<string, unknown>) {
    const result = parseChatCompletionsRequest(body({ ...VALID, ...extra }));
    if (!result.ok) {
      throw new Error("expected the request to be accepted");
    }
    return { stream: result.request.stream, includeUsage: result.request.includeUsage };
  }

  it("reads stream true, and include_usage only together with it", () => {
    expect(flags({ stream: true })).toEqual({ stream: true, includeUsage: false });
    expect(flags({ stream: true, stream_options: { include_usage: true } })).toEqual({
      stream: true,
      includeUsage: true,
    });
    expect(flags({ stream: true, stream_options: { include_usage: false } })).toEqual({
      stream: true,
      includeUsage: false,
    });
  });

  it("ignores include_usage when stream is false or missing", () => {
    expect(flags({ stream: false, stream_options: { include_usage: true } })).toEqual({
      stream: false,
      includeUsage: false,
    });
    expect(flags({ stream_options: { include_usage: true } })).toEqual({
      stream: false,
      includeUsage: false,
    });
  });

  it("reads only the value true: other values mean no stream and no usage", () => {
    expect(flags({ stream: "true" }).stream).toBe(false);
    expect(flags({ stream: 1 }).stream).toBe(false);
    expect(flags({ stream: true, stream_options: "yes" }).includeUsage).toBe(false);
    expect(flags({ stream: true, stream_options: { include_usage: "true" } }).includeUsage).toBe(
      false,
    );
  });
});

describe("building the stream", () => {
  const INPUT = {
    requestId: "20261009T140640321Z-d4e5f6",
    model: "whatever",
    content: "Hi\nthere",
    nowSeconds: 1791814000,
    includeUsage: false,
  };

  function parsed(events: string[]) {
    return events.map((event) => {
      expect(event.startsWith("data: ")).toBe(true);
      expect(event.endsWith("\n\n")).toBe(true);
      const text = event.slice("data: ".length, -2);
      return text === "[DONE]" ? text : (JSON.parse(text) as Record<string, unknown>);
    });
  }

  it("makes role, one content, stop and [DONE], each as one line and a blank line", () => {
    const events = buildStreamEvents(INPUT);
    expect(events).toHaveLength(4);
    for (const event of events) {
      expect(event.slice(0, -2)).not.toContain("\n");
    }
    const id = "chatcmpl-20261009T140640321Z-d4e5f6";
    const common = { id, object: "chat.completion.chunk", created: 1791814000, model: "whatever" };
    expect(parsed(events)).toEqual([
      {
        ...common,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      },
      { ...common, choices: [{ index: 0, delta: { content: "Hi\nthere" }, finish_reason: null }] },
      { ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
      "[DONE]",
    ]);
    expect(events[3]).toBe("data: [DONE]\n\n");
  });

  it("adds a usage chunk with empty choices and zero values only when asked", () => {
    const events = parsed(buildStreamEvents({ ...INPUT, includeUsage: true }));
    expect(events).toHaveLength(5);
    expect(events[3]).toEqual({
      id: "chatcmpl-20261009T140640321Z-d4e5f6",
      object: "chat.completion.chunk",
      created: 1791814000,
      model: "whatever",
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    expect(events[4]).toBe("[DONE]");
  });

  it("uses the same id, created and model in every chunk, and keeps the whole reply in one chunk", () => {
    const chunks = parsed(
      buildStreamEvents({ ...INPUT, includeUsage: true, content: "a".repeat(5000) }),
    ).filter((chunk) => chunk !== "[DONE]") as Record<string, unknown>[];
    expect(new Set(chunks.map((chunk) => chunk.id)).size).toBe(1);
    expect(new Set(chunks.map((chunk) => chunk.created)).size).toBe(1);
    expect(new Set(chunks.map((chunk) => chunk.model)).size).toBe(1);
    const contents = chunks.flatMap((chunk) =>
      (chunk.choices as { delta: { content?: string } }[]).map((choice) => choice.delta.content),
    );
    expect(contents.filter((content) => content === "a".repeat(5000))).toHaveLength(1);
  });
});
