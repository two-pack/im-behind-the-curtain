import { describe, expect, it } from "vitest";
import {
  buildConversationView,
  conversationLines,
  escapeAllControls,
  escapeControls,
} from "../src/answer/conversation-view.js";
import type { Message, Role } from "../src/model.js";

const PATH = "/data/requests/20261009T140512123Z-a1b2c3/request.json";

function message(role: Role, content: string): Message {
  return { role, content };
}

/** A conversation of `count` messages with the given role, named `<role> 1`, `<role> 2`, ... */
function many(role: Role, count: number): Message[] {
  return Array.from({ length: count }, (_, index) => message(role, `${role} ${index + 1}`));
}

function shownContents(conversation: Message[]): string[] {
  return buildConversationView(conversation).flatMap((entry) =>
    entry.kind === "message" ? entry.lines : [],
  );
}

describe("choosing the messages to show", () => {
  it("shows every system and developer message and the last three of the others", () => {
    const conversation = [
      message("system", "rules"),
      message("developer", "style"),
      ...many("user", 5),
    ];
    expect(shownContents(conversation)).toEqual(["rules", "style", "user 3", "user 4", "user 5"]);
  });

  it("shows everything, with no omission, for exactly three other messages", () => {
    const entries = buildConversationView([message("system", "rules"), ...many("user", 3)]);
    expect(entries.map((entry) => entry.kind)).toEqual([
      "message",
      "message",
      "message",
      "message",
    ]);
  });

  it("omits one message for four other messages", () => {
    const entries = buildConversationView(many("user", 4));
    expect(entries.map((entry) => entry.kind)).toEqual([
      "omission",
      "message",
      "message",
      "message",
    ]);
    expect(entries[0]).toEqual({ kind: "omission", count: 1 });
  });

  it("shows four messages of mixed user and assistant roles in full when none is omitted", () => {
    const conversation = [
      message("system", "a"),
      message("user", "b"),
      message("assistant", "c"),
      message("user", "d"),
    ];
    expect(shownContents(conversation)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("the line that says messages were omitted", () => {
  it("is one line at the place of the first omitted message, with blank lines around it", () => {
    const conversation = [message("system", "rules"), ...many("user", 6)];
    expect(conversationLines(conversation, PATH)).toEqual([
      "System:",
      "  rules",
      "",
      `(3 earlier messages omitted. Full conversation: ${PATH})`,
      "",
      "User:",
      "  user 4",
      "",
      "User:",
      "  user 5",
      "",
      "User:",
      "  user 6",
      "",
    ]);
  });

  it("says message in the singular for one omitted message", () => {
    const lines = conversationLines(many("assistant", 4), PATH);
    expect(lines[0]).toBe(`(1 earlier message omitted. Full conversation: ${PATH})`);
  });

  it("is a single line even when a developer message sits between the omitted ones", () => {
    const conversation = [
      message("user", "u1"),
      message("developer", "d1"),
      message("user", "u2"),
      message("user", "u3"),
      message("user", "u4"),
      message("user", "u5"),
    ];
    const lines = conversationLines(conversation, PATH);
    const notices = lines.filter((line) => line.includes("earlier message"));
    expect(notices).toEqual([`(2 earlier messages omitted. Full conversation: ${PATH})`]);
    expect(lines.indexOf(notices[0] as string)).toBeLessThan(lines.indexOf("Developer:"));
    expect(lines).not.toContain("  u1");
    expect(lines).not.toContain("  u2");
    expect(lines).toContain("  u3");
  });

  it("does not appear when nothing is omitted", () => {
    const lines = conversationLines(many("user", 3), PATH);
    expect(lines.some((line) => line.includes("omitted"))).toBe(false);
  });
});

describe("an empty message", () => {
  it("shows (empty), and keeps a message of only spaces as it is", () => {
    expect(conversationLines([message("assistant", "")], PATH)).toEqual([
      "Assistant:",
      "  (empty)",
      "",
    ]);
    expect(conversationLines([message("user", "   ")], PATH)).toEqual(["User:", "     ", ""]);
  });
});

describe("control characters", () => {
  it("replaces escape, bell, delete and the C1 control with \\x and two hex digits", () => {
    expect(escapeControls("\x1b[31mred\x1b[0m\x07\x7f\x9b")).toBe(
      "\\x1b[31mred\\x1b[0m\\x07\\x7f\\x9b",
    );
  });

  it("replaces the whole ranges 0x00-0x08, 0x0b, 0x0c, 0x0e-0x1f and 0x7f-0x9f", () => {
    expect(escapeControls("\x00\x08\x0b\x0c\x0e\x1f\x80\x9f")).toBe(
      "\\x00\\x08\\x0b\\x0c\\x0e\\x1f\\x80\\x9f",
    );
  });

  it("keeps newline, tab, printable characters, 0x7e, 0xa0 and surrogate pairs", () => {
    const text = "a\tb\nc ~ \u{1F600}";
    expect(escapeControls(text)).toBe(text);
  });

  it("drops the carriage return of a CRLF and replaces a lone one", () => {
    expect(escapeControls("a\r\nb")).toBe("a\nb");
    expect(escapeControls("a\rb")).toBe("a\\x0db");
    expect(escapeControls("a\r\rb\r\n")).toBe("a\\x0d\\x0db\n");
  });

  it("leaves no control character in the shown lines", () => {
    const lines = conversationLines([message("user", "x\x1b[31m\x00\x7f\x9by\r")], PATH);
    for (const line of lines) {
      expect([...line].some((char) => char.charCodeAt(0) < 0x20 || char === "\x7f")).toBe(false);
    }
    expect(lines[1]).toBe("  x\\x1b[31m\\x00\\x7f\\x9by\\x0d");
  });

  it("replaces every control character, newline and tab too, for a one-line value", () => {
    expect(escapeAllControls("gpt\n\t\r\x1b4")).toBe("gpt\\x0a\\x09\\x0d\\x1b4");
    expect(escapeAllControls("plain-model:1")).toBe("plain-model:1");
  });
});

describe("the number of lines of one message", () => {
  function lineText(count: number): string {
    return Array.from({ length: count }, (_, index) => `line ${index + 1}`).join("\n");
  }

  it("shows 200 lines in full", () => {
    const lines = conversationLines([message("user", lineText(200))], PATH);
    expect(lines).toHaveLength(1 + 200 + 1);
    expect(lines.some((line) => line.includes("more line"))).toBe(false);
  });

  it("cuts a message of 1000 lines at 200 and says how many were left out", () => {
    const lines = conversationLines([message("user", lineText(1000))], PATH);
    expect(lines).toHaveLength(1 + 200 + 1 + 1);
    expect(lines[200]).toBe("  line 200");
    expect(lines[201]).toBe(`  (800 more lines omitted. Full conversation: ${PATH})`);
    expect(lines[202]).toBe("");
  });

  it("says line in the singular when one line is left out", () => {
    const lines = conversationLines([message("user", lineText(201))], PATH);
    expect(lines[201]).toBe(`  (1 more line omitted. Full conversation: ${PATH})`);
  });

  it("counts the empty line after a final newline", () => {
    const text = `${lineText(200)}\n`;
    const lines = conversationLines([message("user", text)], PATH);
    expect(lines[201]).toBe(`  (1 more line omitted. Full conversation: ${PATH})`);
  });

  it("counts lines after the control characters are replaced", () => {
    const text = `${"a\r\n".repeat(200)}b`;
    const lines = conversationLines([message("user", text)], PATH);
    expect(lines[201]).toBe(`  (1 more line omitted. Full conversation: ${PATH})`);
  });
});

describe("the layout of a message", () => {
  it("indents each line by two spaces, keeps tabs, and leaves empty lines empty", () => {
    expect(conversationLines([message("system", "a\n\n\tb")], PATH)).toEqual([
      "System:",
      "  a",
      "",
      "  \tb",
      "",
    ]);
  });

  it("names the role of each message", () => {
    const roles: Role[] = ["system", "developer", "user", "assistant"];
    const lines = conversationLines(
      roles.map((role) => message(role, "x")),
      PATH,
    );
    expect(lines.filter((line) => line.endsWith(":"))).toEqual([
      "System:",
      "Developer:",
      "User:",
      "Assistant:",
    ]);
  });
});
