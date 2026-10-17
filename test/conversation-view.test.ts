import { describe, expect, it } from "vitest";
import {
  buildConversationView,
  conversationLines,
  escapeAllControls,
  escapeControls,
  toolListLines,
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

  it("names the tool and function roles too", () => {
    const lines = conversationLines([message("tool", "sunny"), message("function", "old")], PATH);
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
    return conversationLines([item], PATH);
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
    expect(conversationLines([message("tool", "ok\u001b")], PATH).join("")).not.toContain("\u001b");
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
