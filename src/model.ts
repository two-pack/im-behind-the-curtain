/**
 * The shapes of the files in the storage directory and of the shared
 * conversation request. This module has no imports of its own.
 */

export const FORMAT_VERSION = 1;

export const ROLES = ["system", "developer", "user", "assistant"] as const;
export type Role = (typeof ROLES)[number];

/** What a human reply must be: free text, or text that reads as JSON. */
export type ReplyKind = "text" | "json";

/** The kinds a reply file can have. `skip` carries no text and ends the request. */
export type ReplyFileKind = ReplyKind | "skip";

const REPLY_KINDS: readonly ReplyKind[] = ["text", "json"];
const REPLY_FILE_KINDS: readonly ReplyFileKind[] = ["text", "json", "skip"];

export interface Message {
  role: Role;
  content: string;
}

/** The format-independent form of a request. */
export interface ConversationRequest {
  format: "chat.completions";
  model: string;
  replyKind: ReplyKind;
  requiredShape: Record<string, unknown> | null;
  stream: boolean;
  includeUsage: boolean;
  conversation: Message[];
  originalRequest: Record<string, unknown>;
}

export interface RequestFile extends ConversationRequest {
  formatVersion: 1;
  id: string;
  receivedAt: string;
}

/** The states this version writes. A request leaves `waiting` once, for one of the others. */
export type WrittenState =
  | "waiting"
  | "replied"
  | "skipped"
  | "cancelled"
  | "timed_out"
  | "abandoned";

/** Every state this version knows by name: the written ones, and `invalid_reply`. */
const KNOWN_STATES: readonly string[] = [
  "waiting",
  "replied",
  "skipped",
  "cancelled",
  "timed_out",
  "abandoned",
  "invalid_reply",
];

/** `other` stands for any state this version does not know. It is read as a finished request. */
type ExchangeState = WrittenState | "invalid_reply" | "other";

export interface StateFile {
  formatVersion: 1;
  id: string;
  state: ExchangeState;
  updatedAt: string;
  endedAt: string | null;
  endReason: string | null;
}

export interface ReplyFile {
  formatVersion: 1;
  kind: ReplyFileKind;
  /** Empty for a `skip` reply. At least one character for the other kinds. */
  body: string;
  source?: string;
  writtenAt?: string;
}

/**
 * The result of reading a file.
 * `unreadable`: broken, or a formatVersion this version does not know.
 * `unsupported`: a readable file whose format or reply kind this version does not handle.
 */
export type Loaded<T> = { kind: "ok"; value: T } | { kind: "unreadable" } | { kind: "unsupported" };

const UNREADABLE = { kind: "unreadable" } as const;
const UNSUPPORTED = { kind: "unsupported" } as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isReplyKind(value: unknown): value is ReplyKind {
  return typeof value === "string" && (REPLY_KINDS as readonly string[]).includes(value);
}

function isReplyFileKind(value: unknown): value is ReplyFileKind {
  return typeof value === "string" && (REPLY_FILE_KINDS as readonly string[]).includes(value);
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

function parseConversation(value: unknown): Message[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const messages: Message[] = [];
  for (const item of value) {
    if (!isRecord(item) || !isRole(item.role) || typeof item.content !== "string") {
      return undefined;
    }
    messages.push({ role: item.role, content: item.content });
  }
  return messages;
}

function hasRequestFields(data: Record<string, unknown>): boolean {
  return (
    typeof data.id === "string" &&
    typeof data.receivedAt === "string" &&
    typeof data.model === "string" &&
    typeof data.stream === "boolean" &&
    typeof data.includeUsage === "boolean" &&
    isRecord(data.originalRequest)
  );
}

export function parseRequestFile(data: unknown): Loaded<RequestFile> {
  if (!isRecord(data) || data.formatVersion !== FORMAT_VERSION || !hasRequestFields(data)) {
    return UNREADABLE;
  }
  const conversation = parseConversation(data.conversation);
  if (conversation === undefined) {
    return UNREADABLE;
  }
  if (data.format !== "chat.completions" || !isReplyKind(data.replyKind)) {
    return UNSUPPORTED;
  }
  return {
    kind: "ok",
    value: {
      formatVersion: FORMAT_VERSION,
      id: data.id as string,
      receivedAt: data.receivedAt as string,
      format: "chat.completions",
      model: data.model as string,
      replyKind: data.replyKind,
      requiredShape: isRecord(data.requiredShape) ? data.requiredShape : null,
      stream: data.stream as boolean,
      includeUsage: data.includeUsage as boolean,
      conversation,
      originalRequest: data.originalRequest as Record<string, unknown>,
    },
  };
}

export function parseStateFile(data: unknown): Loaded<StateFile> {
  if (!isRecord(data) || data.formatVersion !== FORMAT_VERSION || typeof data.state !== "string") {
    return UNREADABLE;
  }
  const state = KNOWN_STATES.includes(data.state) ? (data.state as ExchangeState) : "other";
  return {
    kind: "ok",
    value: {
      formatVersion: FORMAT_VERSION,
      id: typeof data.id === "string" ? data.id : "",
      state,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
      endedAt: typeof data.endedAt === "string" ? data.endedAt : null,
      endReason: typeof data.endReason === "string" ? data.endReason : null,
    },
  };
}

/**
 * A text, json or skip reply is accepted. Other kinds are `unsupported`. A skip reply with a
 * body, and a text or json reply without one, are `unreadable`.
 */
export function parseReplyFile(data: unknown): Loaded<ReplyFile> {
  if (!isRecord(data) || data.formatVersion !== FORMAT_VERSION || typeof data.body !== "string") {
    return UNREADABLE;
  }
  if (!isReplyFileKind(data.kind)) {
    return UNSUPPORTED;
  }
  // Only a skip reply has an empty body.
  if ((data.kind === "skip") !== (data.body === "")) {
    return UNREADABLE;
  }
  const reply: ReplyFile = { formatVersion: FORMAT_VERSION, kind: data.kind, body: data.body };
  if (typeof data.source === "string") {
    reply.source = data.source;
  }
  if (typeof data.writtenAt === "string") {
    reply.writtenAt = data.writtenAt;
  }
  return { kind: "ok", value: reply };
}

export function createRequestFile(
  id: string,
  receivedAt: string,
  request: ConversationRequest,
): RequestFile {
  return {
    formatVersion: FORMAT_VERSION,
    id,
    receivedAt,
    format: request.format,
    model: request.model,
    replyKind: request.replyKind,
    requiredShape: request.requiredShape,
    stream: request.stream,
    includeUsage: request.includeUsage,
    conversation: request.conversation,
    originalRequest: request.originalRequest,
  };
}

export function createStateFile(
  id: string,
  state: WrittenState,
  updatedAt: string,
  endedAt: string | null,
  endReason: string | null = null,
): StateFile {
  return { formatVersion: FORMAT_VERSION, id, state, updatedAt, endedAt, endReason };
}

export function createReplyFile(
  body: string,
  writtenAt: string,
  kind: ReplyFileKind = "text",
): ReplyFile {
  return {
    formatVersion: FORMAT_VERSION,
    kind,
    body,
    source: "imbehind-answer",
    writtenAt,
  };
}

/** The text of a file as stored: indented JSON that ends with one newline. */
export function serializeFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
