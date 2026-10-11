import { readdir, readFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { afterEach } from "vitest";
import { AnswerConsole, type ReplyReader } from "../../src/answer/answer-console.js";
import { ExchangeBroker } from "../../src/broker/exchange-broker.js";
import { main } from "../../src/cli.js";
import { type Clock, systemClock } from "../../src/clock.js";
import { POLL_INTERVAL_MS } from "../../src/config.js";
import { Logger, Screen } from "../../src/log.js";
import { createReplyFile, serializeFile } from "../../src/model.js";
import { ExchangeStore, type StoreFs } from "../../src/store/exchange-store.js";
import { makeTempDir } from "./fs.js";
import { makeIo, waitFor } from "./io.js";

const cleanups: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0, cleanups.length).map((cleanup) => cleanup()));
});

export interface RunningServe {
  port: number;
  baseUrl: string;
  storageDir: string;
  stdout: () => string;
  stderr: () => string;
  stop: () => Promise<number>;
}

export interface ServeOptions {
  storageDir?: string;
  storeFs?: StoreFs;
  args?: string[];
  clock?: Clock;
  /**
   * Gives serve no test override of the port and the storage directory: the words in `args`
   * and the variables in `env` decide, as for a real start.
   */
  raw?: boolean;
  /** The environment variables of serve. Only with `raw`. */
  env?: Record<string, string>;
}

/**
 * Starts the real `imbehind serve` in this process, on a free port and a temporary directory.
 * `args` are the words after `serve`, such as `--timeout 1`. `clock` replaces the clock of serve.
 */
export async function startServe(options: ServeOptions = {}): Promise<RunningServe> {
  const raw = options.raw === true;
  const t = makeIo(
    options.env === undefined
      ? undefined
      : { platform: "linux", env: options.env, homedir: "/home/alice" },
  );
  const given = options.storageDir ?? (raw ? undefined : await makeTempDir());
  const exit = main(["serve", ...(options.args ?? [])], t.io, {
    settings: raw ? undefined : { port: 0, storageDir: given },
    storeFs: options.storeFs,
    clock: options.clock,
  });
  const stop = async (): Promise<number> => {
    t.interrupt();
    return exit;
  };
  cleanups.push(stop);
  await Promise.race([waitFor(() => t.out.text().includes("Listening on")), exit]);
  const match = /Listening on http:\/\/(\[[^\]]+\]|[0-9.]+):(\d+) \(storage: (.*)\)/.exec(
    t.out.text(),
  );
  if (match === null) {
    throw new Error(`serve did not start: ${t.err.text()}`);
  }
  const port = Number(match[2]);
  return {
    port,
    baseUrl: `http://${match[1]}:${port}`,
    storageDir: given ?? (match[3] as string),
    stdout: () => t.out.text(),
    stderr: () => t.err.text(),
    stop,
  };
}

/** A port that nothing listens on now. It could be taken before it is used, but rarely is. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

export interface RunningAnswer {
  stdout: () => string;
  stderr: () => string;
  /** Presses Ctrl+C and returns the exit code. */
  stop: () => Promise<number>;
  done: Promise<number>;
}

/** Runs the answer screen on the real storage directory with the given reader. */
export function startAnswer(
  storageDir: string,
  reader: ReplyReader,
  options: { pollIntervalMs?: number; storeFs?: StoreFs } = {},
): RunningAnswer {
  const t = makeIo();
  const pollIntervalMs = options.pollIntervalMs ?? POLL_INTERVAL_MS;
  const broker = new ExchangeBroker({
    store: new ExchangeStore({ rootDir: storageDir, fs: options.storeFs }),
    clock: systemClock,
    pollIntervalMs,
  });
  const answer = new AnswerConsole({
    broker,
    screen: new Screen(t.out.stream),
    errorScreen: new Screen(t.err.stream),
    logger: new Logger({ out: t.out.stream, err: t.err.stream, clock: systemClock }),
    clock: systemClock,
    reader,
    pollIntervalMs,
    storageDir,
    // The serve that these tests started holds the lock. The check itself has its own tests.
    checkServe: async () => ({ kind: "running" }),
  });
  const controller = new AbortController();
  const done = answer.run(controller.signal);
  const stop = async (): Promise<number> => {
    controller.abort();
    return done;
  };
  cleanups.push(stop);
  return { stdout: () => t.out.text(), stderr: () => t.err.text(), stop, done };
}

/** POSTs a Chat Completions request with fetch and returns the status and JSON body. */
export async function postChat(
  baseUrl: string,
  content: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "whatever", messages: [{ role: "user", content }], ...extra }),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

/** POSTs a Chat Completions request and returns the status, the content type and the raw text. */
export async function postChatRaw(
  baseUrl: string,
  content: string,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; contentType: string; text: string }> {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "whatever", messages: [{ role: "user", content }], ...extra }),
  });
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    text: await response.text(),
  };
}

/** The states of the stored requests, in id order, read from the files. */
export async function storedStates(storageDir: string): Promise<string[]> {
  const requests = path.join(storageDir, "requests");
  const ids = (await readdir(requests)).filter((name) => !name.startsWith(".")).sort();
  return Promise.all(
    ids.map(async (id) => {
      const text = await readFile(path.join(requests, id, "state.json"), "utf8");
      return (JSON.parse(text) as { state: string }).state;
    }),
  );
}

/** Plays the human: answers every waiting request with "answer to <question>". */
export async function answerEverything(storageDir: string, count: number): Promise<void> {
  const store = new ExchangeStore({ rootDir: storageDir });
  const done = new Set<string>();
  const writtenAt = new Date().toISOString();
  while (done.size < count) {
    for (const id of await store.listIds()) {
      const request = await store.readRequest(id);
      if (done.has(id) || request.kind !== "ok") {
        continue;
      }
      const question = request.value.conversation[0]?.content ?? "";
      await store.placeReply(
        id,
        serializeFile(createReplyFile(`answer to ${question}`, writtenAt)),
      );
      done.add(id);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
