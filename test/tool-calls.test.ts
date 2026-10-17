import { describe, expect, it } from "vitest";
import {
  INVALID_REPLY_REASONS,
  isInvalidReplyReason,
  TOOL_CALL_PROBLEMS,
  type ToolDefinitions,
} from "../src/model.js";
import { classifyReply } from "../src/tool-calls.js";

const CALL = {
  id: "call_1",
  type: "function",
  function: { name: "get_weather", arguments: '{"city": "Tokyo"}' },
};

function reply(value: unknown): string {
  return JSON.stringify(value);
}

function problemOf(body: string, definitions: ToolDefinitions): string | undefined {
  const result = classifyReply(body, definitions);
  return result.kind === "invalid" ? result.problem : undefined;
}

describe("telling a tool call reply from text", () => {
  it("takes every reply as text when the request has no definitions", () => {
    expect(classifyReply(reply([CALL]), "none")).toEqual({ kind: "text" });
    expect(classifyReply("Hello", "none")).toEqual({ kind: "text" });
  });

  it("takes a non-empty array whose elements all have a function key as tool calls", () => {
    for (const definitions of ["tools", "both"] as const) {
      const result = classifyReply(reply([CALL]), definitions);
      expect(result).toEqual({
        kind: "tool_calls",
        calls: [
          {
            raw: CALL,
            id: "call_1",
            name: "get_weather",
            arguments: '{"city": "Tokyo"}',
          },
        ],
      });
    }
  });

  it("takes white space around the array as part of the JSON", () => {
    expect(classifyReply(`\n  ${reply([CALL])}\n`, "tools").kind).toBe("tool_calls");
  });

  it("takes anything else as text, even when it looks like a near miss", () => {
    const text = [
      "Hello",
      "",
      "not json [",
      reply({ function: {} }),
      reply("text"),
      reply(5),
      reply(null),
      reply([]),
      reply([CALL, { id: "call_2" }]),
      reply([CALL, "x"]),
      reply([CALL, null]),
      reply([CALL, [CALL]]),
      reply([{ id: "call_2", type: "function" }]),
    ];
    for (const body of text) {
      expect(classifyReply(body, "tools"), body).toEqual({ kind: "text" });
    }
  });

  it("looks for the function key on the element itself, not on its prototype", () => {
    expect(classifyReply('[{"__proto__": {"function": {}}}]', "tools")).toEqual({ kind: "text" });
  });
});

describe("checking the tool calls", () => {
  it("accepts extra fields on a call and on its function", () => {
    const extra = {
      ...CALL,
      index: 0,
      function: { ...CALL.function, note: "x" },
    };
    const result = classifyReply(reply([extra]), "tools");
    expect(result.kind === "tool_calls" && result.calls[0]?.raw).toEqual(extra);
  });

  it("accepts arguments that are not JSON, and an empty arguments string", () => {
    for (const args of ["not json", ""]) {
      const call = { ...CALL, function: { name: "f", arguments: args } };
      expect(classifyReply(reply([call]), "tools").kind).toBe("tool_calls");
    }
  });

  it("accepts several calls with different ids", () => {
    const second = { ...CALL, id: "call_2" };
    const result = classifyReply(reply([CALL, second]), "tools");
    expect(result.kind === "tool_calls" && result.calls.map((call) => call.id)).toEqual([
      "call_1",
      "call_2",
    ]);
  });

  it("names the number of the call and the field that does not fit", () => {
    const cases: [unknown, string][] = [
      [{ ...CALL, id: "" }, "call 1 needs a non-empty string id"],
      [{ ...CALL, id: 5 }, "call 1 needs a non-empty string id"],
      [{ function: CALL.function, type: "function" }, "call 1 needs a non-empty string id"],
      [{ ...CALL, type: "tool" }, 'call 1 needs the type "function"'],
      [{ id: "call_1", function: CALL.function }, 'call 1 needs the type "function"'],
      [
        { ...CALL, function: { name: "", arguments: "{}" } },
        "call 1 needs function.name as a non-empty string",
      ],
      [
        { ...CALL, function: { name: 5, arguments: "{}" } },
        "call 1 needs function.name as a non-empty string",
      ],
      [{ ...CALL, function: 5 }, "call 1 needs function.name as a non-empty string"],
      [{ ...CALL, function: null }, "call 1 needs function.name as a non-empty string"],
      [{ ...CALL, function: { name: "f" } }, "call 1 needs function.arguments as a string"],
      [
        { ...CALL, function: { name: "f", arguments: {} } },
        "call 1 needs function.arguments as a string",
      ],
    ];
    for (const [call, problem] of cases) {
      expect(problemOf(reply([call]), "tools"), JSON.stringify(call)).toBe(problem);
    }
  });

  it("counts the calls from 1 and reports the first one that does not fit", () => {
    const bad = { ...CALL, id: "call_2", type: "x" };
    expect(problemOf(reply([CALL, bad, { ...CALL, id: "" }]), "tools")).toBe(
      'call 2 needs the type "function"',
    );
  });

  it("checks the id, then the type, then the name, then the arguments of one call", () => {
    const call = { id: "", type: "x", function: { name: "", arguments: 1 } };
    expect(problemOf(reply([call]), "tools")).toBe("call 1 needs a non-empty string id");
    expect(problemOf(reply([{ ...call, id: "a" }]), "tools")).toBe(
      'call 1 needs the type "function"',
    );
    expect(problemOf(reply([{ ...call, id: "a", type: "function" }]), "tools")).toBe(
      "call 1 needs function.name as a non-empty string",
    );
  });

  it("refuses an id that an earlier call already used", () => {
    expect(problemOf(reply([CALL, { ...CALL }]), "tools")).toBe(
      "call 2 has the same id as an earlier call",
    );
  });

  it("never copies a typed character into the problem", () => {
    const secret = "secret-token";
    const body = reply([
      {
        id: secret,
        type: secret,
        function: { name: secret, arguments: secret },
      },
    ]);
    expect(problemOf(body, "tools")).not.toContain(secret);
    const named = reply([{ id: "a", type: "function", function: { name: secret, arguments: 5 } }]);
    expect(problemOf(named, "tools")).not.toContain(secret);
  });

  it("takes the wording of every problem from the one definition in model.ts", () => {
    const wording = TOOL_CALL_PROBLEMS;
    expect(problemOf(reply([{ ...CALL, id: "" }]), "tools")).toBe(wording.needsId(1));
    expect(problemOf(reply([CALL, CALL]), "tools")).toBe(wording.sameId(2));
    expect(problemOf(reply([{ ...CALL, type: "x" }]), "tools")).toBe(wording.needsType(1));
    expect(problemOf(reply([{ ...CALL, function: { name: "" } }]), "tools")).toBe(
      wording.needsName(1),
    );
    expect(problemOf(reply([{ ...CALL, function: { name: "f" } }]), "tools")).toBe(
      wording.needsArguments(1),
    );
    expect(problemOf(reply([CALL, { ...CALL, id: "call_2" }]), "functions")).toBe(
      wording.oneCallOnly,
    );
    for (const text of [
      wording.needsId(7),
      wording.sameId(7),
      wording.needsType(7),
      wording.needsName(7),
      wording.needsArguments(7),
      wording.oneCallOnly,
    ]) {
      expect(isInvalidReplyReason(INVALID_REPLY_REASONS.badToolCalls(text))).toBe(true);
    }
    expect(isInvalidReplyReason(INVALID_REPLY_REASONS.badToolCalls("call 1 needs a secret"))).toBe(
      false,
    );
  });

  it("gives problems that the log accepts as fixed reasons", () => {
    const bodies = [
      reply([{ ...CALL, id: "" }]),
      reply([{ ...CALL, type: "x" }]),
      reply([{ ...CALL, function: { name: "" } }]),
      reply([{ ...CALL, function: { name: "f" } }]),
      reply([CALL, CALL]),
    ];
    for (const body of bodies) {
      const problem = problemOf(body, "tools");
      expect(isInvalidReplyReason(INVALID_REPLY_REASONS.badToolCalls(problem ?? ""))).toBe(true);
    }
    const functionsOnly = problemOf(reply([CALL, { ...CALL, id: "call_2" }]), "functions");
    expect(isInvalidReplyReason(INVALID_REPLY_REASONS.badToolCalls(functionsOnly ?? ""))).toBe(
      true,
    );
  });
});

describe("a request that defines functions only", () => {
  it("takes exactly one call as a function call", () => {
    expect(classifyReply(reply([CALL]), "functions")).toEqual({
      kind: "function_call",
      name: "get_weather",
      arguments: '{"city": "Tokyo"}',
    });
  });

  it("asks to type again when there are several calls", () => {
    const two = reply([CALL, { ...CALL, id: "call_2" }]);
    expect(problemOf(two, "functions")).toBe(
      "this request defines functions only, so exactly one call is allowed",
    );
  });

  it("checks the one call like any other", () => {
    expect(problemOf(reply([{ ...CALL, id: "" }]), "functions")).toBe(
      "call 1 needs a non-empty string id",
    );
  });

  it("takes text as text, as for tools", () => {
    expect(classifyReply("Hello", "functions")).toEqual({ kind: "text" });
    expect(classifyReply(reply([CALL, { id: "x" }]), "functions")).toEqual({
      kind: "text",
    });
  });

  it("allows several calls when the request also defines tools", () => {
    const two = reply([CALL, { ...CALL, id: "call_2" }]);
    const result = classifyReply(two, "both");
    expect(result.kind === "tool_calls" && result.calls).toHaveLength(2);
  });
});
