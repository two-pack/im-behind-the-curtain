import type { LineResult, ReadResult, ReplyReader } from "../../src/answer/answer-console.js";

/** A reader that waits at a barrier, so two answers can type at the same moment. */
export class BarrierReader implements ReplyReader {
  arrived = false;
  private readonly text: string;
  private readonly gate: Promise<void>;

  constructor(text: string, gate: Promise<void>) {
    this.text = text;
    this.gate = gate;
  }

  async readReply(): Promise<ReadResult> {
    this.arrived = true;
    await this.gate;
    return { kind: "reply", text: this.text, gotInput: true };
  }

  async readLine(): Promise<LineResult> {
    return { kind: "end" };
  }

  notify(): void {}
}
