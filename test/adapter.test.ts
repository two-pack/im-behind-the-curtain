import { describe, expect, it, vi } from "vitest";
import {
  buildCompletion,
  buildModelList,
  buildStreamEvents,
  errorBody,
  MESSAGES,
  parseChatCompletionsRequest,
  replyTimeoutMessage,
} from "../src/chat-completions/adapter.js";
import { readDataUrl } from "../src/media-parts.js";

vi.mock("../src/media-parts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/media-parts.js")>();
  return { ...actual, readDataUrl: vi.fn(actual.readDataUrl) };
});

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
    const critic = rejectionOf(body({ model: "m", messages: [{ role: "critic", content: "x" }] }));
    expect(critic.message).toBe('Unsupported message role: "critic".');
    expect(critic.code).toBe("invalid_request");
    expect(critic.status).toBe(400);
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
      expect(message).toBe("Message content must be a string, null, or an array of content parts.");
    }
    const missing = rejectionOf(body({ model: "m", messages: [{ role: "user" }] }));
    expect(missing.message).toBe(
      "Message content must be a string, null, or an array of content parts.",
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
  const CONTENT_MESSAGE = "Message content must be a string, null, or an array of content parts.";

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

  it("rejects a malformed part, as before", () => {
    const bad: unknown[] = [
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
    ).toBe("Message content must be a string, null, or an array of content parts.");
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
      "Message content must be a string, null, or an array of content parts.",
    );
  });
});

describe("requests that are turned away", () => {
  const IMAGE_PART = { type: "image_url", image_url: { url: "https://example.com/a.png" } };
  const ROLE_CRITIC = 'Unsupported message role: "critic".';
  const CONTENT = "Message content must be a string, null, or an array of content parts.";

  function invalid(message: string) {
    return { status: 400, code: "invalid_request", message };
  }

  function turnedAway(messages: unknown[], extra: Record<string, unknown> = {}) {
    return rejectionOf(body({ model: "m", messages, ...extra }));
  }

  function accepted(messages: unknown[], extra: Record<string, unknown> = {}) {
    return parseChatCompletionsRequest(body({ model: "m", messages, ...extra })).ok;
  }

  function acceptedRequest(messages: unknown[], extra: Record<string, unknown> = {}) {
    const result = parseChatCompletionsRequest(body({ model: "m", messages, ...extra }));
    if (!result.ok) {
      throw new Error(`expected the request to be accepted: ${result.rejection.message}`);
    }
    return result.request;
  }

  it("accepts a message with the role tool or function, and keeps its tool fields", () => {
    for (const role of ["tool", "function"]) {
      const request = acceptedRequest([{ role, content: "x", tool_call_id: "call_1", name: "f" }]);
      expect(request.conversation).toEqual([
        { role, content: "x", tool_call_id: "call_1", name: "f" },
      ]);
    }
    expect(
      acceptedRequest([{ role: "tool", content: [{ type: "text", text: "a" }] }]).conversation,
    ).toEqual([{ role: "tool", content: "a" }]);
  });

  it("still turns away a tool message that has no content, but takes an image in one", () => {
    expect(turnedAway([{ role: "tool" }])).toEqual(invalid(CONTENT));
    expect(turnedAway([{ role: "function", name: "f" }])).toEqual(invalid(CONTENT));
    expect(accepted([{ role: "tool", content: [IMAGE_PART] }])).toBe(true);
  });

  it("treats a role that differs only in case as an unknown role", () => {
    expect(turnedAway([{ role: "Tool", content: "x" }])).toEqual(
      invalid('Unsupported message role: "Tool".'),
    );
  });

  it("accepts an assistant message with tool_calls or function_call, with or without content", () => {
    const calls = [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }];
    const call = { name: "f", arguments: "{}" };
    expect(acceptedRequest([{ role: "assistant", tool_calls: calls }]).conversation).toEqual([
      { role: "assistant", content: "", tool_calls: calls },
    ]);
    expect(
      acceptedRequest([{ role: "assistant", content: null, tool_calls: calls }]).conversation,
    ).toEqual([{ role: "assistant", content: "", tool_calls: calls }]);
    expect(
      acceptedRequest([{ role: "assistant", content: "x", tool_calls: calls }]).conversation,
    ).toEqual([{ role: "assistant", content: "x", tool_calls: calls }]);
    expect(acceptedRequest([{ role: "assistant", function_call: call }]).conversation).toEqual([
      { role: "assistant", content: "", function_call: call },
    ]);
  });

  it("still turns away an assistant message with no content and no tool call", () => {
    expect(turnedAway([{ role: "assistant" }])).toEqual(invalid(CONTENT));
    expect(turnedAway([{ role: "assistant", tool_calls: null }])).toEqual(invalid(CONTENT));
    expect(turnedAway([{ role: "assistant", function_call: null }])).toEqual(invalid(CONTENT));
  });

  it("stores null content as an empty string", () => {
    expect(acceptedRequest([{ role: "user", content: null }]).conversation).toEqual([
      { role: "user", content: "" },
    ]);
  });

  it("stores a history whose tool_calls or function_call is malformed as it came", () => {
    const messages = [
      { role: "assistant", content: "", tool_calls: "not an array" },
      { role: "assistant", content: "", tool_calls: [5, { function: 3 }] },
      { role: "assistant", content: "", function_call: "get_weather" },
    ];
    expect(acceptedRequest(messages).conversation).toEqual(messages);
  });

  it("accepts empty or null tool fields, and tool fields on other roles", () => {
    expect(accepted([{ role: "assistant", content: "x", tool_calls: [] }])).toBe(true);
    expect(accepted([{ role: "assistant", content: "x", tool_calls: null }])).toBe(true);
    expect(accepted([{ role: "assistant", content: "x", function_call: null }])).toBe(true);
    expect(accepted([{ role: "user", content: "x", tool_calls: [{ id: "1" }] }])).toBe(true);
    expect(accepted([{ role: "user", content: "x", function_call: { name: "f" } }])).toBe(true);
  });

  it("takes a part that is not text in a message of every role", () => {
    const mixed = [{ type: "text", text: "a" }, IMAGE_PART, { type: "input_audio" }, { type: "x" }];
    for (const role of ["system", "developer", "user", "assistant", "tool", "function"]) {
      expect(accepted([{ role, content: mixed }])).toBe(true);
    }
  });

  it("has no way to answer with unsupported_content", () => {
    const parts = [IMAGE_PART, { type: "input_audio" }, { type: "file" }, { type: "refusal" }];
    for (const part of parts) {
      expect(accepted([{ role: "user", content: [part] }])).toBe(true);
    }
    expect(MESSAGES).not.toHaveProperty("images");
  });

  it("keeps a malformed part as an invalid request", () => {
    const malformed: unknown[] = [
      [{ text: "no type" }],
      [{ type: 5 }],
      [{ type: null }],
      ["a string part"],
      [null],
      [{ type: "text" }],
      [{ type: "text", text: 5 }],
    ];
    for (const content of malformed) {
      expect(turnedAway([{ role: "user", content }])).toEqual(invalid(CONTENT));
    }
  });

  it("accepts tools or functions with at least one entry, whatever the entry looks like", () => {
    for (const extra of [
      { tools: [{ type: "function" }] },
      { tools: [null] },
      { functions: [{ name: "f" }] },
      { functions: [5] },
    ]) {
      expect(accepted(VALID.messages, extra)).toBe(true);
    }
  });

  it("tells which definitions the request has", () => {
    const toolDefinitionsOf = (extra: Record<string, unknown>) =>
      acceptedRequest(VALID.messages, extra).toolDefinitions;
    expect(toolDefinitionsOf({})).toBe("none");
    expect(toolDefinitionsOf({ tools: [], functions: [] })).toBe("none");
    expect(toolDefinitionsOf({ tools: null, functions: "x" })).toBe("none");
    expect(toolDefinitionsOf({ tools: [{ type: "function" }] })).toBe("tools");
    expect(toolDefinitionsOf({ tools: [{ type: "function" }], functions: [] })).toBe("tools");
    expect(toolDefinitionsOf({ functions: [{ name: "f" }] })).toBe("functions");
    expect(toolDefinitionsOf({ tools: [null], functions: [5] })).toBe("both");
  });

  it("ignores tool_choice and parallel_tool_calls, and keeps tools and functions as sent", () => {
    const original = {
      ...VALID,
      tools: [
        {
          type: "function",
          function: { name: "f", parameters: { type: "object" } },
        },
        5,
      ],
      functions: [{ name: "g" }],
      tool_choice: { type: "function", function: { name: "nobody" } },
      parallel_tool_calls: "maybe",
    };
    const result = parseChatCompletionsRequest(body(original));
    expect(result.ok && result.request.originalRequest).toEqual(original);
  });

  it("accepts empty, null, missing or non-array tools and functions", () => {
    for (const extra of [
      { tools: [] },
      { tools: null },
      { tools: "x" },
      { tools: {} },
      { functions: [] },
      { functions: null },
      { functions: 7 },
      { tool_choice: "auto", parallel_tool_calls: true, function_call: "auto" },
    ]) {
      expect(accepted(VALID.messages, extra)).toBe(true);
    }
  });

  it("decides by the first failing message, and by the first failing check in it", () => {
    expect(turnedAway([{ role: "critic" }, { role: "tool" }])).toEqual(invalid(ROLE_CRITIC));
    expect(turnedAway([{ role: "tool", content: "x" }, { role: "critic" }])).toEqual(
      invalid(ROLE_CRITIC),
    );
    expect(turnedAway([{ role: "tool" }, { role: "critic" }])).toEqual(invalid(CONTENT));
    expect(turnedAway([{ role: "user", content: 5 }, { role: "tool" }])).toEqual(invalid(CONTENT));
    expect(
      turnedAway([{ role: "user", content: [{ type: "file" }, { text: "no type" }] }]),
    ).toEqual(invalid(CONTENT));
  });

  it("turns away n of 2 or more even when the request has tools", () => {
    const withTools = { tools: [{ type: "function" }], n: 2 };
    expect(turnedAway(VALID.messages, withTools).code).toBe("invalid_request");
    expect(turnedAway([{ role: "critic" }], withTools)).toEqual(invalid(ROLE_CRITIC));
    expect(turnedAway(VALID.messages, { n: 2 }).code).toBe("invalid_request");
  });

  it("reports invalid_request as a client error, not a server error", () => {
    expect(errorBody("invalid_request", CONTENT)).toEqual({
      error: { message: CONTENT, type: "invalid_request_error", code: "invalid_request" },
    });
  });
});

describe("image parts that are data URLs", () => {
  const CONTENT = "Message content must be a string, null, or an array of content parts.";
  /** "RIFF", as base64. */
  const WAV = "UklGRg==";
  /** "%PDF-1.4", as base64. */
  const PDF = "JVBERi0xLjQ=";
  const NONE = {
    mediaType: null,
    size: null,
    file: null,
    address: null,
    fileId: null,
    typeName: null,
  };
  /** A 1x1 PNG, as base64. */
  const PNG =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const PNG_BYTES = new Uint8Array(Buffer.from(PNG, "base64"));

  function image(url: unknown = `data:image/png;base64,${PNG}`, extra: object = {}) {
    return { type: "image_url", image_url: { url, ...extra } };
  }

  function text(value: string) {
    return { type: "text", text: value };
  }

  function audio(data: unknown, format: unknown, extra: object = {}) {
    return { type: "input_audio", input_audio: { data, format, ...extra } };
  }

  function file(fileData: unknown, extra: object = {}) {
    return { type: "file", file: { file_data: fileData, ...extra } };
  }

  function acceptedOf(messages: unknown[], extra: Record<string, unknown> = {}) {
    const result = parseChatCompletionsRequest(body({ model: "m", messages, ...extra }));
    if (!result.ok) {
      throw new Error(`expected the request to be accepted: ${result.rejection.message}`);
    }
    return result;
  }

  function refusal(messages: unknown[]) {
    return rejectionOf(body({ model: "m", messages }));
  }

  const SAVED = {
    kind: "image",
    mediaType: "image/png",
    size: PNG_BYTES.length,
    readable: true,
    address: null,
    fileId: null,
    typeName: null,
  };

  it("accepts a readable data URL image in a message of any role", () => {
    for (const role of ["system", "developer", "user", "assistant", "tool", "function"]) {
      const result = acceptedOf([{ role, content: [image()] }]);
      expect(result.parts).toHaveLength(1);
    }
  });

  it("records the images in order with the number of characters of text before each", () => {
    const content = [
      text("ab"),
      image(),
      text("cd"),
      image(`data:image/jpeg;base64,AAAA`),
      text("e"),
    ];
    const result = acceptedOf([{ role: "user", content }]);
    expect(result.request.conversation).toEqual([
      {
        role: "user",
        content: "abcde",
        attachments: [
          { ...SAVED, at: 2, file: "message-1-part-2.png" },
          { ...SAVED, at: 4, mediaType: "image/jpeg", size: 3, file: "message-1-part-4.jpg" },
        ],
      },
    ]);
  });

  it("gives a message with no text an empty content and an at of 0", () => {
    const result = acceptedOf([{ role: "user", content: [image(), image()] }]);
    const message = result.request.conversation[0];
    expect(message?.content).toBe("");
    expect(message?.attachments?.map((attachment) => attachment.at)).toEqual([0, 0]);
  });

  it("counts a character outside the basic plane, and a lone surrogate, as one", () => {
    const result = acceptedOf([
      { role: "user", content: [text("\u{1F600}"), text("\ud83d"), image()] },
    ]);
    expect(result.request.conversation[0]?.attachments?.[0]?.at).toBe(2);
  });

  it("returns the bytes and the file name of each image, named by message and part number", () => {
    const result = acceptedOf([
      { role: "user", content: "plain" },
      { role: "user", content: [text("a"), image(), image()] },
    ]);
    expect(result.parts).toEqual([
      { file: "message-2-part-2.png", bytes: PNG_BYTES },
      { file: "message-2-part-3.png", bytes: PNG_BYTES },
    ]);
    expect(result.request.conversation[0]).toEqual({ role: "user", content: "plain" });
  });

  it("uses a name from the server and never one from the client", () => {
    const hostile = { filename: "../evil.png", name: "../x", format: "../y" };
    const result = acceptedOf([{ role: "user", content: [image(undefined, hostile)] }]);
    expect(result.parts.map((part) => part.file)).toEqual(["message-1-part-1.png"]);
  });

  it("decodes each image data URL once, however many checks look at it", () => {
    const mock = vi.mocked(readDataUrl);
    mock.mockClear();
    acceptedOf([
      { role: "user", content: [text("a"), image(), image("data:image/jpeg;base64,AAAA")] },
    ]);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("accepts an empty data, a media type that is not an image, and an unknown media type", () => {
    const result = acceptedOf([
      {
        role: "user",
        content: [
          image("data:image/png;base64,"),
          image("data:text/plain;base64,AAAA"),
          image("data:;base64,AAAA"),
        ],
      },
    ]);
    const attachments = result.request.conversation[0]?.attachments ?? [];
    expect(attachments.map((a) => [a.kind, a.mediaType, a.size, a.file])).toEqual([
      ["image", "image/png", 0, "message-1-part-1.png"],
      ["image", "text/plain", 3, "message-1-part-2.bin"],
      ["image", null, 3, "message-1-part-3.bin"],
    ]);
    expect(result.parts[0]?.bytes).toEqual(new Uint8Array(0));
  });

  it("ignores detail and other fields of the image", () => {
    const result = acceptedOf([
      { role: "user", content: [image(undefined, { detail: "high", x: 1 })] },
    ]);
    expect(result.parts).toHaveLength(1);
  });

  it("keeps the original request as received, base64 included", () => {
    const messages = [{ role: "user", content: [text("a"), image()] }];
    const result = acceptedOf(messages);
    expect(result.request.originalRequest).toEqual({ model: "m", messages });
  });

  it("gives no parts and no attachments for a request without images", () => {
    const result = acceptedOf([{ role: "user", content: [text("a"), text("b")] }]);
    expect(result.parts).toEqual([]);
    expect(result.request.conversation).toEqual([{ role: "user", content: "ab" }]);
  });

  it("treats a string content as text, even when it looks like a data URL", () => {
    const result = acceptedOf([{ role: "user", content: `data:image/png;base64,${PNG}` }]);
    expect(result.parts).toEqual([]);
    expect(result.request.conversation[0]?.content).toBe(`data:image/png;base64,${PNG}`);
  });

  it("keeps the text of an assistant message with tool calls next to its images", () => {
    const calls = [{ id: "1", type: "function", function: { name: "f", arguments: "{}" } }];
    const result = acceptedOf([{ role: "assistant", content: [image()], tool_calls: calls }]);
    expect(result.request.conversation[0]).toMatchObject({ tool_calls: calls });
    expect(result.request.conversation[0]?.attachments).toHaveLength(1);
  });

  it("decodes each audio and file data once as well", () => {
    const mock = vi.mocked(readDataUrl);
    mock.mockClear();
    acceptedOf([
      {
        role: "user",
        content: [file(`data:application/pdf;base64,${PDF}`), file("data:x/y;base64,A")],
      },
    ]);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("takes an image whose url is an address and saves nothing", () => {
    const result = acceptedOf([
      { role: "user", content: [text("a"), image("https://example.com/cat.png"), text("b")] },
    ]);
    expect(result.parts).toEqual([]);
    expect(result.request.conversation[0]).toEqual({
      role: "user",
      content: "ab",
      attachments: [
        { ...NONE, at: 1, kind: "image", readable: true, address: "https://example.com/cat.png" },
      ],
    });
  });

  it("takes any url that does not start with data: as an address, even a strange one", () => {
    for (const url of [
      "http://x",
      "ftp://x/y",
      "cat.png",
      "  data:x",
      "/tmp/a.png",
      "x".repeat(5000),
    ]) {
      const result = acceptedOf([{ role: "user", content: [image(url)] }]);
      expect(result.request.conversation[0]?.attachments?.[0], url).toMatchObject({
        kind: "image",
        readable: true,
        address: url,
        file: null,
        size: null,
      });
    }
  });

  it("takes wav and mp3 audio, saves the bytes and names the media type from the format", () => {
    const result = acceptedOf([
      { role: "user", content: [text("a"), audio(WAV, "wav"), audio("QUJD", "mp3")] },
    ]);
    expect(result.request.conversation[0]?.attachments).toEqual([
      {
        ...NONE,
        at: 1,
        kind: "audio",
        readable: true,
        mediaType: "audio/wav",
        size: 4,
        file: "message-1-part-2.wav",
      },
      {
        ...NONE,
        at: 1,
        kind: "audio",
        readable: true,
        mediaType: "audio/mpeg",
        size: 3,
        file: "message-1-part-3.mp3",
      },
    ]);
    expect(result.parts.map((part) => part.file)).toEqual([
      "message-1-part-2.wav",
      "message-1-part-3.mp3",
    ]);
    expect([...(result.parts[0]?.bytes ?? [])]).toEqual([82, 73, 70, 70]);
  });

  it("saves audio of an unknown format with an unknown media type", () => {
    for (const format of ["ogg", "WAV", "Mp3", 5, null, undefined]) {
      const result = acceptedOf([{ role: "user", content: [audio("QUJD", format)] }]);
      expect(result.request.conversation[0]?.attachments?.[0], String(format)).toMatchObject({
        kind: "audio",
        readable: true,
        mediaType: null,
        size: 3,
        file: "message-1-part-1.bin",
      });
    }
  });

  it("saves empty audio data as zero bytes", () => {
    const result = acceptedOf([{ role: "user", content: [audio("", "wav")] }]);
    expect(result.parts).toEqual([{ file: "message-1-part-1.wav", bytes: new Uint8Array(0) }]);
    expect(result.request.conversation[0]?.attachments?.[0]).toMatchObject({ size: 0 });
  });

  it("takes a file with a data URL, saves its bytes and ignores the filename", () => {
    const result = acceptedOf([
      {
        role: "user",
        content: [
          text("see"),
          file(`data:application/pdf;base64,${PDF}`, {
            filename: "../evil.pdf",
            file_id: "file-x",
          }),
          file("data:;base64,QUJD"),
        ],
      },
    ]);
    expect(result.request.conversation[0]?.attachments).toEqual([
      {
        ...NONE,
        at: 3,
        kind: "file",
        readable: true,
        mediaType: "application/pdf",
        size: 8,
        file: "message-1-part-2.pdf",
      },
      {
        ...NONE,
        at: 3,
        kind: "file",
        readable: true,
        mediaType: null,
        size: 3,
        file: "message-1-part-3.bin",
      },
    ]);
    expect(JSON.stringify(result.request.conversation)).not.toContain("evil");
    expect(result.parts.map((part) => part.file)).toEqual([
      "message-1-part-2.pdf",
      "message-1-part-3.bin",
    ]);
  });

  it("takes a file with a file_id only, and shows the id without saving", () => {
    for (const data of [undefined, null]) {
      const part = { type: "file", file: { file_data: data, file_id: "file-abc123" } };
      const result = acceptedOf([{ role: "user", content: [part] }]);
      expect(result.parts).toEqual([]);
      expect(result.request.conversation[0]?.attachments).toEqual([
        { ...NONE, at: 0, kind: "file", readable: true, fileId: "file-abc123" },
      ]);
    }
  });

  it("takes a file with neither data nor a usable file_id, as a kind only", () => {
    const shapes: unknown[] = [
      {},
      { file_id: 5 },
      { file_id: null },
      { file_data: null },
      { filename: "a.pdf" },
    ];
    for (const inner of shapes) {
      const result = acceptedOf([{ role: "user", content: [{ type: "file", file: inner }] }]);
      expect(result.request.conversation[0]?.attachments, JSON.stringify(inner)).toEqual([
        { ...NONE, at: 0, kind: "file", readable: true },
      ]);
      expect(result.parts).toEqual([]);
    }
  });

  it("takes every row of the table of unreadable parts, without saving anything", () => {
    const rows: [string, unknown][] = [
      ["image", { type: "image_url" }],
      ["image", { type: "image_url", image_url: "data:image/png;base64,AAAA" }],
      ["image", { type: "image_url", image_url: ["x"] }],
      ["image", { type: "image_url", image_url: null }],
      ["image", { type: "image_url", image_url: {} }],
      ["image", image(5)],
      ["image", image(null)],
      ["image", image("")],
      ["image", image("data:image/png,AAAA")],
      ["image", image("data:image/png;base64,A")],
      ["image", image("data:image/png;base64,AA AA")],
      ["audio", { type: "input_audio" }],
      ["audio", { type: "input_audio", input_audio: "QUJD" }],
      ["audio", { type: "input_audio", input_audio: null }],
      ["audio", { type: "input_audio", input_audio: [] }],
      ["audio", { type: "input_audio", input_audio: { format: "wav" } }],
      ["audio", audio(5, "wav")],
      ["audio", audio(null, "wav")],
      ["audio", audio("A", "wav")],
      ["audio", audio("QU JD", "wav")],
      ["audio", audio("QU-D", "wav")],
      ["audio", audio("data:audio/wav;base64,QUJD", "wav")],
      ["file", { type: "file" }],
      ["file", { type: "file", file: "QUJD" }],
      ["file", { type: "file", file: null }],
      ["file", { type: "file", file: [] }],
      ["file", file(5)],
      ["file", file(true, { file_id: "file-x" })],
      ["file", file("")],
      ["file", file("", { file_id: "file-x" })],
      ["file", file("QUJD")],
      ["file", file("QUJD", { file_id: "file-x" })],
      ["file", file("https://example.com/a.pdf")],
      ["file", file("data:application/pdf,QUJD")],
      ["file", file("data:application/pdf;base64,A")],
      ["file", file("data:application/pdf;base64,AA AA")],
    ];
    for (const [kind, part] of rows) {
      const result = acceptedOf([{ role: "user", content: [text("a"), part] }]);
      expect(result.parts, JSON.stringify(part)).toEqual([]);
      expect(result.request.conversation[0]?.attachments, JSON.stringify(part)).toEqual([
        { ...NONE, at: 1, kind, readable: false },
      ]);
    }
  });

  it("takes a part of an unknown type, and records its type name only", () => {
    for (const type of ["video_url", "refusal", "audio", "image", "", "Text", "t".repeat(500)]) {
      const result = acceptedOf([{ role: "user", content: [text("a"), { type, extra: 1 }] }]);
      expect(result.parts).toEqual([]);
      expect(result.request.conversation[0]?.attachments).toEqual([
        { ...NONE, at: 1, kind: "other", readable: true, typeName: type },
      ]);
    }
  });

  it("numbers the parts by their place in the content, whether or not they are saved", () => {
    const result = acceptedOf([
      { role: "user", content: "plain" },
      {
        role: "user",
        content: [
          image("https://example.com/a.png"),
          { type: "video_url" },
          audio("QUJD", "wav"),
          text("x"),
          file(`data:application/pdf;base64,${PDF}`),
          image(),
        ],
      },
    ]);
    expect(result.parts.map((part) => part.file)).toEqual([
      "message-2-part-3.wav",
      "message-2-part-5.pdf",
      "message-2-part-6.png",
    ]);
    const kinds = result.request.conversation[1]?.attachments?.map((a) => [a.kind, a.at, a.file]);
    expect(kinds).toEqual([
      ["image", 0, null],
      ["other", 0, null],
      ["audio", 0, "message-2-part-3.wav"],
      ["file", 1, "message-2-part-5.pdf"],
      ["image", 1, "message-2-part-6.png"],
    ]);
  });

  it("takes the new parts in a message of every role", () => {
    const parts = [audio("QUJD", "wav"), file("data:x/y;base64,QUJD"), { type: "video_url" }];
    for (const role of ["system", "developer", "user", "assistant", "tool", "function"]) {
      const result = acceptedOf([{ role, content: parts }]);
      expect(result.parts, role).toHaveLength(2);
      expect(result.request.conversation[0]?.attachments, role).toHaveLength(3);
    }
  });

  it("takes 140000 saved parts without an exception", () => {
    const part = audio("", "wav");
    const content = Array.from({ length: 140_000 }, () => part);
    const result = acceptedOf([
      { role: "user", content },
      { role: "user", content },
    ]);
    expect(result.parts).toHaveLength(280_000);
    expect(result.parts.at(-1)?.file).toBe("message-2-part-140000.wav");
    expect(result.request.conversation[1]?.attachments).toHaveLength(140_000);
  });

  it("keeps the original request as received, with every kind of part", () => {
    const messages = [{ role: "user", content: [audio(WAV, "wav"), file("QUJD"), { type: "x" }] }];
    const result = acceptedOf(messages);
    expect(result.request.originalRequest).toEqual({ model: "m", messages });
  });

  it("treats a string content as text, whatever it looks like", () => {
    const strings = [
      JSON.stringify([{ type: "input_audio", input_audio: { data: WAV, format: "wav" } }]),
      "A".repeat(2000),
      `data:application/pdf;base64,${PDF}`,
      "file-abc123",
    ];
    for (const content of strings) {
      const result = acceptedOf([{ role: "user", content }]);
      expect(result.parts).toEqual([]);
      expect(result.request.conversation).toEqual([{ role: "user", content }]);
    }
  });

  it("keeps a part with a broken shape as an invalid request, next to any other part", () => {
    const others = [image(), audio(WAV, "wav"), file("QUJD"), { type: "video_url" }];
    const bad = [
      { text: "no type" },
      { type: 5 },
      { type: null },
      { type: "text" },
      { type: "text", text: 5 },
      null,
      "x",
      5,
      [],
    ];
    for (const other of others) {
      for (const part of bad) {
        expect(refusal([{ role: "user", content: [other, part] }]), JSON.stringify(part)).toEqual({
          status: 400,
          code: "invalid_request",
          message: CONTENT,
        });
        expect(refusal([{ role: "user", content: [part, other] }]).code).toBe("invalid_request");
      }
    }
  });
});

describe("unknown fields", () => {
  it("accepts unknown fields at the top and inside a message, and keeps only role, content and the tool fields", () => {
    const result = parseChatCompletionsRequest(
      body({
        model: "m",
        foo: "bar",
        messages: [{ role: "user", content: "Hi", name: "alice", foo: { deep: true } }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.request.conversation).toEqual([{ role: "user", content: "Hi", name: "alice" }]);
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
      tools: [],
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

  const BASE = {
    requestId: "20261009T140512123Z-a1b2c3",
    model: "whatever",
    content: "[]",
    nowSeconds: 1791813940,
  };

  it("builds a text response when the reply is text, as before", () => {
    const completion = buildCompletion({
      ...BASE,
      content: "Hi",
      reply: { kind: "text" },
    });
    expect(completion.choices[0]).toEqual({
      index: 0,
      message: { role: "assistant", content: "Hi" },
      finish_reason: "stop",
    });
  });

  it("builds tool_calls with null content and passes the typed calls on unchanged", () => {
    const raw = {
      id: "call_1",
      type: "function",
      index: 0,
      function: {
        name: "get_weather",
        arguments: '{"city": "Tokyo"}',
        note: "extra",
      },
    };
    const completion = buildCompletion({
      ...BASE,
      reply: {
        kind: "tool_calls",
        calls: [
          {
            raw,
            id: "call_1",
            name: "get_weather",
            arguments: '{"city": "Tokyo"}',
          },
        ],
      },
    });
    expect(completion.choices[0]).toEqual({
      index: 0,
      message: { role: "assistant", content: null, tool_calls: [raw] },
      finish_reason: "tool_calls",
    });
    expect(completion.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("builds function_call with null content, and no id or type", () => {
    const completion = buildCompletion({
      ...BASE,
      reply: { kind: "function_call", name: "get_weather", arguments: "{}" },
    });
    expect(completion.choices[0]).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: null,
        function_call: { name: "get_weather", arguments: "{}" },
      },
      finish_reason: "function_call",
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

  const common = {
    id: "chatcmpl-20261009T140640321Z-d4e5f6",
    object: "chat.completion.chunk",
    created: 1791814000,
    model: "whatever",
  };
  const FIRST = {
    id: "call_1",
    name: "get_weather",
    arguments: '{"city": "Tokyo"}',
  };
  const SECOND = { id: "call_2", name: "search", arguments: "" };

  function item(call: { id: string; name: string; arguments: string }) {
    return {
      raw: {
        id: call.id,
        type: "function",
        index: 9,
        function: { name: call.name, arguments: call.arguments, note: "extra" },
      },
      ...call,
    };
  }

  function streamedCall(call: { id: string; name: string; arguments: string }, index: number) {
    return {
      ...common,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: call.arguments },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    };
  }

  it("streams tool calls: a null content first, one chunk per call, and an empty last delta", () => {
    const events = buildStreamEvents({
      ...INPUT,
      reply: { kind: "tool_calls", calls: [item(FIRST), item(SECOND)] },
    });
    expect(parsed(events)).toEqual([
      {
        ...common,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: null },
            finish_reason: null,
          },
        ],
      },
      streamedCall(FIRST, 0),
      streamedCall(SECOND, 1),
      {
        ...common,
        choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
      },
      "[DONE]",
    ]);
  });

  it("drops the extra fields of a call in a stream", () => {
    const events = parsed(
      buildStreamEvents({
        ...INPUT,
        reply: { kind: "tool_calls", calls: [item(FIRST)] },
      }),
    );
    expect(JSON.stringify(events)).not.toContain("extra");
    expect(JSON.stringify(events)).not.toContain('"index":9');
  });

  it("puts the usage chunk after the last chunk of a tool call stream", () => {
    const events = parsed(
      buildStreamEvents({
        ...INPUT,
        includeUsage: true,
        reply: { kind: "tool_calls", calls: [item(FIRST)] },
      }),
    );
    expect(events).toHaveLength(5);
    expect(events[2]).toMatchObject({
      choices: [{ finish_reason: "tool_calls" }],
    });
    expect(events[3]).toEqual({
      ...common,
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    expect(events[4]).toBe("[DONE]");
  });

  it("streams a function call as one chunk and the finish reason function_call", () => {
    const events = parsed(
      buildStreamEvents({
        ...INPUT,
        reply: { kind: "function_call", name: "get_weather", arguments: "{}" },
      }),
    );
    expect(events).toEqual([
      {
        ...common,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: null },
            finish_reason: null,
          },
        ],
      },
      {
        ...common,
        choices: [
          {
            index: 0,
            delta: { function_call: { name: "get_weather", arguments: "{}" } },
            finish_reason: null,
          },
        ],
      },
      {
        ...common,
        choices: [{ index: 0, delta: {}, finish_reason: "function_call" }],
      },
      "[DONE]",
    ]);
  });

  it("streams a text reply as before when the reply is text", () => {
    expect(buildStreamEvents({ ...INPUT, reply: { kind: "text" } })).toEqual(
      buildStreamEvents(INPUT),
    );
  });
});

describe("the model list", () => {
  it("is one model called imbehind with the fixed created time", () => {
    expect(buildModelList()).toEqual({
      object: "list",
      data: [{ id: "imbehind", object: "model", created: 1791800000, owned_by: "imbehind" }],
    });
  });

  it("is a new object each time, so a caller cannot change the next answer", () => {
    const first = buildModelList();
    first.data.length = 0;
    expect(buildModelList().data).toHaveLength(1);
  });
});
