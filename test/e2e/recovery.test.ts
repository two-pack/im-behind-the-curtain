import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ReadResult, ReplyReader } from "../../src/answer/answer-console.js";
import { nodeFs, type StoreFs } from "../../src/store/exchange-store.js";
import { errno } from "../helpers/fs.js";
import { waitFor } from "../helpers/io.js";
import { ScriptedReader } from "../helpers/scripted-reader.js";
import { postChat, startAnswer, startServe } from "../helpers/system.js";

/** A reader that waits at a barrier, so two answers can type at the same moment. */
class BarrierReader implements ReplyReader {
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
}

async function requestFolderFiles(storageDir: string): Promise<string[]> {
  const requests = path.join(storageDir, "requests");
  const [id] = await readdir(requests);
  return (await readdir(path.join(requests, id ?? ""))).sort();
}

describe("recovery after a stop between two steps (NFR13.3, NFR13.9)", () => {
  it("accepts the reply on the next poll when removing reply.json failed after the link", async () => {
    let failed = 0;
    const storeFs: StoreFs = {
      ...nodeFs,
      unlink: (file) => {
        if (file.endsWith("reply.json") && failed === 0) {
          failed += 1;
          return Promise.reject(errno("EBUSY"));
        }
        return nodeFs.unlink(file);
      },
    };
    const serve = await startServe({ storeFs });
    startAnswer(serve.storageDir, new ScriptedReader(["Hi"]));

    const reply = await postChat(serve.baseUrl, "Hello");

    expect(failed).toBe(1);
    expect(reply.status).toBe(200);
    expect((reply.body.choices as { message: { content: string } }[])[0]?.message.content).toBe(
      "Hi",
    );
    expect(await requestFolderFiles(serve.storageDir)).toEqual([
      "reply.accepted.json",
      "request.json",
      "state.json",
    ]);
    expect(serve.stdout()).toMatch(/ error {6}[0-9a-f]{6} {2}failed\n/);
    expect(serve.stdout()).toMatch(/ replied {4}[0-9a-f]{6}\n/);
  });

  it("recovers when writing state.json failed after the reply was accepted", async () => {
    let failed = 0;
    const storeFs: StoreFs = {
      ...nodeFs,
      rename: (from, to) => {
        if (to.endsWith("state.json") && failed === 0) {
          failed += 1;
          return Promise.reject(errno("EBUSY"));
        }
        return nodeFs.rename(from, to);
      },
    };
    const serve = await startServe({ storeFs });
    startAnswer(serve.storageDir, new ScriptedReader(["Hi"]));

    const reply = await postChat(serve.baseUrl, "Hello");

    expect(failed).toBe(1);
    expect(reply.status).toBe(200);
    expect(serve.stdout()).toMatch(/ error {6}[0-9a-f]{6} {2}rename failed\n/);
  });
});

describe("two answers on one request (NFR13.6)", () => {
  it("uses one reply, and the other answer is told it was not sent", async () => {
    const serve = await startServe();
    let open: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const readerA = new BarrierReader("from A", gate);
    const readerB = new BarrierReader("from B", gate);
    const answerA = startAnswer(serve.storageDir, readerA);
    const answerB = startAnswer(serve.storageDir, readerB);

    const pending = postChat(serve.baseUrl, "Hello");
    await waitFor(() => readerA.arrived && readerB.arrived);
    open();
    const reply = await pending;

    const content = (reply.body.choices as { message: { content: string } }[])[0]?.message.content;
    await waitFor(
      () =>
        (answerA.stdout() + answerB.stdout()).includes("Sent.") &&
        (answerA.stdout() + answerB.stdout()).includes("Not sent:"),
    );
    const winner = answerA.stdout().includes("Sent.") ? "from A" : "from B";
    const loser = winner === "from A" ? answerB : answerA;
    expect(content).toBe(winner);
    expect(loser.stdout()).toContain(
      "Not sent: this request was already answered in another window.",
    );
    expect(loser.stdout()).not.toMatch(/^Sent\.$/m);
  });
});

describe("a failure while writing the reply (NFR13.5)", () => {
  it("shows an Error line, shows the request again, and sends the second try", async () => {
    const serve = await startServe();
    let failed = 0;
    const storeFs: StoreFs = {
      ...nodeFs,
      link: (existing, target) => {
        if (target.endsWith("reply.json") && failed === 0) {
          failed += 1;
          return Promise.reject(errno("EIO"));
        }
        return nodeFs.link(existing, target);
      },
    };
    const answer = startAnswer(serve.storageDir, new ScriptedReader(["first", "second"]), {
      storeFs,
    });

    const reply = await postChat(serve.baseUrl, "Hello");

    expect((reply.body.choices as { message: { content: string } }[])[0]?.message.content).toBe(
      "second",
    );
    expect(failed).toBe(1);
    expect(answer.stderr()).toBe("Error: could not write the reply. input/output error.\n");
    expect(answer.stdout().split("--- Request 1 of 1").length - 1).toBe(2);
    await waitFor(() => answer.stdout().includes("Sent."));
  });
});
