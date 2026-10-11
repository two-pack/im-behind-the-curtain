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
  | "request_too_large"
  | "not_found"
  | "method_not_allowed"
  | "storage_error";

/** The fixed English sentences of this API. A request value is never copied into them. */
export const MESSAGES = {
  invalidJson: "Request body is not valid JSON.",
  messagesRequired: '"messages" must be a non-empty array.',
  modelRequired: '"model" must be a string.',
  messageNotObject: "Each message must be an object.",
  contentType: "Message content must be a string, null, or an array of text parts.",
  tooManyChoices: 'Only one choice can be returned; "n" must be 1.',
  requestTooLarge: "Request body is larger than 10 MB.",
  notFound: "Not found.",
  methodNotAllowed: "Method not allowed.",
  storage: "The request could not be stored.",
  crossOrigin: "Cross-origin requests are not accepted.",
  unexpectedHost: "Unexpected Host header.",
} as const;

/** Longest piece of a role name that is put into an error message. */
const MAX_ROLE_LENGTH = 64;

interface RequestRejection {
  status: 400;
  code: "invalid_request";
  message: string;
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

function reject(message: string): AdapterResult {
  return { ok: false, rejection: { status: 400, code: "invalid_request", message } };
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

/** A check returns the error message when it fails, and undefined when it passes. */
type Check<T> = (value: T) => string | undefined;

/** Checks on the whole body, in order. */
const BODY_CHECKS: readonly Check<Record<string, unknown>>[] = [
  (body) =>
    Array.isArray(body.messages) && body.messages.length > 0
      ? undefined
      : MESSAGES.messagesRequired,
  (body) => (typeof body.model === "string" ? undefined : MESSAGES.modelRequired),
];

/** Runs the checks in order and returns the first error. */
function firstError<T>(checks: readonly Check<T>[], value: T): string | undefined {
  for (const check of checks) {
    const error = check(value);
    if (error !== undefined) {
      return error;
    }
  }
  return undefined;
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

type MessageResult = { message: Message } | { error: string };

/** Checks one message in the order object, role, content, keeping only those two. */
function convertMessage(item: unknown): MessageResult {
  if (!isRecord(item)) {
    return { error: MESSAGES.messageNotObject };
  }
  if (!isRole(item.role)) {
    return { error: roleMessage(item.role) };
  }
  const content = readContent(item.content);
  if (content === undefined) {
    return { error: MESSAGES.contentType };
  }
  return { message: { role: item.role, content } };
}

/** Checks the messages one by one and stops at the first one that fails. */
function convertMessages(items: unknown[]): { messages: Message[] } | { error: string } {
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
 * Checks a request body in order:
 * JSON object, messages, model, each message, n. The first failure decides. Unknown fields are
 * ignored.
 */
export function parseChatCompletionsRequest(text: string): AdapterResult {
  const body = parseObject(text);
  if (body === undefined) {
    return reject(MESSAGES.invalidJson);
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
    return reject(MESSAGES.tooManyChoices);
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

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  const type = code === "storage_error" ? "server_error" : "invalid_request_error";
  return { error: { message, type, code } };
}
