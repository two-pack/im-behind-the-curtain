/**
 * The one place that tells a human reply that calls tools from a reply that is text, and checks
 * the calls. The answer screen, the reply from standard input, the check of a reply file and the
 * response of the server all call these functions, so they cannot disagree.
 *
 * A reply is a set of tool calls only when the request has tool definitions and the reply is a
 * JSON array that is not empty and whose every element is an object with a `function` key. Any
 * other reply is text. The calls are then checked; the problem is one of a few fixed phrases
 * with the number of a call and never a typed character (NFR10).
 */
import {
  TOOL_CALL_PROBLEMS,
  type ToolCallItem,
  type ToolDefinitions,
  type ToolReply,
} from "./model.js";

/** A reply that was taken for tool calls but does not fit: `problem` is a fixed phrase. */
export type ReplyClassification = ToolReply | { kind: "invalid"; problem: string };

const TEXT: ToolReply = { kind: "text" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasFunctionKey(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.hasOwn(value, "function");
}

function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** The elements of a reply that is a non-empty array of objects with a `function` key. */
function candidateCalls(body: string): Record<string, unknown>[] | undefined {
  const value = parseJson(body);
  if (!Array.isArray(value) || value.length === 0 || !value.every(hasFunctionKey)) {
    return undefined;
  }
  return value;
}

/** The problem of one call, or undefined when it fits. `number` counts from 1. */
function describeCallProblem(
  call: Record<string, unknown>,
  number: number,
  seen: ReadonlySet<string>,
): string | undefined {
  const fn = call.function;
  if (typeof call.id !== "string" || call.id === "") {
    return TOOL_CALL_PROBLEMS.needsId(number);
  }
  if (seen.has(call.id)) {
    return TOOL_CALL_PROBLEMS.sameId(number);
  }
  if (call.type !== "function") {
    return TOOL_CALL_PROBLEMS.needsType(number);
  }
  if (!isRecord(fn) || typeof fn.name !== "string" || fn.name === "") {
    return TOOL_CALL_PROBLEMS.needsName(number);
  }
  return typeof fn.arguments === "string" ? undefined : TOOL_CALL_PROBLEMS.needsArguments(number);
}

/** The first problem of the calls, or the checked calls when every one fits. */
function checkCalls(
  calls: readonly Record<string, unknown>[],
): { problem: string } | { items: ToolCallItem[] } {
  const seen = new Set<string>();
  const items: ToolCallItem[] = [];
  for (const [index, raw] of calls.entries()) {
    const problem = describeCallProblem(raw, index + 1, seen);
    if (problem !== undefined) {
      return { problem };
    }
    const fn = raw.function as Record<string, unknown>;
    const id = raw.id as string;
    seen.add(id);
    items.push({
      raw,
      id,
      name: fn.name as string,
      arguments: fn.arguments as string,
    });
  }
  return { items };
}

/**
 * Tells what a reply is for a request with these definitions: text, tool calls, one function
 * call (the request defines `functions` only), or tool calls that do not fit.
 */
export function classifyReply(body: string, toolDefinitions: ToolDefinitions): ReplyClassification {
  const calls = toolDefinitions === "none" ? undefined : candidateCalls(body);
  if (calls === undefined) {
    return TEXT;
  }
  const functionsOnly = toolDefinitions === "functions";
  if (functionsOnly && calls.length !== 1) {
    return { kind: "invalid", problem: TOOL_CALL_PROBLEMS.oneCallOnly };
  }
  const checked = checkCalls(calls);
  if ("problem" in checked) {
    return { kind: "invalid", problem: checked.problem };
  }
  if (functionsOnly) {
    const [only] = checked.items as [ToolCallItem];
    return {
      kind: "function_call",
      name: only.name,
      arguments: only.arguments,
    };
  }
  return { kind: "tool_calls", calls: checked.items };
}
