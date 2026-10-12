import type {
  LineResult,
  ReadResult,
  ReplyReader,
  StdinRead,
} from "../../src/answer/answer-console.js";

/**
 * One step of a script.
 * - a string: the person typed this reply and ended the input (or, when a question is asked,
 *   answered it with this line)
 * - "EOF": the person pressed the end-of-input key without typing anything
 * - "INTERRUPT": the person pressed Ctrl+C
 * - "WAIT": the person types nothing until the screen stops the reading
 * - a function: runs first (to change the world) and then gives one of the above
 */
export type Step = string | "EOF" | "INTERRUPT" | "WAIT" | (() => string);

/**
 * One step of the script for standard input.
 * - a string: the whole input, as text
 * - a result: what the reader gives back, such as `{ kind: "not-utf8" }`
 * - "WAIT": the input never ends, until the screen stops the reading
 * - a function: runs first (to change the world) and then gives one of the above
 */
export type StdinStep = string | StdinRead | "WAIT" | (() => string | StdinRead | "WAIT");

/** A reply reader that follows a script instead of a terminal. */
export class ScriptedReader implements ReplyReader {
  calls = 0;
  /** The number of times the screen read the whole standard input. */
  stdinCalls = 0;
  /** The questions the screen asked with `readLine`. */
  readonly asked: string[] = [];
  private readonly steps: Step[];
  private readonly stdinSteps: StdinStep[];
  private readonly onNotify: (text: string) => void;

  constructor(
    steps: Step[],
    onNotify: (text: string) => void = () => {},
    stdinSteps: StdinStep[] = [],
  ) {
    this.steps = [...steps];
    this.stdinSteps = [...stdinSteps];
    this.onNotify = onNotify;
  }

  notify(text: string): void {
    this.onNotify(text);
  }

  async readReply(signal: AbortSignal): Promise<ReadResult> {
    this.calls += 1;
    const step = await this.next(signal);
    if (step === "INTERRUPT" || step === "WAIT") {
      return { kind: "interrupted" };
    }
    if (step === "EOF") {
      return { kind: "reply", text: "", gotInput: false };
    }
    return { kind: "reply", text: step, gotInput: true };
  }

  async readLine(prompt: string, signal: AbortSignal): Promise<LineResult> {
    this.asked.push(prompt);
    const step = await this.next(signal);
    if (step === "INTERRUPT" || step === "WAIT") {
      return { kind: "interrupted" };
    }
    return step === "EOF" ? { kind: "end" } : { kind: "line", text: step };
  }

  async readStdin(signal: AbortSignal): Promise<StdinRead> {
    this.stdinCalls += 1;
    const step = this.stdinSteps.shift();
    const value = typeof step === "function" ? step() : step;
    if (value === undefined || value === "WAIT") {
      await untilAborted(signal);
      return { kind: "interrupted" };
    }
    return typeof value === "string" ? { kind: "text", text: value } : value;
  }

  /**
   * The next step, with a function step run. "WAIT", and the end of the script, behave like a
   * person who never answers: they last until the signal aborts, then give "WAIT".
   */
  private async next(signal: AbortSignal): Promise<string> {
    const step = this.steps.shift();
    const value = typeof step === "function" ? step() : step;
    if (value !== undefined && value !== "WAIT") {
      return value;
    }
    await untilAborted(signal);
    return "WAIT";
  }
}

function untilAborted(signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}
