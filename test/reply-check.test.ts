import { describe, expect, it } from "vitest";
import { checkReply } from "../src/broker/reply-check.js";

const REASON =
  /^(unexpected end of input at line \d+|unexpected character at line \d+, column \d+|extra data after the JSON value at line \d+, column \d+)$/;

function reasonOf(body: string): string {
  const result = checkReply("json", body);
  if (result.ok) {
    throw new Error(`expected "${body}" to be refused`);
  }
  return result.reason;
}

describe("a text reply", () => {
  it("is never checked, whatever it contains", () => {
    expect(checkReply("text", "{not json")).toEqual({ ok: true });
    expect(checkReply("text", "")).toEqual({ ok: true });
  });
});

describe("a reply that reads as JSON (RFC 8259)", () => {
  it("accepts every kind of top-level value", () => {
    for (const body of [
      '{"passed": true, "reason": "ok"}',
      "[1, 2, 3]",
      "[]",
      "{}",
      '"text"',
      "42",
      "-0",
      "-12.5e+3",
      "1E5",
      "true",
      "false",
      "null",
      '"\\u00e9 \\ud83d \\n \\/ \\\\ \\" \\b \\f \\r \\t"',
    ]) {
      expect(checkReply("json", body), body).toEqual({ ok: true });
    }
  });

  it("accepts white space before and after the value, and between tokens", () => {
    expect(checkReply("json", ' \t\r\n{ "a" :\n [ 1 , { "b" : null } ] }\n\n ')).toEqual({
      ok: true,
    });
  });

  it("accepts a very deeply nested value without running out of stack", () => {
    const depth = 200_000;
    expect(checkReply("json", "[".repeat(depth) + "]".repeat(depth))).toEqual({ ok: true });
  });
});

describe("a reply that does not read as JSON", () => {
  it("reports an input that ends too early, with the line of the end", () => {
    expect(reasonOf('{"passed":')).toBe("unexpected end of input at line 1");
    expect(reasonOf("")).toBe("unexpected end of input at line 1");
    expect(reasonOf("  \n ")).toBe("unexpected end of input at line 2");
    expect(reasonOf('{\n  "a": 1,\n  "b": ')).toBe("unexpected end of input at line 3");
    expect(reasonOf('"abc')).toBe("unexpected end of input at line 1");
    expect(reasonOf("tru")).toBe("unexpected end of input at line 1");
    expect(reasonOf("-")).toBe("unexpected end of input at line 1");
    expect(reasonOf("1.")).toBe("unexpected end of input at line 1");
    expect(reasonOf("[1,")).toBe("unexpected end of input at line 1");
  });

  it("reports the place where reading stopped, by line and column starting at 1", () => {
    expect(reasonOf('{"a":1,}')).toBe("unexpected character at line 1, column 8");
    expect(reasonOf("[1,2,]")).toBe("unexpected character at line 1, column 6");
    expect(reasonOf("{'a': 1}")).toBe("unexpected character at line 1, column 2");
    expect(reasonOf('{"a": 1\n "b": 2}')).toBe("unexpected character at line 2, column 2");
    expect(reasonOf('{"a" 1}')).toBe("unexpected character at line 1, column 6");
    expect(reasonOf("{1: 2}")).toBe("unexpected character at line 1, column 2");
  });

  it("refuses comments, trailing commas, NaN and Infinity", () => {
    expect(reasonOf("// note\n{}")).toBe("unexpected character at line 1, column 1");
    expect(reasonOf("/* note */ {}")).toBe("unexpected character at line 1, column 1");
    expect(reasonOf('{"a": NaN}')).toBe("unexpected character at line 1, column 7");
    expect(reasonOf('{"a": Infinity}')).toBe("unexpected character at line 1, column 7");
    expect(reasonOf("-Infinity")).toBe("unexpected character at line 1, column 2");
    expect(reasonOf("[1,]")).toBe("unexpected character at line 1, column 4");
  });

  it("refuses bad numbers, bad escapes and raw control characters in a string", () => {
    expect(reasonOf(".5")).toBe("unexpected character at line 1, column 1");
    expect(reasonOf("+1")).toBe("unexpected character at line 1, column 1");
    expect(reasonOf("1.x")).toBe("unexpected character at line 1, column 3");
    expect(reasonOf("1e")).toBe("unexpected end of input at line 1");
    expect(reasonOf("[01]")).toBe("unexpected character at line 1, column 3");
    expect(reasonOf('"\\x"')).toBe("unexpected character at line 1, column 3");
    expect(reasonOf('"\\u12G4"')).toBe("unexpected character at line 1, column 6");
    expect(reasonOf('"a\nb"')).toBe("unexpected character at line 1, column 3");
    expect(reasonOf("nul1")).toBe("unexpected character at line 1, column 4");
  });

  it("reports extra data after a complete value", () => {
    expect(reasonOf("{} x")).toBe("extra data after the JSON value at line 1, column 4");
    expect(reasonOf("{}\n{}")).toBe("extra data after the JSON value at line 2, column 1");
    expect(reasonOf("01")).toBe("extra data after the JSON value at line 1, column 2");
    expect(reasonOf('"a" "b"')).toBe("extra data after the JSON value at line 1, column 5");
    expect(reasonOf("truex")).toBe("extra data after the JSON value at line 1, column 5");
  });

  it("counts a column in characters, not in UTF-16 units", () => {
    expect(reasonOf('["\u{1F600}" x]')).toBe("unexpected character at line 1, column 6");
  });

  it("never puts any typed character into the reason (NFR10.2)", () => {
    for (const body of [
      '{"secret-xyz": ZQZ}',
      "secret-xyz",
      '{"secret-xyz": "ZQZ',
      '{"a": 1} secret-xyz',
      '"secret-xyz\\q"',
    ]) {
      const reason = reasonOf(body);
      expect(reason).toMatch(REASON);
      expect(reason).not.toMatch(/secret|xyz|ZQZ/);
    }
  });

  it("does not look at the shape the client asked for", () => {
    expect(checkReply("json", '{"reason": "x"}')).toEqual({ ok: true });
  });
});

describe("agreeing with the standard JSON reader (RFC 8259)", () => {
  const SAMPLE = '{"a": [1, -2.5e+3, true, null, "x\\u00e9\\n"], "b": {"c": false}} ';
  const SUBSTITUTES = ['"', "\\", "[", "]", "{", "}", ",", ":", " ", "x", "0", "-", ".", "e", "\n"];

  function standardAccepts(body: string): boolean {
    try {
      JSON.parse(body);
      return true;
    } catch {
      return false;
    }
  }

  it("accepts and refuses exactly what JSON.parse does for every one-character edit of a sample", () => {
    const bodies = new Set<string>([SAMPLE]);
    for (let index = 0; index < SAMPLE.length; index += 1) {
      bodies.add(SAMPLE.slice(0, index) + SAMPLE.slice(index + 1));
      for (const substitute of SUBSTITUTES) {
        bodies.add(SAMPLE.slice(0, index) + substitute + SAMPLE.slice(index));
        bodies.add(SAMPLE.slice(0, index) + substitute + SAMPLE.slice(index + 1));
      }
      bodies.add(SAMPLE.slice(0, index));
    }
    expect(bodies.size).toBeGreaterThan(500);
    for (const body of bodies) {
      const result = checkReply("json", body);
      expect(result.ok, JSON.stringify(body)).toBe(standardAccepts(body));
      if (!result.ok) {
        expect(result.reason).toMatch(REASON);
      }
    }
  });
});
