import type { LineResult, ReadResult, ReplyReader } from "../../src/answer/answer-console.js";

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

/** A reply reader that follows a script instead of a terminal. */
export class ScriptedReader implements ReplyReader {
  calls = 0;
  /** The questions the screen asked with `readLine`. */
  readonly asked: string[] = [];
  private readonly steps: Step[];
  private readonly onNotify: (text: string) => void;

  constructor(steps: Step[], onNotify: (text: string) => void = () => {}) {
    this.steps = [...steps];
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
    await new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      signal.addEventListener("abort", () => resolve(), { once: true });
    });
    return "WAIT";
  }
}
