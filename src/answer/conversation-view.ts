/**
 * How the conversation of a request is shown on the answer screen:
 * which messages are shown, how control characters are made visible, and how long a message may
 * be. These are pure functions; they write nothing.
 */
import type { Message, Role } from "../model.js";

/** Every sentence of the conversation view, in one place. */
const TEXT = {
  empty: "(empty)",
  toolCall: "tool_call",
  functionCall: "function_call",
  unreadableCall: "(unreadable tool call)",
  unnamed: "(unnamed)",
  earlierMessages: (count: number, path: string) =>
    `(${count} earlier ${count === 1 ? "message" : "messages"} omitted. Full conversation: ${path})`,
  moreLines: (count: number, path: string) =>
    `(${count} more ${count === 1 ? "line" : "lines"} omitted. Full conversation: ${path})`,
} as const;

const ROLE_LABELS: Readonly<Record<Role, string>> = {
  system: "System",
  developer: "Developer",
  user: "User",
  assistant: "Assistant",
  tool: "Tool",
  function: "Function",
};

/** Roles whose messages are always shown. */
const ALWAYS_SHOWN: readonly Role[] = ["system", "developer"];

/** How many of the other messages are shown, counted from the end. */
const SHOWN_OTHER_MESSAGES = 3;

/** The most lines of one message that are shown. */
const MAX_LINES = 200;

/** The most characters of Unicode of the arguments of a call that are shown. */
const MAX_ARGUMENT_CHARACTERS = 80;

const INDENT = "  ";

/** One thing on the screen: the note about left-out messages, or one message. */
export type ViewEntry =
  | { kind: "omission"; count: number }
  | { kind: "message"; role: Role; lines: string[]; hiddenLines: number };

function isControl(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

function hexEscape(code: number): string {
  return `\\x${code.toString(16).padStart(2, "0")}`;
}

/** Replaces the characters for which `replace` says yes with `\x` and two hex digits. */
function escapeWhere(text: string, replace: (code: number) => boolean): string {
  let result = "";
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    result += replace(code) ? hexEscape(code) : text[index];
  }
  return result;
}

/**
 * Makes control characters visible in a text of several lines. Newline and tab
 * stay. A carriage return before a newline is dropped; any other one is replaced.
 */
export function escapeControls(text: string): string {
  return escapeWhere(
    text.replaceAll("\r\n", "\n"),
    (code) => isControl(code) && code !== 0x0a && code !== 0x09,
  );
}

/** Makes every control character visible, newline and tab too, for a value shown on one line. */
export function escapeAllControls(text: string): string {
  return escapeWhere(text, (code) => isControl(code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The first `MAX_ARGUMENT_CHARACTERS` characters of Unicode, and `...` when something was cut. */
function summarize(text: string): string {
  // Reads one code point more than is shown, and stops there, so the cost does not grow with
  // the length of the text.
  let shown = "";
  let count = 0;
  for (const character of text) {
    if (count === MAX_ARGUMENT_CHARACTERS) {
      return `${shown}...`;
    }
    shown += character;
    count += 1;
  }
  return text;
}

/** The arguments as text: a string as it is, nothing as "", any other value as its JSON. */
function argumentsText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return value === undefined ? "" : (JSON.stringify(value) ?? "");
}

/** One line for a call: its name and the summary of its arguments, on one line. */
function callLine(label: string, call: unknown): string {
  if (!isRecord(call) || typeof call.name !== "string") {
    return `${label}: ${TEXT.unreadableCall}`;
  }
  const summary = summarize(argumentsText(call.arguments));
  return `${label}: ${escapeAllControls(call.name)}(${escapeAllControls(summary)})`;
}

/** The function of one element of `tool_calls`, if it is an object that has one. */
function functionOf(element: unknown): unknown {
  return isRecord(element) ? element.function : undefined;
}

/**
 * The lines for the calls of an assistant message: one for each element of `tool_calls`, and one
 * for `function_call`. A `tool_calls` that is not an array is one unreadable element. Null and an
 * empty list are no calls.
 */
function callLines(message: Message): string[] {
  const { tool_calls: calls, function_call: legacy } = message;
  const lines: string[] = [];
  if (Array.isArray(calls)) {
    lines.push(...calls.map((call) => callLine(TEXT.toolCall, functionOf(call))));
  } else if (calls !== undefined && calls !== null) {
    lines.push(`${TEXT.toolCall}: ${TEXT.unreadableCall}`);
  }
  if (legacy !== undefined && legacy !== null) {
    lines.push(callLine(TEXT.functionCall, legacy));
  }
  return lines;
}

/** The lines of one message after the escape, cut to the first `MAX_LINES`. */
function messageEntry(message: Message): ViewEntry {
  const calls = callLines(message);
  if (message.content === "" && calls.length === 0) {
    return { kind: "message", role: message.role, lines: [TEXT.empty], hiddenLines: 0 };
  }
  const text = message.content === "" ? [] : escapeControls(message.content).split("\n");
  const all = [...text, ...calls];
  return {
    kind: "message",
    role: message.role,
    lines: all.slice(0, MAX_LINES),
    hiddenLines: Math.max(0, all.length - MAX_LINES),
  };
}

/** Whether the message at each position is left out. */
function omittedFlags(conversation: readonly Message[]): boolean[] {
  const others = conversation.filter((message) => !ALWAYS_SHOWN.includes(message.role)).length;
  let toOmit = Math.max(0, others - SHOWN_OTHER_MESSAGES);
  return conversation.map((message) => {
    if (ALWAYS_SHOWN.includes(message.role) || toOmit === 0) {
      return false;
    }
    toOmit -= 1;
    return true;
  });
}

/**
 * The entries to show, in the order of the conversation. Left-out messages become one `omission`
 * entry, at the place of the first of them.
 */
export function buildConversationView(conversation: readonly Message[]): ViewEntry[] {
  const flags = omittedFlags(conversation);
  const entries: ViewEntry[] = [];
  let omission: { kind: "omission"; count: number } | undefined;
  conversation.forEach((message, index) => {
    if (!flags[index]) {
      entries.push(messageEntry(message));
    } else if (omission === undefined) {
      omission = { kind: "omission", count: 1 };
      entries.push(omission);
    } else {
      omission.count += 1;
    }
  });
  return entries;
}

function entryLines(entry: ViewEntry, path: string): string[] {
  if (entry.kind === "omission") {
    return [TEXT.earlierMessages(entry.count, path), ""];
  }
  const body = entry.lines.map((line) => (line === "" ? "" : `${INDENT}${line}`));
  const more = entry.hiddenLines > 0 ? [`${INDENT}${TEXT.moreLines(entry.hiddenLines, path)}`] : [];
  return [`${ROLE_LABELS[entry.role]}:`, ...body, ...more, ""];
}

/** The name of a definition, or "(unnamed)". `named` picks the object that holds the name. */
function definitionName(entry: unknown, named: (entry: unknown) => unknown): string {
  const name = named(entry);
  return typeof name === "string" && name !== "" ? escapeAllControls(name) : TEXT.unnamed;
}

/** The names of the definitions in `value`, or nothing when it is not a non-empty array. */
function listLine(label: string, value: unknown, named: (entry: unknown) => unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    return [];
  }
  return [`${label}: ${value.map((entry) => definitionName(entry, named)).join(", ")}`];
}

/**
 * The lines that list the names of `tools` and `functions` of the original request. An empty,
 * missing or non-array list gives no line.
 */
export function toolListLines(original: Record<string, unknown>): string[] {
  return [
    ...listLine("Tools", original.tools, (entry) => {
      const fn = functionOf(entry);
      return isRecord(fn) ? fn.name : undefined;
    }),
    ...listLine("Functions", original.functions, (entry) =>
      isRecord(entry) ? entry.name : undefined,
    ),
  ];
}

/** The lines of the conversation as shown, each message followed by an empty line. */
export function conversationLines(conversation: readonly Message[], path: string): string[] {
  return buildConversationView(conversation).flatMap((entry) => entryLines(entry, path));
}
