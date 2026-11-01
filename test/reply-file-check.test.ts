import { describe, expect, it } from "vitest";
import { type AudioRequest, NO_AUDIO_REQUEST } from "../src/audio-reply.js";
import { checkReply } from "../src/broker/reply-check.js";
import { checkReplyFile } from "../src/broker/reply-file-check.js";
import {
  AUDIO_FORMATS,
  createReplyFile,
  INVALID_REPLY_REASONS,
  isInvalidReplyReason,
  MAX_FILE_BYTES,
  type ReplyKind,
  serializeFile,
  type ToolDefinitions,
} from "../src/model.js";
import { audioSizesAtLimit, replyAudio, replyAudioOfSize } from "./helpers/audio.js";

const BOM = [0xef, 0xbb, 0xbf];

function bytesOf(value: unknown): Uint8Array {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value), "utf8");
}

function invalid(
  bytes: Uint8Array,
  replyKind: ReplyKind,
  toolDefinitions?: ToolDefinitions,
): string | undefined {
  const verdict = checkReplyFile(bytes, replyKind, toolDefinitions);
  return verdict.kind === "invalid" ? verdict.reason : undefined;
}

describe("the examples of the functional spec", () => {
  const text = (body: unknown, extra: Record<string, unknown> = {}) => ({
    formatVersion: 1,
    kind: "text",
    body,
    ...extra,
  });
  const cases: Array<[string, unknown, ReplyKind, string | "valid"]> = [
    ["a plain text reply", text("Hi"), "text", "valid"],
    ["a body with a trailing newline", text("Hi\n"), "text", "valid"],
    [
      "a json reply for a json request",
      { formatVersion: 1, kind: "json", body: '{"a":1}' },
      "json",
      "valid",
    ],
    [
      "a json body that is not json for a json request",
      { formatVersion: 1, kind: "json", body: "not json" },
      "json",
      "reply body is not valid JSON (unexpected character at line 1, column 2)",
    ],
    [
      "a text kind with a body that is not json for a json request",
      text("not json"),
      "json",
      "reply body is not valid JSON (unexpected character at line 1, column 2)",
    ],
    [
      "a json kind with a body that is not json for a text request",
      { formatVersion: 1, kind: "json", body: "not json" },
      "text",
      "valid",
    ],
    [
      "a skip reply for a json request",
      { formatVersion: 1, kind: "skip", body: "" },
      "json",
      "valid",
    ],
    [
      "a skip reply with a body",
      { formatVersion: 1, kind: "skip", body: "x" },
      "text",
      "reply file has a body that does not fit its kind",
    ],
    [
      "a text reply with an empty body",
      text(""),
      "text",
      "reply file has a body that does not fit its kind",
    ],
    [
      "an unknown format version",
      { formatVersion: 2, kind: "text", body: "Hi" },
      "text",
      "reply file has an unknown format version",
    ],
    [
      "an unknown kind",
      { formatVersion: 1, kind: "audio", body: "Hi" },
      "text",
      "reply file has an unknown kind",
    ],
    [
      "a missing body",
      { formatVersion: 1, kind: "text" },
      "text",
      "reply file is missing a required field",
    ],
    ["a top-level array", [1, 2], "text", "reply file is missing a required field"],
    ["an unknown extra field", text("Hi", { extra: true }), "text", "valid"],
    [
      "a file that is cut off",
      '{"kind":"text","body":"Hi"',
      "text",
      "reply file is not valid JSON",
    ],
  ];

  it.each(cases)("%s", (_name, content, replyKind, expected) => {
    const verdict = checkReplyFile(bytesOf(content), replyKind);
    if (expected === "valid") {
      expect(verdict.kind).toBe("valid");
    } else {
      expect(verdict).toEqual({ kind: "invalid", reason: expected });
    }
  });

  it("returns the reply with the body exactly as written when it is valid", () => {
    const verdict = checkReplyFile(
      bytesOf({
        formatVersion: 1,
        kind: "text",
        body: "Hi\n",
        source: "my-tool",
        writtenAt: "2026-10-09T14:05:12.000Z",
      }),
      "text",
    );
    expect(verdict).toEqual({
      kind: "valid",
      reply: {
        formatVersion: 1,
        kind: "text",
        body: "Hi\n",
        source: "my-tool",
        writtenAt: "2026-10-09T14:05:12.000Z",
      },
    });
  });

  it("does not need source or writtenAt, and ignores their values", () => {
    const verdict = checkReplyFile(bytesOf(text("Hi", { source: 5, writtenAt: false })), "text");
    expect(verdict).toEqual({
      kind: "valid",
      reply: { formatVersion: 1, kind: "text", body: "Hi" },
    });
  });
});

describe("the order of the checks stops at the first reason", () => {
  it("says too large before it looks at the content", () => {
    expect(invalid(new Uint8Array(MAX_FILE_BYTES + 1), "text")).toBe(
      "reply file is larger than 10 MB",
    );
  });

  it("reads a file of exactly the limit and a little below it", () => {
    const body = "a".repeat(100);
    const head = '{"formatVersion":1,"kind":"text","body":"';
    const tail = '"}';
    const padding = MAX_FILE_BYTES - head.length - tail.length;
    const exact = bytesOf(`${head}${"a".repeat(padding)}${tail}`);
    expect(exact.length).toBe(MAX_FILE_BYTES);
    expect(checkReplyFile(exact, "text").kind).toBe("valid");
    expect(checkReplyFile(bytesOf({ formatVersion: 1, kind: "text", body }), "text").kind).toBe(
      "valid",
    );
  });

  it("says not valid JSON before a missing field", () => {
    expect(invalid(bytesOf("[1,"), "text")).toBe("reply file is not valid JSON");
  });

  it("says missing field before the version", () => {
    expect(invalid(bytesOf({ formatVersion: 2, kind: "text" }), "text")).toBe(
      "reply file is missing a required field",
    );
  });

  it("says a body that is not a string or a kind that is not a string is a missing field", () => {
    const missing = "reply file is missing a required field";
    expect(invalid(bytesOf({ formatVersion: 1, kind: "text", body: 5 }), "text")).toBe(missing);
    expect(invalid(bytesOf({ formatVersion: 1, kind: 7, body: "Hi" }), "text")).toBe(missing);
    expect(invalid(bytesOf({ kind: "text", body: "Hi" }), "text")).toBe(missing);
    expect(invalid(bytesOf("null"), "text")).toBe(missing);
    expect(invalid(bytesOf('"text"'), "text")).toBe(missing);
  });

  it("says the version before the kind, and the kind before the body", () => {
    expect(invalid(bytesOf({ formatVersion: "1", kind: "audio", body: "" }), "text")).toBe(
      "reply file has an unknown format version",
    );
    expect(invalid(bytesOf({ formatVersion: 1, kind: "audio", body: "" }), "text")).toBe(
      "reply file has an unknown kind",
    );
  });

  it("says the body does not fit its kind before it looks at json", () => {
    expect(invalid(bytesOf({ formatVersion: 1, kind: "json", body: "" }), "json")).toBe(
      "reply file has a body that does not fit its kind",
    );
  });
});

describe("the bytes of the file", () => {
  const good = { formatVersion: 1, kind: "text", body: "Hi" };

  it("lets one byte order mark at the start through", () => {
    const withBom = Uint8Array.from([...BOM, ...bytesOf(good)]);
    expect(checkReplyFile(withBom, "text").kind).toBe("valid");
  });

  it("does not let two byte order marks through", () => {
    const twice = Uint8Array.from([...BOM, ...BOM, ...bytesOf(good)]);
    expect(invalid(twice, "text")).toBe("reply file is not valid JSON");
  });

  it("calls bytes that are not UTF-8 not valid JSON, without replacing them", () => {
    const broken = Uint8Array.from([...bytesOf('{"formatVersion":1,"kind":"text","body":"'), 0xff]);
    expect(invalid(Uint8Array.from([...broken, ...bytesOf('"}')]), "text")).toBe(
      "reply file is not valid JSON",
    );
  });

  it("calls UTF-16 text not valid JSON", () => {
    const utf16 = Buffer.from(JSON.stringify(good), "utf16le");
    expect(invalid(Uint8Array.from([0xff, 0xfe, ...utf16]), "text")).toBe(
      "reply file is not valid JSON",
    );
  });

  it("accepts a body that holds Unicode text", () => {
    const verdict = checkReplyFile(bytesOf({ ...good, body: "café \u{1f600}" }), "text");
    expect(verdict).toMatchObject({ kind: "valid", reply: { body: "café \u{1f600}" } });
  });
});

describe("the check of a json body is the one check of the answer screen", () => {
  const bodies = ["not json", "  ", '{"a":1} extra', "[1,", '{"a":'];

  it.each(bodies)("gives the reason of checkReply for the body %j", (body) => {
    const check = checkReply("json", body);
    expect(check.ok).toBe(false);
    const reason = invalid(bytesOf({ formatVersion: 1, kind: "text", body }), "json");
    expect(reason).toBe(`reply body is not valid JSON (${check.ok ? "" : check.reason})`);
  });

  it("allows white space around a json body and does not look at the required shape", () => {
    expect(
      checkReplyFile(bytesOf({ formatVersion: 1, kind: "json", body: ' {"a": 1}\n' }), "json").kind,
    ).toBe("valid");
  });

  it("does not put the characters of the body into the reason", () => {
    const reason = invalid(
      bytesOf({ formatVersion: 1, kind: "json", body: "secret-token not json" }),
      "json",
    );
    expect(reason).not.toContain("secret-token");
    expect(isInvalidReplyReason(reason ?? "")).toBe(true);
  });

  it("accepts a skip reply for a json request without looking at the body", () => {
    expect(checkReplyFile(bytesOf({ formatVersion: 1, kind: "skip", body: "" }), "json").kind).toBe(
      "valid",
    );
  });
});

describe("the list of reasons (NFR10)", () => {
  it("knows the seven phrases and nothing else", () => {
    const phrases = [
      INVALID_REPLY_REASONS.tooLarge,
      INVALID_REPLY_REASONS.notJson,
      INVALID_REPLY_REASONS.missingField,
      INVALID_REPLY_REASONS.unknownVersion,
      INVALID_REPLY_REASONS.unknownKind,
      INVALID_REPLY_REASONS.bodyMismatch,
      INVALID_REPLY_REASONS.bodyNotJson("unexpected end of input at line 1"),
      INVALID_REPLY_REASONS.bodyNotJson("unexpected character at line 2, column 3"),
      INVALID_REPLY_REASONS.bodyNotJson("extra data after the JSON value at line 1, column 8"),
    ];
    for (const phrase of phrases) {
      expect(isInvalidReplyReason(phrase)).toBe(true);
    }
    expect(isInvalidReplyReason("reply body is not valid JSON (secret)")).toBe(false);
    expect(isInvalidReplyReason("anything else")).toBe(false);
  });
});

describe("a reply file that calls tools", () => {
  const CALLS = JSON.stringify([
    {
      id: "call_1",
      type: "function",
      function: { name: "f", arguments: "{}" },
    },
  ]);
  const BAD_CALLS = JSON.stringify([
    { id: "", type: "function", function: { name: "f", arguments: "{}" } },
  ]);
  const file = (body: string, kind = "text") => bytesOf({ formatVersion: 1, kind, body });

  it("is valid when the calls fit, for both reply kinds of the request", () => {
    for (const replyKind of ["text", "json"] as const) {
      expect(checkReplyFile(file(CALLS), replyKind, "tools").kind).toBe("valid");
      expect(checkReplyFile(file(CALLS, "json"), replyKind, "both").kind).toBe("valid");
    }
  });

  it("is invalid with a fixed reason when the calls do not fit", () => {
    const expected = INVALID_REPLY_REASONS.badToolCalls("call 1 needs a non-empty string id");
    for (const replyKind of ["text", "json"] as const) {
      expect(invalid(file(BAD_CALLS), replyKind, "tools")).toBe(expected);
    }
    expect(isInvalidReplyReason(expected)).toBe(true);
  });

  it("never carries a typed character in the reason", () => {
    const body = JSON.stringify([
      {
        id: "secret-token",
        type: "secret-token",
        function: { name: "secret-token" },
      },
    ]);
    const reason = invalid(file(body), "text", "tools");
    expect(reason).toBeDefined();
    expect(reason).not.toContain("secret-token");
    expect(isInvalidReplyReason(reason ?? "")).toBe(true);
  });

  it("is judged as text when the request has no definitions, or no default is given", () => {
    expect(checkReplyFile(file(BAD_CALLS), "text").kind).toBe("valid");
    expect(checkReplyFile(file(BAD_CALLS), "text", "none").kind).toBe("valid");
  });

  it("does not look at the calls of a skip reply", () => {
    const skip = bytesOf({ formatVersion: 1, kind: "skip", body: "" });
    expect(checkReplyFile(skip, "text", "tools").kind).toBe("valid");
  });

  it("keeps the earlier reasons first: a body that is not json for a json request", () => {
    expect(invalid(file("not json"), "json", "tools")).toBe(
      "reply body is not valid JSON (unexpected character at line 1, column 2)",
    );
    expect(checkReplyFile(file("Hello"), "text", "tools").kind).toBe("valid");
  });
});

describe("an audio reply file (FR16.2)", () => {
  const ASKING: AudioRequest = { asked: true, format: "wav" };
  const audioFile = (extra: Record<string, unknown> = {}) =>
    bytesOf({
      formatVersion: 2,
      kind: "audio",
      body: "Hello",
      audio: replyAudio("wav"),
      ...extra,
    });
  const reasonOf = (
    bytes: Uint8Array,
    audio: AudioRequest = ASKING,
    replyKind: ReplyKind = "text",
    toolDefinitions: ToolDefinitions = "none",
  ): string | undefined => {
    const verdict = checkReplyFile(bytes, replyKind, toolDefinitions, audio);
    return verdict.kind === "invalid" ? verdict.reason : undefined;
  };

  it("accepts audio with a transcript, and without one", () => {
    const verdict = checkReplyFile(audioFile(), "text", "none", ASKING);
    expect(verdict).toMatchObject({
      kind: "valid",
      reply: { formatVersion: 2, kind: "audio", body: "Hello", audio: replyAudio("wav") },
    });
    expect(reasonOf(audioFile({ body: "" }))).toBeUndefined();
  });

  it("accepts every format, with its leading bytes", () => {
    for (const format of AUDIO_FORMATS) {
      const bytes = audioFile({ audio: replyAudio(format) });
      expect(reasonOf(bytes, { asked: true, format })).toBeUndefined();
    }
  });

  it("accepts any format when the request names none", () => {
    expect(
      reasonOf(audioFile({ audio: replyAudio("flac") }), { asked: true, format: undefined }),
    ).toBe(undefined);
  });

  it("says an audio reply of version 1, or a text reply of version 2, is not known", () => {
    expect(reasonOf(audioFile({ formatVersion: 1 }))).toBe(INVALID_REPLY_REASONS.unknownKind);
    expect(
      reasonOf(bytesOf({ formatVersion: 2, kind: "text", body: "Hi", audio: replyAudio("wav") })),
    ).toBe(INVALID_REPLY_REASONS.unknownVersion);
  });

  it("says a missing or non-object audio field is a missing field", () => {
    for (const audio of [undefined, null, "wav", []]) {
      expect(reasonOf(audioFile({ audio }))).toBe(INVALID_REPLY_REASONS.missingField);
    }
  });

  it("checks the format name first", () => {
    for (const format of ["aac", "WAV", 5, undefined]) {
      const audio = { format, data: "not base64!" };
      expect(reasonOf(audioFile({ audio }))).toBe(INVALID_REPLY_REASONS.audioFormat);
    }
  });

  it("then checks that the data is base64 and holds at least one byte", () => {
    for (const data of ["", "***", "AAA=A", "=AAA", 5, null, undefined]) {
      const audio = { format: "wav", data };
      expect(reasonOf(audioFile({ audio }))).toBe(INVALID_REPLY_REASONS.audioData);
    }
  });

  it("then checks the leading bytes against the format", () => {
    const mismatches = [
      { format: "wav", data: replyAudio("flac").data },
      { format: "wav", data: Buffer.from("RIFF").toString("base64") },
      { format: "pcm16", data: Buffer.from([1, 2, 3]).toString("base64") },
    ];
    for (const audio of mismatches) {
      expect(reasonOf(audioFile({ audio }), { asked: true, format: undefined })).toBe(
        INVALID_REPLY_REASONS.audioContent,
      );
    }
  });

  it("then checks that the request asked for audio", () => {
    expect(reasonOf(audioFile(), NO_AUDIO_REQUEST)).toBe(INVALID_REPLY_REASONS.audioNotAsked);
    expect(checkReplyFile(audioFile(), "text").kind).toBe("invalid");
  });

  it("then checks the format against audio.format of the request", () => {
    expect(reasonOf(audioFile(), { asked: true, format: "mp3" })).toBe(
      INVALID_REPLY_REASONS.audioFormatDiffers,
    );
  });

  it("then refuses a request for structured output", () => {
    expect(reasonOf(audioFile({ body: '{"a":1}' }), ASKING, "json")).toBe(
      INVALID_REPLY_REASONS.audioStructured,
    );
    expect(reasonOf(audioFile({ body: "" }), ASKING, "json")).toBe(
      INVALID_REPLY_REASONS.audioStructured,
    );
  });

  it("then refuses a transcript that calls tools", () => {
    const calls = JSON.stringify([
      { id: "call_1", type: "function", function: { name: "f", arguments: "{}" } },
    ]);
    expect(reasonOf(audioFile({ body: calls }), ASKING, "text", "tools")).toBe(
      INVALID_REPLY_REASONS.audioToolCalls,
    );
    expect(reasonOf(audioFile({ body: calls }), ASKING, "text", "none")).toBeUndefined();
  });

  it("refuses a file over 10 MB as too large, before it is read", () => {
    const big = Buffer.alloc(MAX_FILE_BYTES + 1, 0x20);
    expect(reasonOf(big)).toBe(INVALID_REPLY_REASONS.tooLarge);
  });

  it("accepts the largest audio reply file within the limit and refuses one byte of audio more (NFR18)", () => {
    const { fits, over } = audioSizesAtLimit(MAX_FILE_BYTES);
    const within = Buffer.from(
      serializeFile(
        createReplyFile("", "2026-10-09T14:05:12.123Z", "audio", replyAudioOfSize("wav", fits)),
      ),
    );
    const beyond = Buffer.from(
      serializeFile(
        createReplyFile("", "2026-10-09T14:05:12.123Z", "audio", replyAudioOfSize("wav", over)),
      ),
    );
    expect(within.length).toBeLessThanOrEqual(MAX_FILE_BYTES);
    expect(beyond.length).toBeGreaterThan(MAX_FILE_BYTES);
    expect(reasonOf(within)).toBeUndefined();
    expect(reasonOf(beyond)).toBe(INVALID_REPLY_REASONS.tooLarge);
  });

  it("never puts a character of the file in a reason", () => {
    const secret = "secret-format";
    const reasons = [
      reasonOf(audioFile({ audio: { format: secret, data: secret } })),
      reasonOf(audioFile({ audio: { format: "wav", data: secret } })),
      reasonOf(audioFile({ body: secret }), NO_AUDIO_REQUEST),
    ];
    for (const reason of reasons) {
      expect(reason).toBeDefined();
      expect(reason).not.toContain(secret);
      expect(isInvalidReplyReason(reason ?? "")).toBe(true);
    }
  });

  it("does not look at an audio field of a text reply", () => {
    const text = bytesOf({ formatVersion: 1, kind: "text", body: "Hi", audio: "anything" });
    expect(checkReplyFile(text, "text").kind).toBe("valid");
  });
});
