import type { ReadResult, ReplyReader } from "../../src/answer/answer-console.js";

/**
 * One step of a script.
 * - a string: the person typed this reply and ended the input
 * - "EOF": the person pressed the end-of-input key without typing anything
 * - "INTERRUPT": the person pressed Ctrl+C
 * - a function: runs first (to change the world) and then gives one of the above
 */
export type Step = string | "EOF" | "INTERRUPT" | (() => string);

/** A reply reader that follows a script instead of a terminal. */
export class ScriptedReader implements ReplyReader {
  calls = 0;
  private readonly steps: Step[];

  constructor(steps: Step[]) {
    this.steps = [...steps];
  }

  async readReply(signal: AbortSignal): Promise<ReadResult> {
    this.calls += 1;
    const next = this.steps.shift();
    if (next === undefined) {
      // The script is over: behave like a person who never answers, until Ctrl+C.
      await new Promise<void>((resolve) => {
        if (signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return { kind: "interrupted" };
    }
    const step = typeof next === "function" ? next() : next;
    if (step === "INTERRUPT") {
      return { kind: "interrupted" };
    }
    if (step === "EOF") {
      return { kind: "reply", text: "", gotInput: false };
    }
    return { kind: "reply", text: step, gotInput: true };
  }
}
