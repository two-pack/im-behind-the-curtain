/**
 * The one check of a reply file that a person or a tool wrote by hand.
 * It looks only at the bytes of the file and at the reply kind of the request, so the same bytes
 * and kind give the same verdict at any time. The reason of a refusal is one of the fixed phrases
 * of `INVALID_REPLY_REASONS` and never carries a character of the file (NFR10).
 */
import {
  FORMAT_VERSION,
  INVALID_REPLY_REASONS,
  MAX_FILE_BYTES,
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

/** What a check knows about the request: its reply kind and which definitions it has. */
interface RequestInfo {
  replyKind: ReplyKind;
  toolDefinitions: ToolDefinitions;
}

/** A check that returns the reason of a refusal, or undefined when the content passes it. */
type Check = (content: Content, request: RequestInfo) => string | undefined;

const BYTE_ORDER_MARK = "﻿";
const KNOWN_KINDS: readonly string[] = ["text", "json", "skip"];

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

function bodyFitsKind(content: Content): boolean {
  return content.kind === "skip" ? content.body === "" : content.body !== "";
}

/** A body that has to be JSON for this request, and is not. */
function bodyNotJson(content: Content, request: RequestInfo): string | undefined {
  if (request.replyKind !== "json" || content.kind === "skip") {
    return undefined;
  }
  const check = checkReply("json", content.body);
  return check.ok ? undefined : INVALID_REPLY_REASONS.bodyNotJson(check.reason);
}

/** A body that calls tools in a way that does not fit, for a request that has definitions. */
function badToolCalls(content: Content, request: RequestInfo): string | undefined {
  if (content.kind === "skip") {
    return undefined;
  }
  const check = checkReply("text", content.body, request.toolDefinitions);
  return check.ok ? undefined : INVALID_REPLY_REASONS.badToolCalls(check.reason);
}

/** The checks of the content, in order. The first one that finds a reason decides. */
const CONTENT_CHECKS: readonly Check[] = [
  (content) =>
    content.formatVersion === FORMAT_VERSION ? undefined : INVALID_REPLY_REASONS.unknownVersion,
  (content) => (KNOWN_KINDS.includes(content.kind) ? undefined : INVALID_REPLY_REASONS.unknownKind),
  (content) => (bodyFitsKind(content) ? undefined : INVALID_REPLY_REASONS.bodyMismatch),
  bodyNotJson,
  badToolCalls,
];

function replyOf(content: Content): ReplyFile {
  const reply: ReplyFile = {
    formatVersion: FORMAT_VERSION,
    kind: content.kind as ReplyFileKind,
    body: content.body,
  };
  if (typeof content.source === "string") {
    reply.source = content.source;
  }
  if (typeof content.writtenAt === "string") {
    reply.writtenAt = content.writtenAt;
  }
  return reply;
}

/**
 * Judges the bytes of one reply.json for a request that asks for `replyKind` and has these tool
 * definitions (none, when left out).
 */
export function checkReplyFile(
  bytes: Uint8Array,
  replyKind: ReplyKind,
  toolDefinitions: ToolDefinitions = "none",
): ReplyFileVerdict {
  const request: RequestInfo = { replyKind, toolDefinitions };
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
