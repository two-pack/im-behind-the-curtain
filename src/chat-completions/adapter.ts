/**
 * The Chat Completions adapter: checks a request body, turns it into the shared
 * conversation form, and builds the response and error bodies.
 * It has no side effects and calls no other module.
 */
import {
  type ConversationRequest,
  type Message,
  type ReplyKind,
  ROLES,
  type Role,
} from "../model.js";

export type ErrorCode =
  | "invalid_request"
  | "unsupported_content"
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
  contentType: "Message content must be a string, null, or an array of text parts.",
  images: "Images are not supported. A human reads requests as text.",
  tools: "Tool calls are not supported. Send the request without tools.",
  tooManyChoices: 'Only one choice can be returned; "n" must be 1.',
  requestTooLarge: "Request body is larger than 10 MB.",
  notFound: "Not found.",
  methodNotAllowed: "Method not allowed.",
  storage: "The request could not be stored.",
  skipped: "The human skipped this request.",
  crossOrigin: "Cross-origin requests are not accepted.",
  unexpectedHost: "Unexpected Host header.",
} as const;

/** Longest piece of a role name or content part type that is put into an error message. */
const MAX_ROLE_LENGTH = 64;

/** Why a request is turned away: a malformed one, or one that asks for something not supported. */
interface Failure {
  code: "invalid_request" | "unsupported_content";
  message: string;
}

interface RequestRejection extends Failure {
  status: 400;
}

export type AdapterResult =
  | { ok: true; request: ConversationRequest }
  | { ok: false; rejection: RequestRejection };

export interface ErrorBody {
  error: {
    message: string;
    type: "invalid_request_error" | "server_error";
    code: ErrorCode;
  };
}

export interface ChatCompletion {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: [
    {
      index: 0;
      message: { role: "assistant"; content: string };
      finish_reason: "stop";
    },
  ];
  usage: { prompt_tokens: 0; completion_tokens: 0; total_tokens: 0 };
}

function invalid(message: string): Failure {
  return { code: "invalid_request", message };
}

function unsupported(message: string): Failure {
  return { code: "unsupported_content", message };
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

/** A message with the role tool or function. Its content is not read. */
function checkToolRole(message: Record<string, unknown>): Failure | undefined {
  return message.role === "tool" || message.role === "function"
    ? unsupported(MESSAGES.tools)
    : undefined;
}

/** A role that is none of the four. */
function checkRole(message: Record<string, unknown>): Failure | undefined {
  return isRole(message.role) ? undefined : invalid(roleMessage(message.role));
}

/** An assistant message that calls a tool. Other roles are not looked at. */
function checkToolCalls(message: Record<string, unknown>): Failure | undefined {
  if (message.role !== "assistant") {
    return undefined;
  }
  const calls = hasEntries(message.tool_calls);
  const legacy = message.function_call !== null && message.function_call !== undefined;
  return calls || legacy ? unsupported(MESSAGES.tools) : undefined;
}

/** Any part of the content that is an image. */
function checkImageParts(message: Record<string, unknown>): Failure | undefined {
  const content = message.content;
  const hasImage =
    Array.isArray(content) && content.some((part) => isRecord(part) && part.type === "image_url");
  return hasImage ? unsupported(MESSAGES.images) : undefined;
}

function partTypeMessage(type: string): string {
  return `Unsupported content part type: "${type.slice(0, MAX_ROLE_LENGTH)}".`;
}

/** The first part whose type is a string other than text or image_url. */
function checkOtherParts(message: Record<string, unknown>): Failure | undefined {
  const content = message.content;
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const part of content) {
    if (isRecord(part) && typeof part.type === "string" && part.type !== "text") {
      return unsupported(partTypeMessage(part.type));
    }
  }
  return undefined;
}

/** Checks on one message before its content is read, in order. */
const MESSAGE_CHECKS: readonly Check<Record<string, unknown>>[] = [
  checkToolRole,
  checkRole,
  checkToolCalls,
  checkImageParts,
  checkOtherParts,
];

/** Tools or functions with at least one definition. */
function checkToolDefinitions(body: Record<string, unknown>): Failure | undefined {
  return hasEntries(body.tools) || hasEntries(body.functions)
    ? unsupported(MESSAGES.tools)
    : undefined;
}

function textOfPart(part: unknown): string | undefined {
  return isRecord(part) && part.type === "text" && typeof part.text === "string"
    ? part.text
    : undefined;
}

/**
 * The text of a message content: a string as it is, null as "", an array of text
 * parts joined without a separator. Anything else gives undefined.
 */
function readContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (content === null) {
    return "";
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  const texts = content.map(textOfPart);
  return texts.every((text) => text !== undefined) ? texts.join("") : undefined;
}

type MessageResult = { message: Message } | { error: Failure };

/**
 * Checks one message in order: object, the checks of MESSAGE_CHECKS, then
 * content. Only the role and the text content are kept.
 */
function convertMessage(item: unknown): MessageResult {
  if (!isRecord(item)) {
    return { error: invalid(MESSAGES.messageNotObject) };
  }
  const failure = firstError(MESSAGE_CHECKS, item);
  if (failure !== undefined) {
    return { error: failure };
  }
  const content = readContent(item.content);
  if (content === undefined) {
    return { error: invalid(MESSAGES.contentType) };
  }
  return { message: { role: item.role as Role, content } };
}

/** Checks the messages one by one and stops at the first one that fails. */
function convertMessages(items: unknown[]): { messages: Message[] } | { error: Failure } {
  const messages: Message[] = [];
  for (const item of items) {
    const converted = convertMessage(item);
    if ("error" in converted) {
      return converted;
    }
    messages.push(converted.message);
  }
  return { messages };
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
 * Checks a request body in this order: JSON object, messages, model, each message, tools and
 * functions, n. The first failure decides. Unknown fields are ignored.
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
  const toolsError = checkToolDefinitions(body);
  if (toolsError !== undefined) {
    return reject(toolsError);
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
    },
  };
}

export interface CompletionInput {
  requestId: string;
  model: string;
  content: string;
  nowSeconds: number;
}

/** The response for a human reply. Usage is always zero. */
export function buildCompletion(input: CompletionInput): ChatCompletion {
  return {
    id: `chatcmpl-${input.requestId}`,
    object: "chat.completion",
    created: input.nowSeconds,
    model: input.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: input.content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export interface StreamInput extends CompletionInput {
  /** Whether to add the final usage chunk. */
  includeUsage: boolean;
}

type StreamChoice = { index: 0; delta: Record<string, unknown>; finish_reason: "stop" | null };

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
 * The events of a streamed response, in order: the role, the whole reply in one
 * content chunk, stop, the usage chunk when asked, and `[DONE]`. Every chunk has the same id,
 * created and model.
 */
export function buildStreamEvents(input: StreamInput): string[] {
  const base = {
    id: `chatcmpl-${input.requestId}`,
    object: "chat.completion.chunk",
    created: input.nowSeconds,
    model: input.model,
  } as const;
  const choice = (delta: Record<string, unknown>, finish: "stop" | null): StreamChoice[] => [
    { index: 0, delta, finish_reason: finish },
  ];
  const chunks: StreamChunk[] = [
    { ...base, choices: choice({ role: "assistant", content: "" }, null) },
    { ...base, choices: choice({ content: input.content }, null) },
    { ...base, choices: choice({}, "stop") },
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
