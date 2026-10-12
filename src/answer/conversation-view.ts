/**
 * How the conversation of a request is shown on the answer screen:
 * which messages are shown, how control characters are made visible, and how long a message may
 * be. These are pure functions; they write nothing.
 */
import type { Message, Role } from "../model.js";

/** Every sentence of the conversation view, in one place. */
const TEXT = {
  empty: "(empty)",
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
};

/** Roles whose messages are always shown. */
const ALWAYS_SHOWN: readonly Role[] = ["system", "developer"];

/** How many of the other messages are shown, counted from the end. */
const SHOWN_OTHER_MESSAGES = 3;

/** The most lines of one message that are shown. */
const MAX_LINES = 200;

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

/** The lines of one message after the escape, cut to the first `MAX_LINES`. */
function messageEntry(message: Message): ViewEntry {
  if (message.content === "") {
    return { kind: "message", role: message.role, lines: [TEXT.empty], hiddenLines: 0 };
  }
  const all = escapeControls(message.content).split("\n");
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

/** The lines of the conversation as shown, each message followed by an empty line. */
export function conversationLines(conversation: readonly Message[], path: string): string[] {
  return buildConversationView(conversation).flatMap((entry) => entryLines(entry, path));
}
