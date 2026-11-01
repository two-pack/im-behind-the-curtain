/**
 * The one check of a reply file that a person or a tool wrote by hand.
 * It looks only at the bytes of the file and at the reply kind of the request, so the same bytes
 * and kind give the same verdict at any time. The reason of a refusal is one of the fixed phrases
 * of `INVALID_REPLY_REASONS` and never carries a character of the file (NFR10).
 */
import {
  type AudioRequest,
  checkAudioRules,
  matchesFormat,
  NO_AUDIO_REQUEST,
  type RuleProblem,
} from "../audio-reply.js";
import { readBase64 } from "../media-parts.js";
import {
  AUDIO_REPLY_FORMAT_VERSION,
  FORMAT_VERSION,
  INVALID_REPLY_REASONS,
  isAudioFormat,
  MAX_FILE_BYTES,
  type ReplyAudio,
  type ReplyFile,
  type ReplyFileKind,
  type ReplyKind,
  type ToolDefinitions,
} from "../model.js";
import { checkReply } from "./reply-check.js";

export type ReplyFileVerdict =
  | { kind: "valid"; reply: ReplyFile }
  | { kind: "invalid"; reason: string };

/** A reply file that is JSON with a text `kind` and a text `body`; the other fields are unchecked. */
type Content = Record<string, unknown> & { kind: string; body: string };

/** What a check knows about the request: its reply kind, its definitions and its audio. */
interface RequestInfo {
  replyKind: ReplyKind;
  toolDefinitions: ToolDefinitions;
  audio: AudioRequest;
}

/** A check that returns the reason of a refusal, or undefined when the content passes it. */
type Check = (content: Content, request: RequestInfo) => string | undefined;

const BYTE_ORDER_MARK = "﻿";

/** The kinds each format version knows. An audio reply is version 2; the rest are version 1. */
const KINDS_OF_VERSION: ReadonlyMap<unknown, readonly string[]> = new Map([
  [FORMAT_VERSION, ["text", "json", "skip"]],
  [AUDIO_REPLY_FORMAT_VERSION, ["audio"]],
]);

/** The fixed reason for each way a request can refuse an audio reply. */
const RULE_REASONS: Readonly<Record<RuleProblem, string>> = {
  notAsked: INVALID_REPLY_REASONS.audioNotAsked,
  formatDiffers: INVALID_REPLY_REASONS.audioFormatDiffers,
  structured: INVALID_REPLY_REASONS.audioStructured,
  toolCalls: INVALID_REPLY_REASONS.audioToolCalls,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContent(value: unknown): value is Content {
  return (
    isRecord(value) &&
    Object.hasOwn(value, "formatVersion") &&
    typeof value.kind === "string" &&
    typeof value.body === "string"
  );
}

/** Reads the bytes as strict UTF-8 JSON. One byte order mark at the start is allowed. */
function parseBytes(bytes: Uint8Array): { value: unknown } | { reason: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const json = text.startsWith(BYTE_ORDER_MARK) ? text.slice(BYTE_ORDER_MARK.length) : text;
    return { value: JSON.parse(json) as unknown };
  } catch {
    return { reason: INVALID_REPLY_REASONS.notJson };
  }
}

/** A skip reply has no body, an audio reply may have none, and the others need one. */
function bodyFitsKind(content: Content): boolean {
  if (content.kind === "audio") {
    return true;
  }
  return content.kind === "skip" ? content.body === "" : content.body !== "";
}

/** A body that has to be JSON for this request, and is not. */
function bodyNotJson(content: Content, request: RequestInfo): string | undefined {
  if (request.replyKind !== "json" || content.kind === "skip" || content.kind === "audio") {
    return undefined;
  }
  const check = checkReply("json", content.body);
  return check.ok ? undefined : INVALID_REPLY_REASONS.bodyNotJson(check.reason);
}

/** A body that calls tools in a way that does not fit, for a request that has definitions. */
function badToolCalls(content: Content, request: RequestInfo): string | undefined {
  if (content.kind === "skip" || content.kind === "audio") {
    return undefined;
  }
  const check = checkReply("text", content.body, request.toolDefinitions);
  return check.ok ? undefined : INVALID_REPLY_REASONS.badToolCalls(check.reason);
}

/**
 * The checks of the audio of an audio reply, in order: the format name, that the data is base64
 * of at least one byte, that its leading bytes fit the format, and then what the request allows.
 * The size of the whole file was checked first, before the file was read. Other kinds pass.
 */
function audioProblem(content: Content, request: RequestInfo): string | undefined {
  if (content.kind !== "audio") {
    return undefined;
  }
  const { audio } = content;
  if (!isRecord(audio)) {
    return INVALID_REPLY_REASONS.missingField;
  }
  if (!isAudioFormat(audio.format)) {
    return INVALID_REPLY_REASONS.audioFormat;
  }
  const bytes = typeof audio.data === "string" ? readBase64(audio.data) : undefined;
  if (bytes === undefined || bytes.length === 0) {
    return INVALID_REPLY_REASONS.audioData;
  }
  if (!matchesFormat(audio.format, bytes)) {
    return INVALID_REPLY_REASONS.audioContent;
  }
  const problem = checkAudioRules(
    {
      replyKind: request.replyKind,
      toolDefinitions: request.toolDefinitions,
      audio: request.audio,
    },
    audio.format,
    content.body,
  );
  return problem === undefined ? undefined : RULE_REASONS[problem];
}

/** The checks of the content, in order. The first one that finds a reason decides. */
const CONTENT_CHECKS: readonly Check[] = [
  // Version 2 is known only for an audio reply, and an audio reply only in version 2.
  (content) =>
    content.formatVersion === FORMAT_VERSION ||
    (content.formatVersion === AUDIO_REPLY_FORMAT_VERSION && content.kind === "audio")
      ? undefined
      : INVALID_REPLY_REASONS.unknownVersion,
  (content) =>
    KINDS_OF_VERSION.get(content.formatVersion)?.includes(content.kind) === true
      ? undefined
      : INVALID_REPLY_REASONS.unknownKind,
  (content) => (bodyFitsKind(content) ? undefined : INVALID_REPLY_REASONS.bodyMismatch),
  bodyNotJson,
  badToolCalls,
  audioProblem,
];

function replyOf(content: Content): ReplyFile {
  const reply: ReplyFile = {
    formatVersion: content.kind === "audio" ? AUDIO_REPLY_FORMAT_VERSION : FORMAT_VERSION,
    kind: content.kind as ReplyFileKind,
    body: content.body,
  };
  if (content.kind === "audio") {
    // The checks have shown that `audio` is an object with a known format and base64 data.
    const { format, data } = content.audio as ReplyAudio;
    reply.audio = { format, data };
  }
  if (typeof content.source === "string") {
    reply.source = content.source;
  }
  if (typeof content.writtenAt === "string") {
    reply.writtenAt = content.writtenAt;
  }
  return reply;
}

/**
 * Judges the bytes of one reply.json for a request that asks for `replyKind`, has these tool
 * definitions (none, when left out) and says this about audio (nothing asked, when left out).
 */
export function checkReplyFile(
  bytes: Uint8Array,
  replyKind: ReplyKind,
  toolDefinitions: ToolDefinitions = "none",
  audio: AudioRequest = NO_AUDIO_REQUEST,
): ReplyFileVerdict {
  const request: RequestInfo = { replyKind, toolDefinitions, audio };
  if (bytes.length > MAX_FILE_BYTES) {
    return { kind: "invalid", reason: INVALID_REPLY_REASONS.tooLarge };
  }
  const parsed = parseBytes(bytes);
  if ("reason" in parsed) {
    return { kind: "invalid", reason: parsed.reason };
  }
  if (!isContent(parsed.value)) {
    return { kind: "invalid", reason: INVALID_REPLY_REASONS.missingField };
  }
  const content = parsed.value;
  for (const check of CONTENT_CHECKS) {
    const reason = check(content, request);
    if (reason !== undefined) {
      return { kind: "invalid", reason };
    }
  }
  return { kind: "valid", reply: replyOf(content) };
}
