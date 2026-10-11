/**
 * The Chat Completions adapter: checks a request body, turns it into the shared
 * conversation form, and builds the response and error bodies.
 * It has no side effects and calls no other module.
 */
import { type ConversationRequest, type Message, ROLES, type Role } from "../model.js";

export type ErrorCode = "invalid_request" | "not_found" | "method_not_allowed" | "storage_error";

/** The fixed English sentences of this API. A request value is never copied into them. */
export const MESSAGES = {
  invalidJson: "Request body is not valid JSON.",
  messagesRequired: '"messages" must be a non-empty array.',
  modelRequired: '"model" must be a string.',
  messageNotObject: "Each message must be an object.",
  contentType: "Message content must be a string or null in this version.",
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

function roleMessage(item: unknown): string {
  const role = (item as Record<string, unknown>).role;
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

/** Checks on one message, in order: object, role, content. */
const MESSAGE_CHECKS: readonly Check<unknown>[] = [
  (item) => (isRecord(item) ? undefined : MESSAGES.messageNotObject),
  (item) => (isRole((item as Record<string, unknown>).role) ? undefined : roleMessage(item)),
  (item) => {
    const content = (item as Record<string, unknown>).content;
    return typeof content === "string" || content === null ? undefined : MESSAGES.contentType;
  },
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

/** Converts messages that already passed `MESSAGE_CHECKS`. A null content becomes "". */
function toConversation(items: unknown[]): Message[] {
  return items.map((item) => {
    const message = item as { role: Role; content: string | null };
    return { role: message.role, content: message.content ?? "" };
  });
}

/**
 * Checks a request body in orderconverts it.
 * Unknown fields are ignored, and `stream` is read as false in this version.
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
  const items = body.messages as unknown[];
  for (const item of items) {
    const messageError = firstError(MESSAGE_CHECKS, item);
    if (messageError !== undefined) {
      return reject(messageError);
    }
  }
  return {
    ok: true,
    request: {
      format: "chat.completions",
      model: body.model as string,
      replyKind: "text",
      requiredShape: null,
      stream: false,
      includeUsage: false,
      conversation: toConversation(items),
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

export function errorBody(code: ErrorCode, message: string): ErrorBody {
  const type = code === "storage_error" ? "server_error" : "invalid_request_error";
  return { error: { message, type, code } };
}
