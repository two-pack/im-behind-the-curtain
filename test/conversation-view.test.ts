import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConversationView,
  conversationLines,
  escapeAllControls,
  escapeControls,
  toolListLines,
} from "../src/answer/conversation-view.js";
import type { Attachment, Message, Role } from "../src/model.js";

const DIR = path.resolve("data", "requests", "20261009T140512123Z-a1b2c3");
const PATH = path.join(DIR, "request.json");

function message(role: Role, content: string): Message {
  return { role, content };
}

/** A conversation of `count` messages with the given role, named `<role> 1`, `<role> 2`, ... */
function many(role: Role, count: number): Message[] {
  return Array.from({ length: count }, (_, index) => message(role, `${role} ${index + 1}`));
}

function shownContents(conversation: Message[]): string[] {
  return buildConversationView(conversation, DIR, PATH).flatMap((entry) =>
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
    const entries = buildConversationView(
      [message("system", "rules"), ...many("user", 3)],
      DIR,
      PATH,
    );
    expect(entries.map((entry) => entry.kind)).toEqual([
      "message",
      "message",
      "message",
      "message",
    ]);
  });

  it("omits one message for four other messages", () => {
    const entries = buildConversationView(many("user", 4), DIR, PATH);
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

describe("saved parts", () => {
  function part(
    file: string,
    at: number,
    size = 12345,
    mediaType: string | null = "image/png",
  ): Attachment {
    return {
      at,
      kind: "image",
      mediaType,
      size,
      file,
      readable: true,
      address: null,
      fileId: null,
      typeName: null,
    };
  }

  function withParts(content: string, ...attachments: Attachment[]): Message {
    return { role: "user", content, attachments };
  }

  const FILE_1 = "message-1-part-1.png";
  const FILE_2 = "message-1-part-2.png";

  function saved(file: string): string {
    return `    saved: ${path.join(DIR, file)}`;
  }

  function linesOf(message: Message): string[] {
    return conversationLines([message], PATH, DIR);
  }

  it("shows a part as two lines: the kind, the media type and the size, then the saved path", () => {
    expect(linesOf(withParts("", part(FILE_1, 0)))).toEqual([
      "User:",
      "  [image] image/png, 12345 bytes",
      saved(FILE_1),
      "",
    ]);
  });

  it("says byte for 1, bytes for 0, and unknown for a media type that is null", () => {
    const lines = linesOf(withParts("", part(FILE_1, 0, 1), part(FILE_2, 0, 0, null)));
    expect(lines).toEqual([
      "User:",
      "  [image] image/png, 1 byte",
      saved(FILE_1),
      "  [image] unknown, 0 bytes",
      saved(FILE_2),
      "",
    ]);
  });

  it("puts the text before and after a part in the order it arrived", () => {
    expect(linesOf(withParts("before after", part(FILE_1, 7)))).toEqual([
      "User:",
      "  before ",
      "  [image] image/png, 12345 bytes",
      saved(FILE_1),
      "  after",
      "",
    ]);
  });

  it("ends a line at the part when the part comes in the middle of a line", () => {
    const lines = linesOf(withParts("ab\ncd\nef", part(FILE_1, 4)));
    expect(lines.slice(1, -1)).toEqual([
      "  ab",
      "  c",
      "  [image] image/png, 12345 bytes",
      saved(FILE_1),
      "  d",
      "  ef",
    ]);
  });

  it("shows no line for an empty piece of text at the start, at the end or after a newline", () => {
    const start = linesOf(withParts("ab", part(FILE_1, 0)));
    expect(start.slice(1, -1)).toEqual(["  [image] image/png, 12345 bytes", saved(FILE_1), "  ab"]);
    const end = linesOf(withParts("ab", part(FILE_1, 2)));
    expect(end.slice(1, -1)).toEqual(["  ab", "  [image] image/png, 12345 bytes", saved(FILE_1)]);
    const afterNewline = linesOf(withParts("ab\ncd", part(FILE_1, 3)));
    expect(afterNewline.slice(1, -1)).toEqual([
      "  ab",
      "",
      "  [image] image/png, 12345 bytes",
      saved(FILE_1),
      "  cd",
    ]);
  });

  it("keeps parts with the same position in the order they were recorded", () => {
    const lines = linesOf(withParts("ab", part(FILE_2, 1), part(FILE_1, 1)));
    expect(lines.filter((line) => line.startsWith("    saved:"))).toEqual([
      saved(FILE_2),
      saved(FILE_1),
    ]);
  });

  it("counts a character outside the basic plane as one when it splits the text", () => {
    const lines = linesOf(withParts("\u{1F600}x", part(FILE_1, 1)));
    expect(lines.slice(1, -1)).toEqual([
      "  \u{1F600}",
      "  [image] image/png, 12345 bytes",
      saved(FILE_1),
      "  x",
    ]);
  });

  it("makes control characters of the text visible on both sides of a part", () => {
    const lines = linesOf(withParts("a\x1bb", part(FILE_1, 2)));
    expect(lines[1]).toBe("  a\\x1b");
    expect(lines.at(-2)).toBe("  b");
  });

  it("does not show (empty) for a message of only parts", () => {
    expect(linesOf(withParts("", part(FILE_1, 0))).join("\n")).not.toContain("(empty)");
  });

  it("shows the lines of the calls of an assistant message after the text and the parts", () => {
    const call = { id: "1", type: "function", function: { name: "f", arguments: "{}" } };
    const lines = linesOf({
      role: "assistant",
      content: "x",
      attachments: [part(FILE_1, 1)],
      tool_calls: [call],
    });
    expect(lines).toEqual([
      "Assistant:",
      "  x",
      "  [image] image/png, 12345 bytes",
      saved(FILE_1),
      "  tool_call: f({})",
      "",
    ]);
  });

  const TEXT_199 = Array.from({ length: 199 }, (_, index) => `l${index}`).join("\n");

  it("counts every line of a part in the limit of 200 lines of a message", () => {
    const message = withParts(TEXT_199, part(FILE_1, 0), part(FILE_2, 0));
    const entry = buildConversationView([message], DIR, PATH)[0];
    // Four lines of parts and 199 lines of text: 203 lines, 3 are left out.
    expect(entry?.kind === "message" && entry.lines).toHaveLength(200);
    expect(entry?.kind === "message" && entry.hiddenLines).toBe(3);
    expect(linesOf(message).some((line) => line.includes("(3 more lines omitted"))).toBe(true);
  });

  it("can cut between the two lines of a part: only the first line is shown", () => {
    const lines = linesOf(withParts(TEXT_199, part(FILE_1, TEXT_199.length)));
    expect(lines.some((line) => line.startsWith("  [image]"))).toBe(true);
    expect(lines.some((line) => line.startsWith("    saved:"))).toBe(false);
    expect(lines.some((line) => line.includes("(1 more line omitted"))).toBe(true);
  });

  it("shows a part whose file name does not have the form of a saved name as unreadable", () => {
    for (const file of ["../evil.png", "notes.txt", "message-1-part-1.PNG", ""]) {
      const lines = linesOf(withParts("", part(file, 0)));
      expect(lines).toEqual(["User:", "  [image] (unreadable)", ""]);
    }
  });

  it("shows a part that has no file or no size as unreadable", () => {
    const base = part(FILE_1, 0);
    const lines = linesOf(withParts("", { ...base, file: null }, { ...base, size: null }));
    expect(lines).toEqual(["User:", "  [image] (unreadable)", "  [image] (unreadable)", ""]);
  });

  it("makes a control character of the media type visible", () => {
    const lines = linesOf(withParts("", part(FILE_1, 0, 3, "image/\x1bpng")));
    expect(lines[1]).toBe("  [image] image/\\x1bpng, 3 bytes");
  });
});

/** An attachment of the given state; the fields that a state does not use are null. */
function attachmentOf(fields: Partial<Attachment> & Pick<Attachment, "kind">): Attachment {
  return {
    at: 0,
    mediaType: null,
    size: null,
    file: null,
    readable: true,
    address: null,
    fileId: null,
    typeName: null,
    ...fields,
  };
}

function viewLines(...attachments: Attachment[]): string[] {
  return conversationLines([{ role: "user", content: "", attachments }], PATH, DIR);
}

describe("audio and file parts that are saved", () => {
  it("shows them as two lines, like an image, with the kind of the part", () => {
    const lines = viewLines(
      attachmentOf({
        kind: "audio",
        mediaType: "audio/wav",
        size: 4,
        file: "message-1-part-1.wav",
      }),
      attachmentOf({
        kind: "file",
        mediaType: "application/pdf",
        size: 8,
        file: "message-1-part-2.pdf",
      }),
      attachmentOf({ kind: "file", mediaType: null, size: 1, file: "message-1-part-3.bin" }),
    );
    expect(lines).toEqual([
      "User:",
      "  [audio] audio/wav, 4 bytes",
      `    saved: ${path.join(DIR, "message-1-part-1.wav")}`,
      "  [file] application/pdf, 8 bytes",
      `    saved: ${path.join(DIR, "message-1-part-2.pdf")}`,
      "  [file] unknown, 1 byte",
      `    saved: ${path.join(DIR, "message-1-part-3.bin")}`,
      "",
    ]);
  });
});

describe("parts that are not saved", () => {
  it("shows an address on one line with no saved line", () => {
    expect(
      viewLines(attachmentOf({ kind: "image", address: "https://example.com/cat.png" })),
    ).toEqual(["User:", "  [image] https://example.com/cat.png", ""]);
  });

  it("shows a file_id, and a file with nothing but its kind", () => {
    expect(
      viewLines(
        attachmentOf({ kind: "file", fileId: "file-abc123" }),
        attachmentOf({ kind: "file" }),
      ),
    ).toEqual(["User:", "  [file] file_id: file-abc123", "  [file]", ""]);
  });

  it("shows a part that cannot be read, for each of the three kinds, the same way", () => {
    const lines = viewLines(
      attachmentOf({ kind: "image", readable: false }),
      attachmentOf({ kind: "audio", readable: false }),
      attachmentOf({ kind: "file", readable: false }),
    );
    expect(lines).toEqual([
      "User:",
      "  [image] (unreadable)",
      "  [audio] (unreadable)",
      "  [file] (unreadable)",
      "",
    ]);
  });

  it("shows a part of an unknown type by its type name only", () => {
    const lines = viewLines(
      attachmentOf({ kind: "other", typeName: "video_url" }),
      attachmentOf({ kind: "other", typeName: "audio" }),
    );
    expect(lines).toEqual(["User:", "  [video_url]", "  [audio]", ""]);
  });

  it("puts them in order with text and saved parts", () => {
    const message: Message = {
      role: "user",
      content: "ab",
      attachments: [
        attachmentOf({ at: 1, kind: "image", address: "https://x/y.png" }),
        attachmentOf({ at: 1, kind: "other", typeName: "refusal" }),
        attachmentOf({ at: 2, kind: "file", fileId: "f1" }),
      ],
    };
    expect(conversationLines([message], PATH, DIR)).toEqual([
      "User:",
      "  a",
      "  [image] https://x/y.png",
      "  [refusal]",
      "  b",
      "  [file] file_id: f1",
      "",
    ]);
  });

  it("makes control characters visible in a type name, an address, a file_id and a media type", () => {
    const lines = viewLines(
      attachmentOf({ kind: "other", typeName: "\x1b[31mred" }),
      attachmentOf({ kind: "image", address: "https://x/\x07\n\ty" }),
      attachmentOf({ kind: "file", fileId: "id\x1b\r\n" }),
      attachmentOf({
        kind: "image",
        mediaType: "image/\x1bpng",
        size: 5,
        file: "message-1-part-4.bin",
      }),
    );
    expect(lines.slice(1, 5)).toEqual([
      "  [\\x1b[31mred]",
      "  [image] https://x/\\x07\\x0a\\x09y",
      "  [file] file_id: id\\x1b\\x0d\\x0a",
      "  [image] image/\\x1bpng, 5 bytes",
    ]);
    const forbidden = [...lines.join("\n")].filter((char) => {
      const code = char.charCodeAt(0);
      return (code < 0x20 && char !== "\n") || (code >= 0x7f && code <= 0x9f);
    });
    expect(forbidden).toEqual([]);
  });

  it("shows a name that is empty as an empty pair of brackets", () => {
    expect(viewLines(attachmentOf({ kind: "other", typeName: "" }))[1]).toBe("  []");
  });
});

describe("cutting a long line", () => {
  const NOTE = (count: number) =>
    `... (${count} characters in this line. Full conversation: ${PATH})`;

  function userLines(content: string, ...attachments: Attachment[]): string[] {
    return conversationLines([{ role: "user", content, attachments }], PATH, DIR);
  }

  it("keeps a line of exactly 1000 characters whole and cuts one of 1001", () => {
    expect(userLines("a".repeat(1000))[1]).toBe(`  ${"a".repeat(1000)}`);
    expect(userLines("a".repeat(1001))[1]).toBe(`  ${"a".repeat(1000)}${NOTE(1001)}`);
  });

  it("cuts a line of text to its first 1000 characters and tells the whole length", () => {
    expect(userLines("x".repeat(1500))).toEqual([
      "User:",
      `  ${"x".repeat(1000)}${NOTE(1500)}`,
      "",
    ]);
  });

  it("does not count the indent, but counts the prefix of a part line", () => {
    const address = (length: number) =>
      attachmentOf({ kind: "image", address: "u".repeat(length) });
    // "[image] " is 8 characters.
    expect(userLines("", address(992))[1]).toBe(`  [image] ${"u".repeat(992)}`);
    expect(userLines("", address(993))[1]).toBe(`  [image] ${"u".repeat(992)}${NOTE(1001)}`);
    expect(userLines("", address(2500))[1]).toBe(`  [image] ${"u".repeat(992)}${NOTE(2508)}`);
  });

  it("cuts the line of a file_id", () => {
    const line = userLines("", attachmentOf({ kind: "file", fileId: "i".repeat(1200) }))[1];
    const prefix = "[file] file_id: ";
    expect(line).toBe(
      `  ${prefix}${"i".repeat(1000 - prefix.length)}${NOTE(prefix.length + 1200)}`,
    );
  });

  it("cuts the line of a type name, a media type and a tool call", () => {
    const other = userLines("", attachmentOf({ kind: "other", typeName: "t".repeat(1500) }))[1];
    expect(other).toBe(`  [${"t".repeat(999)}${NOTE(1502)}`);
    const assistant: Message = {
      role: "assistant",
      content: "",
      tool_calls: [
        { id: "1", type: "function", function: { name: "n".repeat(1200), arguments: "{}" } },
      ],
    };
    const call = conversationLines([assistant], PATH, DIR)[1];
    const prefix = "tool_call: ";
    expect(call).toBe(
      `  ${prefix}${"n".repeat(1000 - prefix.length)}${NOTE(prefix.length + 1200 + 4)}`,
    );
  });

  it("counts the line after the control characters are made visible", () => {
    // 300 ESC characters are 1200 characters on the screen.
    const line = userLines("\x1b".repeat(300))[1];
    expect(line).toBe(`  ${"\\x1b".repeat(250)}${NOTE(1200)}`);
    // 250 are exactly 1000 and are not cut.
    expect(userLines("\x1b".repeat(250))[1]).toBe(`  ${"\\x1b".repeat(250)}`);
  });

  it("counts a character outside the basic plane as one and never splits it", () => {
    const smile = "\u{1F600}";
    expect(userLines(smile.repeat(1000))[1]).toBe(`  ${smile.repeat(1000)}`);
    expect(userLines(smile.repeat(1001))[1]).toBe(`  ${smile.repeat(1000)}${NOTE(1001)}`);
  });

  it("does not cut the saved line, however long the path is", () => {
    const lines = conversationLines(
      [
        {
          role: "user",
          content: "",
          attachments: [
            attachmentOf({
              kind: "image",
              mediaType: "image/png",
              size: 1,
              file: "message-1-part-1.png",
            }),
          ],
        },
      ],
      PATH,
      path.join(DIR, "d".repeat(1500)),
    );
    expect(lines[2]).toBe(`    saved: ${path.join(DIR, "d".repeat(1500), "message-1-part-1.png")}`);
    expect(lines[2]?.length).toBeGreaterThan(1500);
  });

  it("cuts every long line of a message, one by one", () => {
    const lines = userLines(`${"a".repeat(1100)}\nshort\n${"b".repeat(2000)}`);
    expect(lines).toEqual([
      "User:",
      `  ${"a".repeat(1000)}${NOTE(1100)}`,
      "  short",
      `  ${"b".repeat(1000)}${NOTE(2000)}`,
      "",
    ]);
  });

  it("counts a cut line as one line in the limit of 200 lines", () => {
    const content = Array.from({ length: 250 }, () => "z".repeat(1200)).join("\n");
    const entry = buildConversationView([{ role: "user", content }], DIR, PATH)[0];
    expect(entry?.kind === "message" && entry.lines).toHaveLength(200);
    expect(entry?.kind === "message" && entry.hiddenLines).toBe(50);
    const lines = userLines(content);
    expect(lines.filter((line) => line.endsWith(NOTE(1200)))).toHaveLength(200);
    expect(lines.at(-2)).toBe(`  (50 more lines omitted. Full conversation: ${PATH})`);
  });

  it("leaves the empty line, (empty), and short lines as they are", () => {
    expect(userLines("")).toEqual(["User:", "  (empty)", ""]);
    expect(userLines("a\n\nb")).toEqual(["User:", "  a", "", "  b", ""]);
  });
});

describe("a message with a very large number of lines or parts", () => {
  it("builds the view of 300000 newlines and applies the 200 line cap", () => {
    const content = "\n".repeat(300_000);
    const entry = buildConversationView([{ role: "user", content }], DIR, PATH)[0];
    expect(entry?.kind === "message" && entry.lines).toHaveLength(200);
    expect(entry?.kind === "message" && entry.hiddenLines).toBe(300_001 - 200);
    expect(conversationLines([{ role: "user", content }], PATH, DIR).length).toBeLessThan(210);
  });

  it("builds the view of 140000 parts and 140000 tool calls and applies the cap", () => {
    const attachments = Array.from({ length: 140_000 }, () =>
      attachmentOf({ kind: "other", typeName: "x" }),
    );
    const call = { id: "1", type: "function", function: { name: "f", arguments: "{}" } };
    const message: Message = {
      role: "assistant",
      content: "",
      attachments,
      tool_calls: Array.from({ length: 140_000 }, () => call),
    };
    const entry = buildConversationView([message], DIR, PATH)[0];
    expect(entry?.kind === "message" && entry.lines).toHaveLength(200);
    expect(entry?.kind === "message" && entry.hiddenLines).toBe(280_000 - 200);
  });
});

describe("the line that says messages were omitted", () => {
  it("is one line at the place of the first omitted message, with blank lines around it", () => {
    const conversation = [message("system", "rules"), ...many("user", 6)];
    expect(conversationLines(conversation, PATH, DIR)).toEqual([
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
    const lines = conversationLines(many("assistant", 4), PATH, DIR);
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
    const lines = conversationLines(conversation, PATH, DIR);
    const notices = lines.filter((line) => line.includes("earlier message"));
    expect(notices).toEqual([`(2 earlier messages omitted. Full conversation: ${PATH})`]);
    expect(lines.indexOf(notices[0] as string)).toBeLessThan(lines.indexOf("Developer:"));
    expect(lines).not.toContain("  u1");
    expect(lines).not.toContain("  u2");
    expect(lines).toContain("  u3");
  });

  it("does not appear when nothing is omitted", () => {
    const lines = conversationLines(many("user", 3), PATH, DIR);
    expect(lines.some((line) => line.includes("omitted"))).toBe(false);
  });
});

describe("an empty message", () => {
  it("shows (empty), and keeps a message of only spaces as it is", () => {
    expect(conversationLines([message("assistant", "")], PATH, DIR)).toEqual([
      "Assistant:",
      "  (empty)",
      "",
    ]);
    expect(conversationLines([message("user", "   ")], PATH, DIR)).toEqual(["User:", "     ", ""]);
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
    const lines = conversationLines([message("user", "x\x1b[31m\x00\x7f\x9by\r")], PATH, DIR);
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
    const lines = conversationLines([message("user", lineText(200))], PATH, DIR);
    expect(lines).toHaveLength(1 + 200 + 1);
    expect(lines.some((line) => line.includes("more line"))).toBe(false);
  });

  it("cuts a message of 1000 lines at 200 and says how many were left out", () => {
    const lines = conversationLines([message("user", lineText(1000))], PATH, DIR);
    expect(lines).toHaveLength(1 + 200 + 1 + 1);
    expect(lines[200]).toBe("  line 200");
    expect(lines[201]).toBe(`  (800 more lines omitted. Full conversation: ${PATH})`);
    expect(lines[202]).toBe("");
  });

  it("says line in the singular when one line is left out", () => {
    const lines = conversationLines([message("user", lineText(201))], PATH, DIR);
    expect(lines[201]).toBe(`  (1 more line omitted. Full conversation: ${PATH})`);
  });

  it("counts the empty line after a final newline", () => {
    const text = `${lineText(200)}\n`;
    const lines = conversationLines([message("user", text)], PATH, DIR);
    expect(lines[201]).toBe(`  (1 more line omitted. Full conversation: ${PATH})`);
  });

  it("counts lines after the control characters are replaced", () => {
    const text = `${"a\r\n".repeat(200)}b`;
    const lines = conversationLines([message("user", text)], PATH, DIR);
    expect(lines[201]).toBe(`  (1 more line omitted. Full conversation: ${PATH})`);
  });
});

describe("the layout of a message", () => {
  it("indents each line by two spaces, keeps tabs, and leaves empty lines empty", () => {
    expect(conversationLines([message("system", "a\n\n\tb")], PATH, DIR)).toEqual([
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
      DIR,
    );
    expect(lines.filter((line) => line.endsWith(":"))).toEqual([
      "System:",
      "Developer:",
      "User:",
      "Assistant:",
    ]);
  });

  it("names the tool and function roles too", () => {
    const lines = conversationLines(
      [message("tool", "sunny"), message("function", "old")],
      PATH,
      DIR,
    );
    expect(lines).toEqual(["Tool:", "  sunny", "", "Function:", "  old", ""]);
  });
});

describe("showing tool calls", () => {
  const call = (name: unknown, args: unknown, id = "call_1") => ({
    id,
    type: "function",
    function: { name, arguments: args },
  });

  function assistant(extra: Partial<Message>, content = ""): Message {
    return { role: "assistant", content, ...extra };
  }

  function linesOf(item: Message): string[] {
    return conversationLines([item], PATH, DIR);
  }

  it("shows the name and the arguments of a call, and not (empty) for an empty content", () => {
    const item = assistant({
      tool_calls: [call("get_weather", '{"city": "Tokyo"}')],
    });
    expect(linesOf(item)).toEqual([
      "Assistant:",
      '  tool_call: get_weather({"city": "Tokyo"})',
      "",
    ]);
  });

  it("shows every call of a message, after its content", () => {
    const item = assistant(
      {
        tool_calls: [call("a", "1"), call("b", "2", "call_2"), call("c", "3", "call_3")],
      },
      "Let me check.",
    );
    expect(linesOf(item)).toEqual([
      "Assistant:",
      "  Let me check.",
      "  tool_call: a(1)",
      "  tool_call: b(2)",
      "  tool_call: c(3)",
      "",
    ]);
  });

  it("shows a function_call", () => {
    const item = assistant({
      function_call: { name: "get_weather", arguments: "{}" },
    });
    expect(linesOf(item)).toEqual(["Assistant:", "  function_call: get_weather({})", ""]);
  });

  it("cuts the arguments to 80 characters of Unicode and adds ... when it cuts", () => {
    // Hiragana A and I, written as code points so that this file has no Japanese in it.
    const exact = String.fromCodePoint(0x3042).repeat(80);
    const long = `${exact}${String.fromCodePoint(0x3044)}`;
    const emoji = "😀".repeat(81);
    expect(linesOf(assistant({ tool_calls: [call("f", exact)] }))[1]).toBe(
      `  tool_call: f(${exact})`,
    );
    expect(linesOf(assistant({ tool_calls: [call("f", long)] }))[1]).toBe(
      `  tool_call: f(${exact}...)`,
    );
    expect(linesOf(assistant({ tool_calls: [call("f", emoji)] }))[1]).toBe(
      `  tool_call: f(${"😀".repeat(80)}...)`,
    );
  });

  it("cuts a 10 MB argument without reading more than the first 81 code points", () => {
    const huge = "😀".repeat(5 * 1024 * 1024);
    const iteratorOwner = String.prototype as unknown as Record<symbol, unknown>;
    const original = iteratorOwner[Symbol.iterator] as () => IterableIterator<string>;
    let read = 0;
    iteratorOwner[Symbol.iterator] = function (this: string): IterableIterator<string> {
      const inner = original.call(this);
      return {
        [Symbol.iterator]() {
          return this;
        },
        next() {
          const step = inner.next();
          if (!step.done) {
            read += 1;
          }
          return step;
        },
      };
    };
    let lines: string[];
    try {
      lines = linesOf(assistant({ tool_calls: [call("f", huge)] }));
    } finally {
      iteratorOwner[Symbol.iterator] = original;
    }
    expect(lines[1]).toBe(`  tool_call: f(${"😀".repeat(80)}...)`);
    expect(read).toBeLessThanOrEqual(200);
  });

  it("shows an unreadable element as (unreadable tool call), and the rest as usual", () => {
    const item = assistant({
      tool_calls: [
        call("a", "1"),
        5,
        null,
        { function: { arguments: "x" } },
        { function: { name: 3 } },
      ],
    });
    expect(linesOf(item)).toEqual([
      "Assistant:",
      "  tool_call: a(1)",
      "  tool_call: (unreadable tool call)",
      "  tool_call: (unreadable tool call)",
      "  tool_call: (unreadable tool call)",
      "  tool_call: (unreadable tool call)",
      "",
    ]);
  });

  it("shows tool_calls that is not an array as one unreadable element", () => {
    for (const broken of ["not an array", 5, {}, true]) {
      expect(linesOf(assistant({ tool_calls: broken }))).toEqual([
        "Assistant:",
        "  tool_call: (unreadable tool call)",
        "",
      ]);
    }
  });

  it("shows a function_call that is not an object or has no name as unreadable", () => {
    for (const broken of ["get_weather", 5, [], {}, { name: 5 }]) {
      expect(linesOf(assistant({ function_call: broken }))).toEqual([
        "Assistant:",
        "  function_call: (unreadable tool call)",
        "",
      ]);
    }
  });

  it("does not take null or an empty list for an unreadable call", () => {
    expect(linesOf(assistant({ tool_calls: null, function_call: null }))).toEqual([
      "Assistant:",
      "  (empty)",
      "",
    ]);
    expect(linesOf(assistant({ tool_calls: [] }))).toEqual(["Assistant:", "  (empty)", ""]);
    expect(linesOf(assistant({ tool_calls: null }, "Hi"))).toEqual(["Assistant:", "  Hi", ""]);
  });

  it("shows arguments that are not a string as their JSON, and missing ones as nothing", () => {
    expect(linesOf(assistant({ tool_calls: [call("f", { city: "Tokyo" })] }))[1]).toBe(
      '  tool_call: f({"city":"Tokyo"})',
    );
    expect(linesOf(assistant({ tool_calls: [{ function: { name: "f" } }] }))[1]).toBe(
      "  tool_call: f()",
    );
    expect(linesOf(assistant({ function_call: { name: "f" } }))[1]).toBe("  function_call: f()");
  });

  it("writes no control character of a name or arguments to the terminal", () => {
    const item = assistant({
      tool_calls: [call("a\u001b[31mb", "x\ny\u0007")],
    });
    const [, shown] = linesOf(item);
    expect(shown).toBe("  tool_call: a\\x1b[31mb(x\\x0ay\\x07)");
    expect(conversationLines([message("tool", "ok\u001b")], PATH, DIR).join("")).not.toContain(
      "\u001b",
    );
  });

  it("shows a tool message together with its own content only", () => {
    const item: Message = {
      role: "tool",
      content: "sunny",
      tool_call_id: "call_1",
      name: "f",
    };
    expect(linesOf(item)).toEqual(["Tool:", "  sunny", ""]);
  });
});

describe("listing the tools of a request", () => {
  it("lists the names of tools and functions", () => {
    const original = {
      tools: [
        { type: "function", function: { name: "get_weather" } },
        { type: "function", function: { name: "search" } },
      ],
      functions: [{ name: "legacy" }],
    };
    expect(toolListLines(original)).toEqual(["Tools: get_weather, search", "Functions: legacy"]);
  });

  it("names an entry without a name as (unnamed)", () => {
    const original = {
      tools: [
        null,
        5,
        {},
        { function: {} },
        { function: { name: 7 } },
        { function: { name: "a" } },
      ],
      functions: [{ name: "" }, {}],
    };
    expect(toolListLines(original)).toEqual([
      "Tools: (unnamed), (unnamed), (unnamed), (unnamed), (unnamed), a",
      "Functions: (unnamed), (unnamed)",
    ]);
  });

  it("lists nothing for empty, missing or non-array tools and functions", () => {
    expect(toolListLines({})).toEqual([]);
    expect(toolListLines({ tools: [], functions: [] })).toEqual([]);
    expect(toolListLines({ tools: null, functions: "x" })).toEqual([]);
    expect(toolListLines({ tools: {}, functions: 5 })).toEqual([]);
  });

  it("lists one of the two when only that one has entries", () => {
    expect(toolListLines({ functions: [{ name: "legacy" }] })).toEqual(["Functions: legacy"]);
    expect(toolListLines({ tools: [{ function: { name: "a" } }], functions: [] })).toEqual([
      "Tools: a",
    ]);
  });

  it("writes no control character of a name to the terminal", () => {
    const original = { tools: [{ function: { name: "a\nb\u001b" } }] };
    expect(toolListLines(original)).toEqual(["Tools: a\\x0ab\\x1b"]);
  });
});
