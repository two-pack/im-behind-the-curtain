/**
 * How the conversation of a request is shown on the answer screen:
 * which messages are shown, how control characters are made visible, and how long a message may
 * be. These are pure functions; they write nothing.
 */
import nodePath from "node:path";
import { isSavedFileName } from "../media-parts.js";
import { type Attachment, characterCount, type Message, type Role } from "../model.js";

/** Every sentence of the conversation view, in one place. */
const TEXT = {
  empty: "(empty)",
  unreadable: "(unreadable)",
  unknownMediaType: "unknown",
  saved: "saved",
  toolCall: "tool_call",
  functionCall: "function_call",
  unreadableCall: "(unreadable tool call)",
  unnamed: "(unnamed)",
  earlierMessages: (count: number, path: string) =>
    `(${count} earlier ${count === 1 ? "message" : "messages"} omitted. Full conversation: ${path})`,
  moreLines: (count: number, path: string) =>
    `(${count} more ${count === 1 ? "line" : "lines"} omitted. Full conversation: ${path})`,
  cut: (count: number, path: string) =>
    `... (${count} characters in this line. Full conversation: ${path})`,
  fileId: "file_id",
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

/** The most characters of Unicode of one line that are shown, not counting the indent. */
const MAX_LINE_CHARACTERS = 1000;

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
    for (const call of calls) {
      lines.push(callLine(TEXT.toolCall, functionOf(call)));
    }
  } else if (calls !== undefined && calls !== null) {
    lines.push(`${TEXT.toolCall}: ${TEXT.unreadableCall}`);
  }
  if (legacy !== undefined && legacy !== null) {
    lines.push(callLine(TEXT.functionCall, legacy));
  }
  return lines;
}

/** The text of `content` cut at the given positions, counted in Unicode characters. */
function textPieces(content: string, positions: readonly number[]): string[] {
  const pieces: string[] = [];
  let unit = 0;
  let characters = 0;
  let start = 0;
  for (const position of positions) {
    while (characters < position && unit < content.length) {
      unit += (content.codePointAt(unit) ?? 0) > 0xffff ? 2 : 1;
      characters += 1;
    }
    pieces.push(content.slice(start, unit));
    start = unit;
  }
  pieces.push(content.slice(start));
  return pieces;
}

/** The size with its unit: `1 byte`, `0 bytes`, `70 bytes`. */
function sizeText(size: number): string {
  return `${size} ${size === 1 ? "byte" : "bytes"}`;
}

/**
 * Cuts a line that has more than `MAX_LINE_CHARACTERS` characters of Unicode to its first
 * `MAX_LINE_CHARACTERS`, and adds how long the line was and where the whole conversation is. The
 * line is counted as it is shown: control characters are already visible, and the indent is not
 * part of it. A line that is not longer is returned as it is.
 */
function cutLine(line: string, path: string): string {
  // The number of UTF-16 units is at least the number of characters, so a short one is whole.
  if (line.length <= MAX_LINE_CHARACTERS) {
    return line;
  }
  const total = characterCount(line);
  if (total <= MAX_LINE_CHARACTERS) {
    return line;
  }
  let end = 0;
  for (let count = 0; count < MAX_LINE_CHARACTERS; count += 1) {
    end += (line.codePointAt(end) ?? 0) > 0xffff ? 2 : 1;
  }
  return `${line.slice(0, end)}${TEXT.cut(total, path)}`;
}

/** What a part that is not text shows: its first line, and the line of the saved path if it has one. */
interface PartView {
  head: string;
  saved: string | null;
}

/**
 * The lines of a part that is not text. A saved part has two: the kind, the media type and the
 * size, then the absolute path of the file. A part with an address or a file_id has one line. A
 * part that is unreadable, or is saved under a name that does not have the form of a saved name,
 * shows its kind and says it is unreadable, and no path is made from its name. A part of an
 * unknown type shows its type name.
 */
function partView(part: Attachment, requestDir: string): PartView {
  const unreadable = { head: `[${part.kind}] ${TEXT.unreadable}`, saved: null };
  if (part.kind === "other") {
    return { head: `[${escapeAllControls(part.typeName ?? "")}]`, saved: null };
  }
  if (!part.readable) {
    return unreadable;
  }
  if (part.file !== null || part.size !== null) {
    if (part.file === null || part.size === null || !isSavedFileName(part.file)) {
      return unreadable;
    }
    const mediaType = escapeAllControls(part.mediaType || TEXT.unknownMediaType);
    return {
      head: `[${part.kind}] ${mediaType}, ${sizeText(part.size)}`,
      saved: `${INDENT}${TEXT.saved}: ${escapeAllControls(nodePath.join(requestDir, part.file))}`,
    };
  }
  if (part.address !== null) {
    return { head: `[${part.kind}] ${escapeAllControls(part.address)}`, saved: null };
  }
  if (part.fileId !== null) {
    return {
      head: `[${part.kind}] ${TEXT.fileId}: ${escapeAllControls(part.fileId)}`,
      saved: null,
    };
  }
  return { head: `[${part.kind}]`, saved: null };
}

/**
 * The text and the parts of a message, in the order they arrived, as lines. Every line but the
 * saved path is cut to `MAX_LINE_CHARACTERS`.
 */
function bodyLines(message: Message, requestDir: string, path: string): string[] {
  const parts = message.attachments ?? [];
  const pieces = textPieces(
    message.content,
    parts.map((part) => part.at),
  );
  const lines: string[] = [];
  pieces.forEach((piece, index) => {
    if (piece !== "") {
      // Not push(...): the arguments would overflow the stack for a text of many newlines.
      for (const line of escapeControls(piece).split("\n")) {
        lines.push(cutLine(line, path));
      }
    }
    const part = parts[index];
    if (part !== undefined) {
      const view = partView(part, requestDir);
      lines.push(cutLine(view.head, path));
      if (view.saved !== null) {
        lines.push(view.saved);
      }
    }
  });
  return lines;
}

/** The lines of one message after the escape and the cut, limited to the first `MAX_LINES`. */
function messageEntry(message: Message, requestDir: string, path: string): ViewEntry {
  const calls = callLines(message).map((line) => cutLine(line, path));
  const body = bodyLines(message, requestDir, path);
  if (body.length === 0 && calls.length === 0) {
    return { kind: "message", role: message.role, lines: [TEXT.empty], hiddenLines: 0 };
  }
  const all = [...body, ...calls];
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
 * entry, at the place of the first of them. `path` is where request.json is; a cut line points
 * to it.
 */
export function buildConversationView(
  conversation: readonly Message[],
  requestDir: string,
  path: string,
): ViewEntry[] {
  const flags = omittedFlags(conversation);
  const entries: ViewEntry[] = [];
  let omission: { kind: "omission"; count: number } | undefined;
  conversation.forEach((message, index) => {
    if (!flags[index]) {
      entries.push(messageEntry(message, requestDir, path));
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

/**
 * The lines of the conversation as shown, each message followed by an empty line. `path` is
 * where request.json is; `requestDir` is the absolute path of the request folder, where the
 * saved parts are.
 */
export function conversationLines(
  conversation: readonly Message[],
  path: string,
  requestDir: string,
): string[] {
  return buildConversationView(conversation, requestDir, path).flatMap((entry) =>
    entryLines(entry, path),
  );
}
