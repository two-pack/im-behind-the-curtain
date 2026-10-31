/**
 * The Chat Completions adapter: checks a request body, turns it into the shared
 * conversation form, and builds the response and error bodies.
 * It has no side effects and calls only the leaf modules.
 */
import {
  audioMediaType,
  type DataUrlContent,
  isDataUrl,
  readBase64,
  readDataUrl,
  savedFileName,
} from "../media-parts.js";
import {
  type Attachment,
  type ConversationRequest,
  characterCount,
  type Message,
  type PartFileData,
  pickToolFields,
  type ReplyKind,
  ROLES,
  type Role,
  type ToolDefinitions,
  type ToolReply,
} from "../model.js";

export type ErrorCode =
  | "invalid_request"
  | "request_too_large"
  | "not_found"
  | "method_not_allowed"
  | "storage_error"
  | "skipped_by_human"
  | "reply_timeout"
  | "invalid_reply";

/** The fixed English sentences of this API. A request value is never copied into them. */
export const MESSAGES = {
  invalidJson: "Request body is not valid JSON.",
  messagesRequired: '"messages" must be a non-empty array.',
  modelRequired: '"model" must be a string.',
  messageNotObject: "Each message must be an object.",
  contentType: "Message content must be a string, null, or an array of content parts.",
  tooManyChoices: 'Only one choice can be returned; "n" must be 1.',
  requestTooLarge: "Request body is larger than 10 MB.",
  notFound: "Not found.",
  methodNotAllowed: "Method not allowed.",
  storage: "The request could not be stored.",
  skipped: "The human skipped this request.",
  crossOrigin: "Cross-origin requests are not accepted.",
  unexpectedHost: "Unexpected Host header.",
} as const;

/** Longest piece of a role name that is put into an error message. */
const MAX_ROLE_LENGTH = 64;

/** Why a request is turned away: it is malformed. */
interface Failure {
  code: "invalid_request";
  message: string;
}

interface RequestRejection extends Failure {
  status: 400;
}

export type AdapterResult =
  | {
      ok: true;
      request: ConversationRequest;
      /** The bytes of the parts that are saved as files, in the order they arrived. */
      parts: PartFileData[];
    }
  | { ok: false; rejection: RequestRejection };

export interface ErrorBody {
  error: {
    message: string;
    type: "invalid_request_error" | "server_error";
    code: ErrorCode;
  };
}

/** Why the response ends: a text reply, tool calls, or one legacy function call. */
type FinishReason = "stop" | "tool_calls" | "function_call";

/** The message of a response. The content is null when the reply calls tools. */
type CompletionMessage =
  | { role: "assistant"; content: string }
  | { role: "assistant"; content: null; tool_calls: Record<string, unknown>[] }
  | {
      role: "assistant";
      content: null;
      function_call: { name: string; arguments: string };
    };

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: CompletionMessage;
      finish_reason: FinishReason;
    },
  ];
  usage: { prompt_tokens: 0; completion_tokens: 0; total_tokens: 0 };
}

function invalid(message: string): Failure {
  return { code: "invalid_request", message };
}

function reject(failure: Failure): AdapterResult {
  return { ok: false, rejection: { status: 400, ...failure } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

function roleMessage(role: unknown): string {
  const shown = typeof role === "string" ? role.slice(0, MAX_ROLE_LENGTH) : "";
  return `Unsupported message role: "${shown}".`;
}

/** A check returns the failure when it fails, and undefined when it passes. */
type Check<T> = (value: T) => Failure | undefined;

/** Checks on the whole body, in order. */
const BODY_CHECKS: readonly Check<Record<string, unknown>>[] = [
  (body) =>
    Array.isArray(body.messages) && body.messages.length > 0
      ? undefined
      : invalid(MESSAGES.messagesRequired),
  (body) => (typeof body.model === "string" ? undefined : invalid(MESSAGES.modelRequired)),
];

/** Runs the checks in order and returns the first failure. */
function firstError<T>(checks: readonly Check<T>[], value: T): Failure | undefined {
  for (const check of checks) {
    const error = check(value);
    if (error !== undefined) {
      return error;
    }
  }
  return undefined;
}

/** Whether a value is an array with at least one entry. What the entries hold is not looked at. */
function hasEntries(value: unknown): boolean {
  return Array.isArray(value) && value.length > 0;
}

/** A role that is none of the six. */
function checkRole(message: Record<string, unknown>): Failure | undefined {
  return isRole(message.role) ? undefined : invalid(roleMessage(message.role));
}

/** Whether a value is there: not missing and not null. What it holds is not looked at. */
function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null;
}

/** An assistant message that has `tool_calls` or `function_call` may leave out its content. */
function mayLeaveOutContent(message: Record<string, unknown>): boolean {
  return (
    message.role === "assistant" &&
    (isPresent(message.tool_calls) || isPresent(message.function_call))
  );
}

/** Checks on one message before its content is read, in order. */
const MESSAGE_CHECKS: readonly Check<Record<string, unknown>>[] = [checkRole];

/**
 * Which definitions the body carries. An array with at least one entry counts; what the entries
 * hold is not looked at.
 */
function readToolDefinitions(body: Record<string, unknown>): ToolDefinitions {
  const tools = hasEntries(body.tools);
  const functions = hasEntries(body.functions);
  if (tools && functions) {
    return "both";
  }
  if (tools) {
    return "tools";
  }
  return functions ? "functions" : "none";
}

/** What is read from the content of one message. */
interface ReadContent {
  /** The text parts joined without a separator. */
  text: string;
  /** The parts that are not text, in order. Empty when there are none. */
  attachments: Attachment[];
  /** The bytes of the saved parts, with their file names. */
  parts: PartFileData[];
}

function textOnly(text: string): ReadContent {
  return { text, attachments: [], parts: [] };
}

/** The kinds of a part that is saved or shown by its kind. */
type MediaKind = "image" | "audio" | "file";

/**
 * What one part that is not text turns out to be. The shapes are the rows of the table of parts
 * that can and cannot be read.
 */
type PartReading =
  | { state: "saved"; kind: MediaKind; content: DataUrlContent }
  | { state: "unreadable"; kind: MediaKind }
  | { state: "address"; address: string }
  | { state: "fileId"; fileId: string }
  | { state: "kindOnly" }
  | { state: "other"; typeName: string };

const unreadable = (kind: MediaKind): PartReading => ({ state: "unreadable", kind });

/** A data URL part: saved when it can be read, unreadable when it cannot. */
function savedOrUnreadable(kind: MediaKind, url: string): PartReading {
  const content = readDataUrl(url);
  return content === undefined ? unreadable(kind) : { state: "saved", kind, content };
}

function readImage(part: Record<string, unknown>): PartReading {
  const inner = part.image_url;
  const url = isRecord(inner) ? inner.url : undefined;
  if (typeof url !== "string" || url === "") {
    return unreadable("image");
  }
  return isDataUrl(url) ? savedOrUnreadable("image", url) : { state: "address", address: url };
}

function readAudio(part: Record<string, unknown>): PartReading {
  const inner = part.input_audio;
  if (!isRecord(inner) || typeof inner.data !== "string") {
    return unreadable("audio");
  }
  const bytes = readBase64(inner.data);
  if (bytes === undefined) {
    return unreadable("audio");
  }
  return {
    state: "saved",
    kind: "audio",
    content: { mediaType: audioMediaType(inner.format), bytes },
  };
}

function readFile(part: Record<string, unknown>): PartReading {
  const inner = part.file;
  if (!isRecord(inner)) {
    return unreadable("file");
  }
  const data = inner.file_data;
  if (data === undefined || data === null) {
    return typeof inner.file_id === "string"
      ? { state: "fileId", fileId: inner.file_id }
      : { state: "kindOnly" };
  }
  return typeof data === "string" && isDataUrl(data)
    ? savedOrUnreadable("file", data)
    : unreadable("file");
}

/**
 * Reads one part of an array content that is not text. Each part is read once, so a data URL is
 * decoded once per request.
 */
function readNonTextPart(part: Record<string, unknown>, type: string): PartReading {
  switch (type) {
    case "image_url":
      return readImage(part);
    case "input_audio":
      return readAudio(part);
    case "file":
      return readFile(part);
    default:
      return { state: "other", typeName: type };
  }
}

/** The attachment fields that a part without data has: all null. */
const NO_VALUES = {
  mediaType: null,
  size: null,
  file: null,
  address: null,
  fileId: null,
  typeName: null,
} as const;

/** The attachment for a part that is not text, placed after `at` characters of text. */
function attachmentOf(reading: PartReading, at: number, file: string | null): Attachment {
  const base = { at, readable: true, ...NO_VALUES };
  switch (reading.state) {
    case "saved":
      return {
        ...base,
        kind: reading.kind,
        mediaType: reading.content.mediaType,
        size: reading.content.bytes.length,
        file,
      };
    case "unreadable":
      return { ...base, kind: reading.kind, readable: false };
    case "address":
      return { ...base, kind: "image", address: reading.address };
    case "fileId":
      return { ...base, kind: "file", fileId: reading.fileId };
    case "kindOnly":
      return { ...base, kind: "file" };
    default:
      return { ...base, kind: "other", typeName: reading.typeName };
  }
}

/**
 * The text and the parts of an array content. A text part adds to the text. Every other part
 * becomes an attachment placed after the characters of text before it. The bytes of a part with a
 * readable body are saved under a name made from the message and part numbers. Undefined means a
 * part is not an object, has no string `type`, or is a text part without a string `text`.
 */
function readParts(content: unknown[], messageNumber: number): ReadContent | undefined {
  const read: ReadContent = { text: "", attachments: [], parts: [] };
  let characters = 0;
  for (const [index, part] of content.entries()) {
    if (!isRecord(part) || typeof part.type !== "string") {
      return undefined;
    }
    if (part.type === "text") {
      if (typeof part.text !== "string") {
        return undefined;
      }
      read.text += part.text;
      characters += characterCount(part.text);
      continue;
    }
    const reading = readNonTextPart(part, part.type);
    const file =
      reading.state === "saved"
        ? savedFileName(messageNumber, index + 1, reading.content.mediaType)
        : null;
    read.attachments.push(attachmentOf(reading, characters, file));
    if (reading.state === "saved" && file !== null) {
      read.parts.push({ file, bytes: reading.content.bytes });
    }
  }
  return read;
}

/**
 * The content of a message: a string as it is, null as "", an array by `readParts`. Anything else
 * gives undefined.
 */
function readContent(content: unknown, messageNumber: number): ReadContent | undefined {
  if (typeof content === "string") {
    return textOnly(content);
  }
  if (content === null) {
    return textOnly("");
  }
  return Array.isArray(content) ? readParts(content, messageNumber) : undefined;
}

/** The content of a message; a missing content is "" only for an assistant message with tool calls. */
function messageContent(
  message: Record<string, unknown>,
  messageNumber: number,
): ReadContent | undefined {
  if (message.content === undefined && mayLeaveOutContent(message)) {
    return textOnly("");
  }
  return readContent(message.content, messageNumber);
}

type MessageResult = { message: Message; parts: PartFileData[] } | { error: Failure };

/**
 * Checks one message in order: object, the checks of MESSAGE_CHECKS, then
 * content. The role, the text content and the tool fields are kept.
 */
function convertMessage(item: unknown, messageNumber: number): MessageResult {
  if (!isRecord(item)) {
    return { error: invalid(MESSAGES.messageNotObject) };
  }
  const failure = firstError(MESSAGE_CHECKS, item);
  if (failure !== undefined) {
    return { error: failure };
  }
  const read = messageContent(item, messageNumber);
  if (read === undefined) {
    return { error: invalid(MESSAGES.contentType) };
  }
  const message: Message = { role: item.role as Role, content: read.text, ...pickToolFields(item) };
  if (read.attachments.length > 0) {
    message.attachments = read.attachments;
  }
  return { message, parts: read.parts };
}

/** Checks the messages one by one and stops at the first one that fails. */
function convertMessages(
  items: unknown[],
): { messages: Message[]; parts: PartFileData[] } | { error: Failure } {
  const messages: Message[] = [];
  const parts: PartFileData[] = [];
  for (const [index, item] of items.entries()) {
    const converted = convertMessage(item, index + 1);
    if ("error" in converted) {
      return converted;
    }
    messages.push(converted.message);
    // Not push(...), whose arguments would overflow the stack for a very large number of parts.
    for (const part of converted.parts) {
      parts.push(part);
    }
  }
  return { messages, parts };
}

/** The reply kind and the required shape of a request, from `response_format`. */
function readResponseFormat(body: Record<string, unknown>): {
  replyKind: ReplyKind;
  requiredShape: Record<string, unknown> | null;
} {
  const format = body.response_format;
  if (!isRecord(format)) {
    return { replyKind: "text", requiredShape: null };
  }
  if (format.type === "json_object") {
    return { replyKind: "json", requiredShape: null };
  }
  if (format.type !== "json_schema") {
    return { replyKind: "text", requiredShape: null };
  }
  const wrapper = format.json_schema;
  if (!isRecord(wrapper)) {
    return { replyKind: "json", requiredShape: null };
  }
  if (wrapper.schema === undefined) {
    return { replyKind: "json", requiredShape: wrapper };
  }
  return { replyKind: "json", requiredShape: isRecord(wrapper.schema) ? wrapper.schema : null };
}

/** `stream` and `stream_options.include_usage`; only the value true counts. */
function readStreaming(body: Record<string, unknown>): { stream: boolean; includeUsage: boolean } {
  const stream = body.stream === true;
  const options = body.stream_options;
  return {
    stream,
    includeUsage: stream && isRecord(options) && options.include_usage === true,
  };
}

/**
 * Checks a request body in this order: JSON object, messages, model, each message, n. The first
 * failure decides. Unknown fields are ignored, and so are `tool_choice` and
 * `parallel_tool_calls`. The entries of `tools` and `functions` are not checked.
 */
export function parseChatCompletionsRequest(text: string): AdapterResult {
  const body = parseObject(text);
  if (body === undefined) {
    return reject(invalid(MESSAGES.invalidJson));
  }
  const bodyError = firstError(BODY_CHECKS, body);
  if (bodyError !== undefined) {
    return reject(bodyError);
  }
  const converted = convertMessages(body.messages as unknown[]);
  if ("error" in converted) {
    return reject(converted.error);
  }
  if (typeof body.n === "number" && body.n >= 2) {
    return reject(invalid(MESSAGES.tooManyChoices));
  }
  return {
    ok: true,
    request: {
      format: "chat.completions",
      model: body.model as string,
      ...readResponseFormat(body),
      ...readStreaming(body),
      conversation: converted.messages,
      originalRequest: body,
      toolDefinitions: readToolDefinitions(body),
    },
    parts: converted.parts,
  };
}

export interface CompletionInput {
  requestId: string;
  model: string;
  /** The reply as typed. It is the content of the response when `reply` is text or missing. */
  content: string;
  nowSeconds: number;
  /** What the reply is. Missing means text. */
  reply?: ToolReply;
}

/** The message and the finish reason of a response for this reply. */
function messageOf(input: CompletionInput): {
  message: CompletionMessage;
  finish: FinishReason;
} {
  const reply = input.reply;
  if (reply?.kind === "tool_calls") {
    const calls = reply.calls.map((call) => call.raw);
    return {
      message: { role: "assistant", content: null, tool_calls: calls },
      finish: "tool_calls",
    };
  }
  if (reply?.kind === "function_call") {
    const call = { name: reply.name, arguments: reply.arguments };
    return {
      message: { role: "assistant", content: null, function_call: call },
      finish: "function_call",
    };
  }
  return {
    message: { role: "assistant", content: input.content },
    finish: "stop",
  };
}

/** The response for a human reply. Usage is always zero. */
export function buildCompletion(input: CompletionInput): ChatCompletion {
  const { message, finish } = messageOf(input);
  return {
    id: `chatcmpl-${input.requestId}`,
    object: "chat.completion",
    created: input.nowSeconds,
    model: input.model,
    choices: [{ index: 0, message, finish_reason: finish }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export interface StreamInput extends CompletionInput {
  /** Whether to add the final usage chunk. */
  includeUsage: boolean;
}

type StreamChoice = {
  index: 0;
  delta: Record<string, unknown>;
  finish_reason: FinishReason | null;
};

interface StreamChunk {
  id: string;
  object: "chat.completion.chunk";
  created: number;
  model: string;
  choices: StreamChoice[];
  usage?: ChatCompletion["usage"];
}

/** One server-sent event: a line of JSON and a blank line. */
function event(chunk: StreamChunk): string {
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * The deltas between the role chunk and the last chunk. A text reply is one content chunk. Tool
 * calls are one chunk per call, with only the fields a client reads. A function call is one
 * chunk.
 */
function bodyDeltas(input: CompletionInput): Record<string, unknown>[] {
  const reply = input.reply;
  if (reply?.kind === "tool_calls") {
    return reply.calls.map((call, index) => ({
      tool_calls: [
        {
          index,
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: call.arguments },
        },
      ],
    }));
  }
  if (reply?.kind === "function_call") {
    return [{ function_call: { name: reply.name, arguments: reply.arguments } }];
  }
  return [{ content: input.content }];
}

/**
 * The events of a streamed response, in order: the role, the whole reply (one content chunk, one
 * chunk per tool call, or one function call chunk), the last chunk with the finish reason, the
 * usage chunk when asked, and `[DONE]`. Every chunk has the same id, created and model.
 */
export function buildStreamEvents(input: StreamInput): string[] {
  const base = {
    id: `chatcmpl-${input.requestId}`,
    object: "chat.completion.chunk",
    created: input.nowSeconds,
    model: input.model,
  } as const;
  const choice = (delta: Record<string, unknown>, finish: FinishReason | null): StreamChoice[] => [
    { index: 0, delta, finish_reason: finish },
  ];
  const isText = input.reply === undefined || input.reply.kind === "text";
  const chunks: StreamChunk[] = [
    {
      ...base,
      choices: choice({ role: "assistant", content: isText ? "" : null }, null),
    },
    ...bodyDeltas(input).map((delta) => ({
      ...base,
      choices: choice(delta, null),
    })),
    { ...base, choices: choice({}, messageOf(input).finish) },
  ];
  if (input.includeUsage) {
    chunks.push({
      ...base,
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  }
  return [...chunks.map(event), "data: [DONE]\n\n"];
}

/** The body of GET /v1/models. */
export interface ModelList {
  object: "list";
  data: { id: string; object: "model"; created: number; owned_by: string }[];
}

/** The one model of this server. The time is fixed, so the answer does not depend on the clock. */
const MODEL_ID = "imbehind";
const MODEL_CREATED = 1791800000;

/** The list of models: always the single model `imbehind`. */
export function buildModelList(): ModelList {
  return {
    object: "list",
    data: [{ id: MODEL_ID, object: "model", created: MODEL_CREATED, owned_by: MODEL_ID }],
  };
}

/** The message of the 504 answer. The limit is the number of seconds the server waited. */
export function replyTimeoutMessage(limitSeconds: number): string {
  return `No reply within ${limitSeconds} seconds. Increase the server timeout or reply sooner.`;
}

/**
 * The message of the 502 answer for a reply file that is not valid. The reason is
 * one of the fixed phrases of the check, so no character of the reply file reaches the client.
 */
export function invalidReplyMessage(reason: string): string {
  return `The reply file was invalid: ${reason}.`;
}

/** The codes of the answers with status 500 and above. All others are the client's mistakes. */
const SERVER_ERROR_CODES: readonly ErrorCode[] = [
  "storage_error",
  "skipped_by_human",
  "reply_timeout",
  "invalid_reply",
];

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  const type = SERVER_ERROR_CODES.includes(code) ? "server_error" : "invalid_request_error";
  return { error: { message, type, code } };
}
