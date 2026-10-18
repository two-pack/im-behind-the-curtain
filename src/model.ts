/**
 * The shapes of the files in the storage directory and of the shared
 * conversation request. This module has no imports of its own.
 */

/** The format version of state.json and reply.json. */
export const FORMAT_VERSION = 1;

/** The format version that request.json is written with. Version 1 files are still read. */
const REQUEST_FORMAT_VERSION = 2;

/** The most bytes a reply file may have, as written. */
export const MAX_FILE_BYTES = 10485760;

/**
 * The fixed reasons that a reply file is not valid (entity InvalidReplyReason). They are the same
 * text in the serve line, in `endReason` of state.json and in the error sent to the client, and
 * they never carry a character of the reply (NFR10).
 */
export const INVALID_REPLY_REASONS = {
  tooLarge: "reply file is larger than 10 MB",
  notJson: "reply file is not valid JSON",
  missingField: "reply file is missing a required field",
  unknownVersion: "reply file has an unknown format version",
  unknownKind: "reply file has an unknown kind",
  bodyMismatch: "reply file has a body that does not fit its kind",
  bodyNotJson: (detail: string): string => `reply body is not valid JSON (${detail})`,
  badToolCalls: (detail: string): string => `reply tool calls are not valid (${detail})`,
} as const;

const FIXED_REASONS: ReadonlySet<string> = new Set([
  INVALID_REPLY_REASONS.tooLarge,
  INVALID_REPLY_REASONS.notJson,
  INVALID_REPLY_REASONS.missingField,
  INVALID_REPLY_REASONS.unknownVersion,
  INVALID_REPLY_REASONS.unknownKind,
  INVALID_REPLY_REASONS.bodyMismatch,
]);

/** The three phrases for a text that is not valid JSON, which carry only numbers. */
const BODY_DETAIL =
  /^(?:unexpected end of input at line \d+|unexpected character at line \d+, column \d+|extra data after the JSON value at line \d+, column \d+)$/;
const BODY_REASON = /^reply body is not valid JSON \((.*)\)$/;

/** What follows `call <number> ` in each problem of one call. */
const CALL_PROBLEM_TAILS = {
  needsId: "needs a non-empty string id",
  sameId: "has the same id as an earlier call",
  needsType: 'needs the type "function"',
  needsName: "needs function.name as a non-empty string",
  needsArguments: "needs function.arguments as a string",
} as const;

const callProblem =
  (tail: string) =>
  (number: number): string =>
    `call ${number} ${tail}`;

/**
 * The only phrases for tool calls that are not valid, defined here once: tool-calls.ts writes
 * them and the log checks them. They carry only the number of a call, never a typed character.
 */
export const TOOL_CALL_PROBLEMS = {
  needsId: callProblem(CALL_PROBLEM_TAILS.needsId),
  sameId: callProblem(CALL_PROBLEM_TAILS.sameId),
  needsType: callProblem(CALL_PROBLEM_TAILS.needsType),
  needsName: callProblem(CALL_PROBLEM_TAILS.needsName),
  needsArguments: callProblem(CALL_PROBLEM_TAILS.needsArguments),
  oneCallOnly: "this request defines functions only, so exactly one call is allowed",
} as const;

const CALL_PROBLEM_TAIL_SET: ReadonlySet<string> = new Set(Object.values(CALL_PROBLEM_TAILS));
const CALL_PROBLEM_DETAIL = /^call \d+ (.*)$/;

/** Whether `detail` is one of the phrases of `TOOL_CALL_PROBLEMS`, with any call number. */
function isToolCallsDetail(detail: string): boolean {
  if (detail === TOOL_CALL_PROBLEMS.oneCallOnly) {
    return true;
  }
  const tail = CALL_PROBLEM_DETAIL.exec(detail)?.[1];
  return tail !== undefined && CALL_PROBLEM_TAIL_SET.has(tail);
}

const TOOL_CALLS_REASON = /^reply tool calls are not valid \((.*)\)$/;

/** Whether `text` is one of the fixed reasons. The log writes no other text as a reason. */
export function isInvalidReplyReason(text: string): boolean {
  if (FIXED_REASONS.has(text)) {
    return true;
  }
  const bodyDetail = BODY_REASON.exec(text)?.[1];
  if (bodyDetail !== undefined) {
    return BODY_DETAIL.test(bodyDetail);
  }
  const callsDetail = TOOL_CALLS_REASON.exec(text)?.[1];
  return callsDetail !== undefined && isToolCallsDetail(callsDetail);
}

export const ROLES = ["system", "developer", "user", "assistant", "tool", "function"] as const;
export type Role = (typeof ROLES)[number];

/**
 * Which definitions a request carries: `tools`, `functions`, both, or neither. An empty array
 * is no definition.
 */
export type ToolDefinitions = "tools" | "functions" | "both" | "none";

const TOOL_DEFINITIONS: readonly ToolDefinitions[] = ["tools", "functions", "both", "none"];

/** One tool call of a reply, as typed (`raw`) and its fields that were checked. */
export interface ToolCallItem {
  raw: Record<string, unknown>;
  id: string;
  name: string;
  arguments: string;
}

/**
 * What a human reply is for the client: free text, tool calls, or one legacy function call.
 * Text is the reply body as it is.
 */
export type ToolReply =
  | { kind: "text" }
  | { kind: "tool_calls"; calls: ToolCallItem[] }
  | { kind: "function_call"; name: string; arguments: string };

/** What a human reply must be: free text, or text that reads as JSON. */
export type ReplyKind = "text" | "json";

/** The kinds a reply file can have. `skip` carries no text and ends the request. */
export type ReplyFileKind = ReplyKind | "skip";

const REPLY_KINDS: readonly ReplyKind[] = ["text", "json"];
const REPLY_FILE_KINDS: readonly ReplyFileKind[] = ["text", "json", "skip"];

/**
 * The fields of a message that belong to tools. They are kept as received, with whatever type
 * the client sent, and only when the client sent them.
 */
export interface ToolFields {
  tool_call_id?: unknown;
  name?: unknown;
  tool_calls?: unknown;
  function_call?: unknown;
}

const TOOL_FIELD_NAMES = ["tool_call_id", "name", "tool_calls", "function_call"] as const;

export interface Message extends ToolFields {
  role: Role;
  content: string;
}

/** The tool fields that `source` has, with the values it has. */
export function pickToolFields(source: Record<string, unknown>): ToolFields {
  const fields: ToolFields = {};
  for (const name of TOOL_FIELD_NAMES) {
    if (Object.hasOwn(source, name)) {
      fields[name] = source[name];
    }
  }
  return fields;
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
  /** Missing means `none`. */
  toolDefinitions?: ToolDefinitions;
}

export interface RequestFile extends ConversationRequest {
  /** The version the file was written with: 1 by an older version, 2 by this one. */
  formatVersion: 1 | 2;
  id: string;
  receivedAt: string;
  toolDefinitions: ToolDefinitions;
}

/** The states this version writes. A request leaves `waiting` once, for one of the others. */
export type WrittenState =
  | "waiting"
  | "replied"
  | "skipped"
  | "cancelled"
  | "timed_out"
  | "abandoned"
  | "invalid_reply";

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

function isToolDefinitions(value: unknown): value is ToolDefinitions {
  return typeof value === "string" && (TOOL_DEFINITIONS as readonly string[]).includes(value);
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
    messages.push({
      role: item.role,
      content: item.content,
      ...pickToolFields(item),
    });
  }
  return messages;
}

/** The version and the tool definitions of a request file; undefined when it cannot be read. */
function readVersion(
  data: Record<string, unknown>,
): { formatVersion: 1 | 2; toolDefinitions: ToolDefinitions } | undefined {
  if (data.formatVersion === 1) {
    return { formatVersion: 1, toolDefinitions: "none" };
  }
  if (data.formatVersion === REQUEST_FORMAT_VERSION && isToolDefinitions(data.toolDefinitions)) {
    return {
      formatVersion: REQUEST_FORMAT_VERSION,
      toolDefinitions: data.toolDefinitions,
    };
  }
  return undefined;
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
  if (!isRecord(data) || !hasRequestFields(data)) {
    return UNREADABLE;
  }
  const version = readVersion(data);
  const conversation = parseConversation(data.conversation);
  if (version === undefined || conversation === undefined) {
    return UNREADABLE;
  }
  if (data.format !== "chat.completions" || !isReplyKind(data.replyKind)) {
    return UNSUPPORTED;
  }
  return {
    kind: "ok",
    value: {
      ...version,
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
    formatVersion: REQUEST_FORMAT_VERSION,
    id,
    receivedAt,
    toolDefinitions: request.toolDefinitions ?? "none",
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
