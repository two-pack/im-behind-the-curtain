import { describe, expect, it } from "vitest";
import {
  createReplyFile,
  createRequestFile,
  createStateFile,
  FORMAT_VERSION,
  INVALID_REPLY_REASONS,
  isInvalidReplyReason,
  parseReplyFile,
  parseRequestFile,
  parseStateFile,
  serializeFile,
} from "../src/model.js";

const ID = "20261009T140512123Z-a1b2c3";
const RECEIVED_AT = "2026-10-09T14:05:12.123Z";

function validRequestJson(): Record<string, unknown> {
  return {
    formatVersion: 1,
    id: ID,
    receivedAt: RECEIVED_AT,
    format: "chat.completions",
    model: "whatever",
    replyKind: "text",
    requiredShape: null,
    stream: false,
    includeUsage: false,
    conversation: [{ role: "user", content: "Hello" }],
    originalRequest: { model: "whatever", messages: [{ role: "user", content: "Hello" }] },
  };
}

describe("writing files", () => {
  it("writes formatVersion 2 into a request file and 1 into the other files it creates", () => {
    const request = createRequestFile(ID, RECEIVED_AT, {
      format: "chat.completions",
      model: "m",
      replyKind: "text",
      requiredShape: null,
      stream: false,
      includeUsage: false,
      conversation: [{ role: "user", content: "Hi" }],
      originalRequest: { model: "m" },
    });
    const waiting = createStateFile(ID, "waiting", RECEIVED_AT, null);
    const reply = createReplyFile("Hi", RECEIVED_AT);
    expect(FORMAT_VERSION).toBe(1);
    expect(request.formatVersion).toBe(2);
    expect(request.toolDefinitions).toBe("none");
    expect(waiting.formatVersion).toBe(1);
    expect(reply.formatVersion).toBe(1);
  });

  it("starts a state file as waiting with no end time", () => {
    const waiting = createStateFile(ID, "waiting", RECEIVED_AT, null);
    expect(waiting).toEqual({
      formatVersion: 1,
      id: ID,
      state: "waiting",
      updatedAt: RECEIVED_AT,
      endedAt: null,
      endReason: null,
    });
  });

  it("marks a reply as written by imbehind answer", () => {
    const reply = createReplyFile("Hi", RECEIVED_AT);
    expect(reply).toEqual({
      formatVersion: 1,
      kind: "text",
      body: "Hi",
      source: "imbehind-answer",
      writtenAt: RECEIVED_AT,
    });
  });

  it("serializes to JSON text that ends with one newline and round-trips", () => {
    const reply = createReplyFile("line1\nline2", RECEIVED_AT);
    const text = serializeFile(reply);
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text)).toEqual(reply);
  });
});

describe("reading a request file", () => {
  it("reads a version 1 file", () => {
    const parsed = parseRequestFile(validRequestJson());
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.value.id).toBe(ID);
      expect(parsed.value.conversation).toEqual([{ role: "user", content: "Hello" }]);
    }
  });

  it("treats a file whose formatVersion is not 1 or 2 as unreadable", () => {
    expect(parseRequestFile({ ...validRequestJson(), formatVersion: 3 }).kind).toBe("unreadable");
    expect(parseRequestFile({ ...validRequestJson(), formatVersion: "2" }).kind).toBe("unreadable");
    const withoutVersion = validRequestJson();
    delete withoutVersion.formatVersion;
    expect(parseRequestFile(withoutVersion).kind).toBe("unreadable");
  });

  it("treats a malformed file as unreadable", () => {
    expect(parseRequestFile(null).kind).toBe("unreadable");
    expect(parseRequestFile("text").kind).toBe("unreadable");
    expect(parseRequestFile({ ...validRequestJson(), conversation: "no" }).kind).toBe("unreadable");
    expect(parseRequestFile({ ...validRequestJson(), model: 5 }).kind).toBe("unreadable");
  });

  it("marks an unknown format or reply kind as unsupported, not unreadable", () => {
    expect(parseRequestFile({ ...validRequestJson(), format: "messages" }).kind).toBe(
      "unsupported",
    );
    expect(parseRequestFile({ ...validRequestJson(), replyKind: "image" }).kind).toBe(
      "unsupported",
    );
  });

  it("reads a json request with its required shape, stream and includeUsage", () => {
    const shape = { type: "object", properties: { passed: { type: "boolean" } } };
    const parsed = parseRequestFile({
      ...validRequestJson(),
      replyKind: "json",
      requiredShape: shape,
      stream: true,
      includeUsage: true,
    });
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") {
      expect(parsed.value.replyKind).toBe("json");
      expect(parsed.value.requiredShape).toEqual(shape);
      expect(parsed.value.stream).toBe(true);
      expect(parsed.value.includeUsage).toBe(true);
    }
  });

  it("reads a json request whose required shape is null or not an object as no shape", () => {
    for (const requiredShape of [null, "x", 5, []]) {
      const parsed = parseRequestFile({ ...validRequestJson(), replyKind: "json", requiredShape });
      expect(parsed.kind === "ok" && parsed.value.requiredShape).toBeNull();
    }
  });

  it("ignores fields it does not know", () => {
    const parsed = parseRequestFile({ ...validRequestJson(), future: { a: 1 } });
    expect(parsed.kind).toBe("ok");
  });
});

describe("reading a state file", () => {
  it("reads waiting and replied", () => {
    const waiting = parseStateFile(createStateFile(ID, "waiting", RECEIVED_AT, null));
    const replied = parseStateFile(createStateFile(ID, "replied", RECEIVED_AT, RECEIVED_AT));
    expect(waiting.kind === "ok" && waiting.value.state).toBe("waiting");
    expect(replied.kind === "ok" && replied.value.state).toBe("replied");
  });

  it("reads skipped, cancelled and timed_out as themselves", () => {
    for (const state of ["skipped", "cancelled", "timed_out"] as const) {
      const parsed = parseStateFile(createStateFile(ID, state, RECEIVED_AT, RECEIVED_AT, "why"));
      expect(parsed.kind === "ok" && parsed.value.state).toBe(state);
    }
  });

  it("writes and reads the end time and the end reason of a finished request", () => {
    const ended = createStateFile(ID, "cancelled", RECEIVED_AT, RECEIVED_AT, "client disconnected");
    expect(ended).toEqual({
      formatVersion: 1,
      id: ID,
      state: "cancelled",
      updatedAt: RECEIVED_AT,
      endedAt: RECEIVED_AT,
      endReason: "client disconnected",
    });
    const parsed = parseStateFile(JSON.parse(serializeFile(ended)));
    expect(parsed.kind === "ok" && parsed.value).toEqual(ended);
  });

  it("treats an unknown state value as a finished request", () => {
    for (const state of ["future", "", "REPLIED"]) {
      const parsed = parseStateFile({
        ...createStateFile(ID, "waiting", RECEIVED_AT, null),
        state,
      });
      expect(parsed.kind === "ok" && parsed.value.state).toBe("other");
    }
  });

  it("knows abandoned and invalid_reply as states of finished requests", () => {
    for (const state of ["abandoned", "invalid_reply"]) {
      const parsed = parseStateFile({
        ...createStateFile(ID, "waiting", RECEIVED_AT, null),
        state,
      });
      expect(parsed.kind === "ok" && parsed.value.state).toBe(state);
    }
    const abandoned = createStateFile(
      ID,
      "abandoned",
      RECEIVED_AT,
      RECEIVED_AT,
      "server restarted",
    );
    expect(abandoned).toMatchObject({ state: "abandoned", endReason: "server restarted" });
  });

  it("treats a file whose formatVersion is not 1 as unreadable", () => {
    const state = { ...createStateFile(ID, "waiting", RECEIVED_AT, null), formatVersion: 3 };
    expect(parseStateFile(state).kind).toBe("unreadable");
    expect(parseStateFile([]).kind).toBe("unreadable");
    expect(parseStateFile({ formatVersion: 1, state: 7 }).kind).toBe("unreadable");
  });
});

describe("reading a reply file", () => {
  it("accepts a version 1 text reply", () => {
    const parsed = parseReplyFile(createReplyFile("Hi", RECEIVED_AT));
    expect(parsed.kind === "ok" && parsed.value.body).toBe("Hi");
  });

  it("accepts a version 1 json reply and keeps its body as written", () => {
    const written = createReplyFile('{"passed":   true}', RECEIVED_AT, "json");
    expect(written.kind).toBe("json");
    const parsed = parseReplyFile(written);
    expect(parsed.kind === "ok" && parsed.value.kind).toBe("json");
    expect(parsed.kind === "ok" && parsed.value.body).toBe('{"passed":   true}');
  });

  it("accepts a skip reply whose body is an empty string", () => {
    const written = createReplyFile("", RECEIVED_AT, "skip");
    expect(written).toMatchObject({ kind: "skip", body: "", source: "imbehind-answer" });
    const parsed = parseReplyFile(written);
    expect(parsed.kind === "ok" && parsed.value.kind).toBe("skip");
    expect(parsed.kind === "ok" && parsed.value.body).toBe("");
  });

  it("does not read a skip reply with a body, or a text or json reply with an empty body", () => {
    expect(parseReplyFile({ formatVersion: 1, kind: "skip", body: "{}" }).kind).toBe("unreadable");
    expect(parseReplyFile({ formatVersion: 1, kind: "text", body: "" }).kind).toBe("unreadable");
    expect(parseReplyFile({ formatVersion: 1, kind: "json", body: "" }).kind).toBe("unreadable");
  });

  it("does not accept a reply of an unknown kind or version in this version", () => {
    expect(parseReplyFile({ formatVersion: 1, kind: "sing", body: "la" }).kind).toBe("unsupported");
    expect(parseReplyFile({ formatVersion: 2, kind: "text", body: "x" }).kind).toBe("unreadable");
    expect(parseReplyFile({ formatVersion: 1, kind: "text", body: 5 }).kind).toBe("unreadable");
    expect(parseReplyFile("nope").kind).toBe("unreadable");
  });
});

describe("tool messages in the conversation", () => {
  const CALLS = [
    {
      id: "call_1",
      type: "function",
      function: { name: "f", arguments: "{}" },
    },
  ];
  const WIDE_CONVERSATION = [
    { role: "system", content: "s" },
    { role: "user", content: "u", name: "alice" },
    { role: "assistant", content: "", tool_calls: CALLS },
    { role: "tool", content: "result", tool_call_id: "call_1", name: "f" },
    {
      role: "assistant",
      content: "",
      function_call: { name: "f", arguments: "{}" },
    },
    { role: "function", content: "old result", name: "f" },
  ];

  function requestJson(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      ...validRequestJson(),
      formatVersion: 2,
      toolDefinitions: "none",
      ...extra,
    };
  }

  function conversationOf(json: Record<string, unknown>): unknown {
    const parsed = parseRequestFile(json);
    return parsed.kind === "ok" ? parsed.value.conversation : parsed.kind;
  }

  it("reads and writes the tool roles and the tool fields without changing them", () => {
    expect(conversationOf(requestJson({ conversation: WIDE_CONVERSATION }))).toEqual(
      WIDE_CONVERSATION,
    );
  });

  it("keeps a message without tool fields as role and content only", () => {
    const [first] = conversationOf(requestJson({ conversation: WIDE_CONVERSATION })) as object[];
    expect(Object.keys(first ?? {})).toEqual(["role", "content"]);
  });

  it("keeps a broken tool_calls or function_call as it is, and does not treat the file as unreadable", () => {
    const broken = [
      { role: "assistant", content: "", tool_calls: "not an array" },
      { role: "assistant", content: "", tool_calls: [5, null] },
      { role: "assistant", content: "", function_call: "get_weather" },
      {
        role: "assistant",
        content: "x",
        tool_calls: null,
        function_call: null,
      },
    ];
    expect(conversationOf(requestJson({ conversation: broken }))).toEqual(broken);
  });

  it("round-trips a request file written with tool messages", () => {
    const file = createRequestFile(ID, RECEIVED_AT, {
      format: "chat.completions",
      model: "m",
      replyKind: "text",
      requiredShape: null,
      stream: false,
      includeUsage: false,
      conversation: [{ role: "tool", content: "r", tool_call_id: "call_1" }],
      originalRequest: { model: "m", tools: [{ type: "function" }] },
      toolDefinitions: "tools",
    });
    const parsed = parseRequestFile(JSON.parse(serializeFile(file)));
    expect(parsed.kind === "ok" && parsed.value).toEqual(file);
  });
});

describe("the request file version and toolDefinitions", () => {
  function toolDefinitionsOf(json: Record<string, unknown>): unknown {
    const parsed = parseRequestFile(json);
    return parsed.kind === "ok" ? parsed.value.toolDefinitions : parsed.kind;
  }

  it("reads a version 1 file and takes its toolDefinitions as none", () => {
    expect(toolDefinitionsOf(validRequestJson())).toBe("none");
    expect(toolDefinitionsOf({ ...validRequestJson(), toolDefinitions: "tools" })).toBe("none");
  });

  it("reads the four values of a version 2 file", () => {
    for (const value of ["tools", "functions", "both", "none"]) {
      expect(
        toolDefinitionsOf({
          ...validRequestJson(),
          formatVersion: 2,
          toolDefinitions: value,
        }),
      ).toBe(value);
    }
  });

  it("treats a version 2 file with a missing or unknown toolDefinitions as unreadable", () => {
    expect(toolDefinitionsOf({ ...validRequestJson(), formatVersion: 2 })).toBe("unreadable");
    expect(
      toolDefinitionsOf({
        ...validRequestJson(),
        formatVersion: 2,
        toolDefinitions: "all",
      }),
    ).toBe("unreadable");
  });

  it("keeps the version of a version 1 file as 1 and writes 2 for every new file", () => {
    const parsed = parseRequestFile(validRequestJson());
    expect(parsed.kind === "ok" && parsed.value.formatVersion).toBe(1);
  });

  it("does not use version 2 for the state file or the reply file", () => {
    expect(parseStateFile({ formatVersion: 2, state: "waiting" }).kind).toBe("unreadable");
    expect(createReplyFile("x", RECEIVED_AT).formatVersion).toBe(1);
  });
});

describe("the fixed reasons for tool calls", () => {
  it("recognizes the reason of a reply file whose tool calls are not valid", () => {
    expect(
      isInvalidReplyReason(
        INVALID_REPLY_REASONS.badToolCalls("call 2 needs a non-empty string id"),
      ),
    ).toBe(true);
    expect(
      isInvalidReplyReason(
        INVALID_REPLY_REASONS.badToolCalls(
          "this request defines functions only, so exactly one call is allowed",
        ),
      ),
    ).toBe(true);
  });

  it("does not recognize a reason that carries other text", () => {
    expect(
      isInvalidReplyReason(INVALID_REPLY_REASONS.badToolCalls("call 2 needs secret-token")),
    ).toBe(false);
    expect(
      isInvalidReplyReason("reply tool calls are not valid (call x needs a non-empty string id)"),
    ).toBe(false);
  });
});
