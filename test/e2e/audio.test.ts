import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { MAX_FILE_BYTES } from "../../src/model.js";
import { audioBytes, audioSizesAtLimit } from "../helpers/audio.js";
import { makeTempDir } from "../helpers/fs.js";
import { waitFor } from "../helpers/io.js";
import { ScriptedReader } from "../helpers/scripted-reader.js";
import { startAnswer, startServe } from "../helpers/system.js";

const TRANSCRIPT = "secret transcript";
const ASKING = {
  modalities: ["text", "audio"] as ("text" | "audio")[],
  audio: { voice: "alloy", format: "wav" } as const,
};

function clientFor(baseUrl: string): OpenAI {
  return new OpenAI({
    apiKey: "any-key-is-accepted",
    baseURL: `${baseUrl}/v1`,
    maxRetries: 0,
    timeout: 20_000,
  });
}

/** Writes a wav-looking file under a folder whose name has a space and an upper-case extension. */
async function writeWav(size: number): Promise<{ file: string; data: string }> {
  const dir = path.join(await makeTempDir(), "my sounds");
  await mkdir(dir);
  const file = path.join(dir, "Voice Note.WAV");
  const bytes = audioBytes("wav", size - audioBytes("wav", 0).length);
  await writeFile(file, bytes);
  return { file, data: Buffer.from(bytes).toString("base64") };
}

interface CurlResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs the curl program. The body goes through standard input so no shell quoting is needed. */
function curl(args: string[], input: string): Promise<CurlResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

function curlChat(baseUrl: string, body: unknown): Promise<CurlResult> {
  return curl(
    [
      "--silent",
      "--show-error",
      "--max-time",
      "20",
      "-X",
      "POST",
      `${baseUrl}/v1/chat/completions`,
      "-H",
      "Content-Type: application/json",
      "--data-binary",
      "@-",
    ],
    JSON.stringify(body),
  );
}

describe("a round trip with an audio file and the official OpenAI SDK (NFR16)", () => {
  it("gives the SDK message.audio with the data of the file and the transcript", async () => {
    const serve = await startServe();
    const { file, data } = await writeWav(3000);
    const answer = startAnswer(
      serve.storageDir,
      new ScriptedReader([`${TRANSCRIPT}\n@file ${file}`]),
    );

    const completion = await clientFor(serve.baseUrl).chat.completions.create({
      model: "whatever",
      messages: [{ role: "user", content: "Say hi" }],
      ...ASKING,
    });

    const choice = completion.choices[0];
    expect(choice?.finish_reason).toBe("stop");
    expect(choice?.message.role).toBe("assistant");
    expect(choice?.message.content).toBeNull();
    expect(choice?.message.audio).toEqual({
      id: `audio_${completion.id.slice("chatcmpl-".length)}`,
      data,
      expires_at: completion.created + 3600,
      transcript: TRANSCRIPT,
    });
    await waitFor(() => answer.stdout().includes("Sent."));
    // NFR17: nothing of the audio, the transcript or the path reaches the output of serve.
    const output = serve.stdout() + serve.stderr();
    expect(output).not.toContain(data);
    expect(output).not.toContain(TRANSCRIPT);
    expect(output).not.toContain(path.basename(file));
  });

  it("gives the SDK the same audio, transcript, id and expires_at when it streams", async () => {
    const serve = await startServe();
    const { file, data } = await writeWav(5000);
    const answer = startAnswer(
      serve.storageDir,
      new ScriptedReader([`${TRANSCRIPT}\n@file ${file}`]),
    );

    const stream = clientFor(serve.baseUrl).chat.completions.stream({
      model: "whatever",
      messages: [{ role: "user", content: "Say hi" }],
      stream_options: { include_usage: true },
      ...ASKING,
    });
    const completion = await stream.finalChatCompletion();

    const choice = completion.choices[0];
    expect(choice?.finish_reason).toBe("stop");
    expect(choice?.message.content).toBeNull();
    expect(choice?.message.audio).toEqual({
      id: `audio_${completion.id.slice("chatcmpl-".length)}`,
      data,
      expires_at: completion.created + 3600,
      transcript: TRANSCRIPT,
    });
    await waitFor(() => answer.stdout().includes("Sent."));
  });

  it("sends the chunks in the order of the specification when read chunk by chunk", async () => {
    const serve = await startServe();
    const { file, data } = await writeWav(1200);
    startAnswer(serve.storageDir, new ScriptedReader([`@file ${file}`]));

    const stream = await clientFor(serve.baseUrl).chat.completions.create({
      model: "whatever",
      messages: [{ role: "user", content: "Say hi" }],
      stream: true,
      stream_options: { include_usage: true },
      ...ASKING,
    });
    const chunks = [];
    for await (const chunk of stream) {
      chunks.push(chunk);
    }

    const deltas = chunks.map((chunk) => chunk.choices[0]?.delta as Record<string, unknown>);
    const created = chunks[0]?.created ?? 0;
    expect(deltas.slice(0, 4)).toEqual([
      { role: "assistant", content: null },
      expect.objectContaining({ audio: expect.objectContaining({ data, transcript: "" }) }),
      {},
      { audio: { expires_at: created + 3600 } },
    ]);
    expect(chunks.map((chunk) => chunk.choices[0]?.finish_reason)).toEqual([
      null,
      null,
      "stop",
      null,
      undefined,
    ]);
    expect(chunks.at(-1)?.choices).toEqual([]);
    expect(chunks.at(-1)?.usage).toEqual({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });
  });

  it("takes the id of an earlier audio reply back in a later request, and shows it (FR17)", async () => {
    const serve = await startServe();
    const { file } = await writeWav(800);
    const answer = startAnswer(
      serve.storageDir,
      new ScriptedReader([`Hi\n@file ${file}`, "Fine, thanks"]),
    );
    const client = clientFor(serve.baseUrl);
    const first = await client.chat.completions.create({
      model: "whatever",
      messages: [{ role: "user", content: "Say hi" }],
      ...ASKING,
    });
    const audioId = first.choices[0]?.message.audio?.id ?? "";
    expect(audioId).not.toBe("");

    const second = await client.chat.completions.create({
      model: "whatever",
      messages: [
        { role: "user", content: "Say hi" },
        { role: "assistant", content: null, audio: { id: audioId } },
        { role: "user", content: "How are you?" },
      ],
    });

    expect(second.choices[0]?.message.content).toBe("Fine, thanks");
    expect(answer.stdout()).toContain(`  audio: ${audioId}`);
  });
});

describe("a round trip with an audio file and curl (NFR16)", () => {
  it("gets the same response body without streaming", async () => {
    const serve = await startServe();
    const { file, data } = await writeWav(2000);
    startAnswer(serve.storageDir, new ScriptedReader([`Hello\n@file ${file}`]));

    const result = await curlChat(serve.baseUrl, {
      model: "whatever",
      messages: [{ role: "user", content: "Say hi" }],
      ...ASKING,
    });

    expect(result.code).toBe(0);
    const body = JSON.parse(result.stdout) as {
      created: number;
      choices: { message: Record<string, unknown>; finish_reason: string }[];
    };
    expect(body.choices[0]).toEqual({
      index: 0,
      message: {
        role: "assistant",
        content: null,
        audio: {
          id: expect.stringMatching(/^audio_/),
          data,
          expires_at: body.created + 3600,
          transcript: "Hello",
        },
      },
      finish_reason: "stop",
    });
  });

  it("gets the events of a stream in order, ending with [DONE]", async () => {
    const serve = await startServe();
    const { file, data } = await writeWav(2000);
    startAnswer(serve.storageDir, new ScriptedReader([`Hello\n@file ${file}`]));

    const result = await curlChat(serve.baseUrl, {
      model: "whatever",
      messages: [{ role: "user", content: "Say hi" }],
      stream: true,
      ...ASKING,
    });

    expect(result.code).toBe(0);
    const events = result.stdout
      .trim()
      .split("\n\n")
      .map((block) => block.slice("data: ".length));
    expect(events.at(-1)).toBe("[DONE]");
    const deltas = events
      .slice(0, -1)
      .map((event) => (JSON.parse(event) as { choices: { delta: unknown }[] }).choices[0]?.delta);
    expect(deltas).toEqual([
      { role: "assistant", content: null },
      { audio: { id: expect.stringMatching(/^audio_/), data, transcript: "Hello" } },
      {},
      { audio: { expires_at: expect.any(Number) } },
    ]);
  });
});

describe("the limit of 10 MB for an audio reply (NFR18)", () => {
  it("sends the largest file whose reply file fits and returns it whole to the SDK", async () => {
    const serve = await startServe();
    const { fits } = audioSizesAtLimit(MAX_FILE_BYTES);
    const { file, data } = await writeWav(fits);
    const answer = startAnswer(serve.storageDir, new ScriptedReader([`@file ${file}`]));

    const completion = await clientFor(serve.baseUrl).chat.completions.create({
      model: "whatever",
      messages: [{ role: "user", content: "Say hi" }],
      ...ASKING,
    });

    expect(completion.choices[0]?.message.audio?.data).toBe(data);
    await waitFor(() => answer.stdout().includes("Sent."));
  });

  it("does not send a file one byte over, tells so, and leaves the request waiting", async () => {
    const serve = await startServe();
    const { over } = audioSizesAtLimit(MAX_FILE_BYTES);
    const { file } = await writeWav(over);
    const answer = startAnswer(serve.storageDir, new ScriptedReader([`@file ${file}`]));
    const pending = clientFor(serve.baseUrl)
      .chat.completions.create({
        model: "whatever",
        messages: [{ role: "user", content: "Say hi" }],
        ...ASKING,
      })
      .catch(() => undefined);

    await waitFor(() => answer.stdout().includes("Not sent: your reply is larger than 10 MB."));
    expect(answer.stdout()).toContain("Type your reply again.");
    expect(await answer.stop()).toBe(130);
    await serve.stop();
    await pending;
  });
});
