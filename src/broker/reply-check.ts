/**
 * The one check of a human reply. `ExchangeBroker` offers it to the answer
 * screen, and the later unit that checks hand-written replies calls the same function.
 *
 * A json reply must be a JSON document in the sense of RFC 8259: any top-level value, white
 * space allowed around tokens, and no comments, trailing commas, NaN or Infinity. The shape
 * the client asked for is not checked. A refusal carries one of three fixed phrases with a
 * position and never a typed character, so a reply cannot reach the screen or the log through
 * the reason (NFR10.2).
 *
 * The reader is a small state machine with an explicit stack, so a deeply nested reply cannot
 * overflow the call stack.
 */

export type ReplyCheck = { ok: true } | { ok: false; reason: string };

/** Where reading stopped: `end` is the end of the input, the others point at a character. */
interface Failure {
  kind: "end" | "character" | "extra";
  index: number;
}

interface Cursor {
  text: string;
  pos: number;
}

type Container = "object" | "array";
type Expect = "value" | "valueOrClose" | "keyOrClose" | "key" | "colon" | "next" | "done";
type Handler = (cursor: Cursor, stack: Container[]) => Expect | Failure;

const WHITE_SPACE = new Set([" ", "\t", "\n", "\r"]);
const ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]);
const LITERALS: Readonly<Record<string, string>> = { t: "true", f: "false", n: "null" };

const isDigit = (char: string | undefined): boolean =>
  char !== undefined && char >= "0" && char <= "9";

const isHex = (char: string | undefined): boolean =>
  char !== undefined && /^[0-9a-fA-F]$/.test(char);

/** A failure at the cursor: the end of the input, or the character that cannot be read. */
function stop(cursor: Cursor): Failure {
  return { kind: cursor.pos >= cursor.text.length ? "end" : "character", index: cursor.pos };
}

function skipWhiteSpace(cursor: Cursor): void {
  while (WHITE_SPACE.has(cursor.text[cursor.pos] ?? "")) {
    cursor.pos += 1;
  }
}

/** Reads one character if it satisfies `accept`, and otherwise reports where it stopped. */
function take(cursor: Cursor, accept: (char: string | undefined) => boolean): Failure | undefined {
  if (!accept(cursor.text[cursor.pos])) {
    return stop(cursor);
  }
  cursor.pos += 1;
  return undefined;
}

function skipDigits(cursor: Cursor): void {
  while (isDigit(cursor.text[cursor.pos])) {
    cursor.pos += 1;
  }
}

/** One or more digits. */
function digits(cursor: Cursor): Failure | undefined {
  const failure = take(cursor, isDigit);
  skipDigits(cursor);
  return failure;
}

/** After a "." or an "e": the fraction digits, or an optional sign and the exponent digits. */
function optionalPart(cursor: Cursor, marker: RegExp, signs: boolean): Failure | undefined {
  if (!marker.test(cursor.text[cursor.pos] ?? "")) {
    return undefined;
  }
  cursor.pos += 1;
  if (signs && (cursor.text[cursor.pos] === "+" || cursor.text[cursor.pos] === "-")) {
    cursor.pos += 1;
  }
  return digits(cursor);
}

function scanNumber(cursor: Cursor): Failure | undefined {
  if (cursor.text[cursor.pos] === "-") {
    cursor.pos += 1;
  }
  const integer = cursor.text[cursor.pos] === "0" ? take(cursor, () => true) : digits(cursor);
  return integer ?? optionalPart(cursor, /^\./, false) ?? optionalPart(cursor, /^[eE]$/, true);
}

function scanLiteral(cursor: Cursor, word: string): Failure | undefined {
  for (const expected of word) {
    const failure = take(cursor, (char) => char === expected);
    if (failure !== undefined) {
      return failure;
    }
  }
  return undefined;
}

/** After the backslash of an escape: one of the single-character escapes, or "u" and 4 hex digits. */
function scanEscape(cursor: Cursor): Failure | undefined {
  if (cursor.text[cursor.pos] !== "u") {
    return take(cursor, (char) => char !== undefined && ESCAPES.has(char));
  }
  cursor.pos += 1;
  for (let count = 0; count < 4; count += 1) {
    const failure = take(cursor, isHex);
    if (failure !== undefined) {
      return failure;
    }
  }
  return undefined;
}

/** From the opening quote to the closing quote. A raw control character is not allowed. */
function scanString(cursor: Cursor): Failure | undefined {
  cursor.pos += 1;
  for (;;) {
    const char = cursor.text[cursor.pos];
    if (char === undefined || char < " ") {
      return stop(cursor);
    }
    cursor.pos += 1;
    if (char === '"') {
      return undefined;
    }
    const failure = char === "\\" ? scanEscape(cursor) : undefined;
    if (failure !== undefined) {
      return failure;
    }
  }
}

/** A string, number, true, false or null. Returns a failure, or undefined when it was read. */
function scanScalar(cursor: Cursor): Failure | undefined {
  const char = cursor.text[cursor.pos];
  if (char === '"') {
    return scanString(cursor);
  }
  if (char === "-" || isDigit(char)) {
    return scanNumber(cursor);
  }
  const word = char === undefined ? undefined : LITERALS[char];
  return word === undefined ? stop(cursor) : scanLiteral(cursor, word);
}

/** A value is read. In a container the next thing is "," or the close, else the input ends. */
function afterValue(cursor: Cursor, stack: Container[]): Expect | Failure {
  const top = stack.at(-1);
  const char = cursor.text[cursor.pos];
  if (top === undefined) {
    return char === undefined ? "done" : { kind: "extra", index: cursor.pos };
  }
  if (char === ",") {
    cursor.pos += 1;
    return top === "array" ? "value" : "key";
  }
  if (char === (top === "array" ? "]" : "}")) {
    cursor.pos += 1;
    stack.pop();
    return "next";
  }
  return stop(cursor);
}

const HANDLERS: Readonly<Record<Exclude<Expect, "done">, Handler>> = {
  value: (cursor, stack) => {
    const char = cursor.text[cursor.pos];
    if (char === "{" || char === "[") {
      cursor.pos += 1;
      stack.push(char === "{" ? "object" : "array");
      return char === "{" ? "keyOrClose" : "valueOrClose";
    }
    return scanScalar(cursor) ?? "next";
  },
  valueOrClose: (cursor, stack) => {
    if (cursor.text[cursor.pos] === "]") {
      cursor.pos += 1;
      stack.pop();
      return "next";
    }
    return HANDLERS.value(cursor, stack);
  },
  keyOrClose: (cursor, stack) => {
    if (cursor.text[cursor.pos] === "}") {
      cursor.pos += 1;
      stack.pop();
      return "next";
    }
    return HANDLERS.key(cursor, stack);
  },
  key: (cursor) =>
    cursor.text[cursor.pos] === '"' ? (scanString(cursor) ?? "colon") : stop(cursor),
  colon: (cursor) => take(cursor, (char) => char === ":") ?? "value",
  next: afterValue,
};

/** Reads the whole text. Returns where it went wrong, or undefined for a JSON document. */
function findFailure(text: string): Failure | undefined {
  const cursor: Cursor = { text, pos: 0 };
  const stack: Container[] = [];
  let expect: Expect = "value";
  while (expect !== "done") {
    skipWhiteSpace(cursor);
    const step: Expect | Failure = HANDLERS[expect](cursor, stack);
    if (typeof step === "object") {
      return step;
    }
    expect = step;
  }
  return undefined;
}

/** The line (from 1) and the column (from 1, in characters) of an index of the text. */
function locate(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (const char of text.slice(0, index)) {
    if (char === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

/** The three reasons a text is not valid JSON. Each carries only numbers. */
function describeFailure(text: string, failure: Failure): string {
  const { line, column } = locate(text, failure.index);
  if (failure.kind === "end") {
    return `unexpected end of input at line ${line}`;
  }
  if (failure.kind === "character") {
    return `unexpected character at line ${line}, column ${column}`;
  }
  return `extra data after the JSON value at line ${line}, column ${column}`;
}

/** Checks a reply of the given kind. A text reply is always accepted. */
export function checkReply(kind: "text" | "json", body: string): ReplyCheck {
  if (kind === "text") {
    return { ok: true };
  }
  const failure = findFailure(body);
  return failure === undefined
    ? { ok: true }
    : { ok: false, reason: describeFailure(body, failure) };
}
