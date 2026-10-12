import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRequestFile, createStateFile } from "../../src/model.js";
import { ExchangeStore } from "../../src/store/exchange-store.js";
import { makeTempDir } from "../helpers/fs.js";
import { waitFor } from "../helpers/io.js";
import { placeRunningLock } from "../helpers/lock.js";
import { type Running, runNode } from "../helpers/program.js";
import { freePort, startServe, storedStates, waitForRequestId } from "../helpers/system.js";

const BIN = path.resolve("dist", "bin.js");

/** How long the answer program gets to choose its request before the client goes away. */
const SETTLE_MS = 5000;
/** How long the answer program gets to end after the client went away. */
const EXIT_LIMIT_MS = 10000;

/** Environment that puts the storage directory under a temporary folder on every OS. */
function envFor(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_DATA_HOME: path.join(home, "xdg"),
    LOCALAPPDATA: path.join(home, "local"),
  };
}

/** The storage directory the program picks for this environment on this OS. */
function storageFor(home: string): string {
  if (process.platform === "win32") {
    return path.join(home, "local", "imbehind");
  }
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "imbehind");
  }
  return path.join(home, "xdg", "imbehind");
}

function run(args: string[], env: NodeJS.ProcessEnv): Running {
  return runNode(BIN, args, env);
}

async function addWaitingRequest(storageDir: string): Promise<string> {
  const store = new ExchangeStore({ rootDir: storageDir });
  await store.prepare();
  const id = "20261009T140512123Z-a1b2c3";
  const now = new Date().toISOString();
  await store.createRequest(
    createRequestFile(id, now, {
      format: "chat.completions",
      model: "whatever",
      replyKind: "text",
      requiredShape: null,
      stream: false,
      includeUsage: false,
      conversation: [{ role: "user", content: "Hello from the process test" }],
      originalRequest: { model: "whatever" },
    }),
    createStateFile(id, "waiting", now, null),
  );
  // A running serve would hold the lock; `answer` does not start without it.
  await placeRunningLock(storageDir);
  return id;
}

describe("the real program (dist/bin.js)", () => {
  it("fails with an Error line and exit code 2 when no command is given", async () => {
    const program = run([], envFor(await makeTempDir()));
    expect(await program.exit).toBe(2);
    expect(program.stderr()).toBe("Error: usage: imbehind serve | answer | path\n");
    expect(program.stdout()).toBe("");
  });

  it("prints the storage directory with path, and makes nothing, exit code 0", async () => {
    const home = await makeTempDir();
    const program = run(["path"], envFor(home));
    expect(await program.exit).toBe(0);
    expect(program.stdout()).toBe(`${storageFor(home)}\n`);
    expect(program.stderr()).toBe("");
    await expect(stat(storageFor(home))).rejects.toThrow();
  });

  it("follows --dir and IMBEHIND_DIR with path", async () => {
    const home = await makeTempDir();
    const target = path.join(home, "chosen");
    const byOption = run(["path", "--dir", target], envFor(home));
    expect(await byOption.exit).toBe(0);
    expect(byOption.stdout()).toBe(`${target}\n`);
    const byEnvironment = run(["path"], { ...envFor(home), IMBEHIND_DIR: target });
    expect(await byEnvironment.exit).toBe(0);
    expect(byEnvironment.stdout()).toBe(`${target}\n`);
  });

  // A killed serve cannot return its lock. The next serve must find it stale by itself.
  it("starts a serve in the directory of a serve that was killed, without any manual step", async () => {
    const dir = await makeTempDir();
    const environment = (port: number): NodeJS.ProcessEnv => ({
      ...process.env,
      IMBEHIND_DIR: dir,
      IMBEHIND_PORT: String(port),
    });
    const first = run(["serve"], environment(await freePort()));
    await waitFor(() => first.stdout().includes("Listening on"), 10_000);
    first.child.kill("SIGKILL");
    await first.exit;
    expect(JSON.parse(await readFile(path.join(dir, "serve.lock"), "utf8")).processId).toBe(
      first.child.pid,
    );

    const second = run(["serve"], environment(await freePort()));
    await waitFor(() => second.stdout().includes("Listening on"), 10_000);
    expect(second.stderr()).toBe("");
    expect(JSON.parse(await readFile(path.join(dir, "serve.lock"), "utf8")).processId).toBe(
      second.child.pid,
    );
    second.child.kill(process.platform === "win32" ? "SIGKILL" : "SIGINT");
    await second.exit;
  });

  it("stops answer with the two lines of A-10 and exit code 1 when no serve runs, and creates nothing", async () => {
    const home = await makeTempDir();
    const program = run(["answer"], envFor(home));
    expect(await program.exit).toBe(1);
    expect(program.stderr()).toBe(
      `Error: imbehind serve is not running for ${storageFor(home)}.\nStart it with: imbehind serve\n`,
    );
    expect(program.stdout()).toBe("");
    await expect(stat(storageFor(home))).rejects.toThrow();
  });

  // Skipped on Windows on purpose. There, child.kill("SIGINT") ends the child process at once
  // and no SIGINT handler runs, so this test cannot observe exit code 130 or the clean
  // shutdown. The Windows exit behavior is checked in a different way in the CI stage.
  it.skipIf(process.platform === "win32")(
    "reads a reply from standard input, puts it next to the request, shows nothing, and exits 130 on Ctrl+C",
    async () => {
      const home = await makeTempDir();
      const storageDir = storageFor(home);
      const id = await addWaitingRequest(storageDir);
      const program = run(["answer"], envFor(home));
      program.child.stdin?.end("Hi from stdin\r\n");

      const replyFile = path.join(storageDir, "requests", id, "reply.json");
      await waitFor(async () => (await readFile(replyFile, "utf8").catch(() => "")) !== "", 10_000);
      expect(JSON.parse(await readFile(replyFile, "utf8"))).toMatchObject({
        formatVersion: 1,
        kind: "text",
        body: "Hi from stdin",
        source: "imbehind-answer",
      });
      program.child.kill("SIGINT");
      expect(await program.exit).toBe(130);
      expect(program.stdout()).toBe("");
      expect(program.stderr()).toBe("");
    },
  );

  describe("imbehind answer with standard input that is not a terminal", () => {
    const answerEnv = (storageDir: string): NodeJS.ProcessEnv => ({
      ...process.env,
      IMBEHIND_DIR: storageDir,
    });

    interface ChatReply {
      choices: { message: { content: string } }[];
    }

    function chatInit(signal?: AbortSignal): RequestInit {
      return {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "Hello" }] }),
        signal,
      };
    }

    it("replies to the only waiting request, prints one line and exits 0", async () => {
      const serve = await startServe();
      const program = run(["answer"], answerEnv(serve.storageDir));
      program.child.stdin?.end("Hi\n");
      const client = fetch(`${serve.baseUrl}/v1/chat/completions`, chatInit());
      expect(await program.exit).toBe(0);
      const id = await waitForRequestId(serve.storageDir);
      expect(program.stdout()).toBe(`Sent reply to request ${id.slice(-6)}.\n`);
      expect(program.stderr()).toBe("");
      const body = (await (await client).json()) as ChatReply;
      expect(body.choices[0]?.message.content).toBe("Hi");
    });

    it("replies to the first of two waiting requests only", async () => {
      const serve = await startServe();
      const first = fetch(`${serve.baseUrl}/v1/chat/completions`, chatInit());
      const firstId = await waitForRequestId(serve.storageDir, 0);
      const controller = new AbortController();
      const second = fetch(
        `${serve.baseUrl}/v1/chat/completions`,
        chatInit(controller.signal),
      ).catch(() => undefined);
      await waitForRequestId(serve.storageDir, 1);

      const program = run(["answer"], answerEnv(serve.storageDir));
      program.child.stdin?.end("Hi\n");
      expect(await program.exit).toBe(0);
      expect(program.stdout()).toBe(`Sent reply to request ${firstId.slice(-6)}.\n`);
      expect(await storedStates(serve.storageDir)).toEqual(["replied", "waiting"]);
      expect(((await (await first).json()) as ChatReply).choices[0]?.message.content).toBe("Hi");
      controller.abort();
      await second;
    });

    it("ends with exit 1 for an empty input and leaves the request waiting", async () => {
      const home = await makeTempDir();
      const storageDir = storageFor(home);
      const id = await addWaitingRequest(storageDir);
      const program = run(["answer"], envFor(home));
      program.child.stdin?.end();
      expect(await program.exit).toBe(1);
      expect(program.stderr()).toBe(
        "Error: the reply is empty. Nothing was sent; the request is still waiting.\n",
      );
      expect(program.stdout()).toBe("");
      const files = await readdir(path.join(storageDir, "requests", id));
      expect(files.sort()).toEqual(["request.json", "state.json"]);
    });

    it("ends with exit 1 for an input over 10 MB and leaves the request waiting", async () => {
      const home = await makeTempDir();
      const storageDir = storageFor(home);
      const id = await addWaitingRequest(storageDir);
      const program = run(["answer"], envFor(home));
      program.child.stdin?.on("error", () => {});
      program.child.stdin?.end(Buffer.alloc(11 * 1024 * 1024, 0x61));
      expect(await program.exit).toBe(1);
      expect(program.stderr()).toBe(
        "Error: the reply is larger than 10 MB. Nothing was sent; the request is still waiting.\n",
      );
      expect(program.stdout()).toBe("");
      expect((await readdir(path.join(storageDir, "requests", id))).sort()).toEqual([
        "request.json",
        "state.json",
      ]);
    });

    it("ends with exit 1 and names the request when the client goes away while the input still comes", async () => {
      const serve = await startServe();
      const controller = new AbortController();
      const client = fetch(
        `${serve.baseUrl}/v1/chat/completions`,
        chatInit(controller.signal),
      ).catch(() => undefined);
      const id = await waitForRequestId(serve.storageDir);
      const program = run(["answer"], answerEnv(serve.storageDir));
      program.child.stdin?.on("error", () => {});
      program.child.stdin?.write("a reply that is still being written");
      // The program chooses the request at once and then reads, and it prints nothing before that,
      // so there is nothing to wait for. Give it a generous time to get there, and never wait for
      // its exit without a limit: a program that has not chosen yet would otherwise wait forever.
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      controller.abort();
      await client;
      const code = await Promise.race([
        program.exit,
        new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), EXIT_LIMIT_MS)),
      ]);
      if (code === "stuck") {
        program.child.kill();
      }
      expect(code).toBe(1);
      expect(program.stderr()).toBe(
        `Error: request ${id.slice(-6)} was cancelled (the client disconnected). Nothing was sent.\n`,
      );
      expect(program.stdout()).toBe("");
      expect(await storedStates(serve.storageDir)).toEqual(["cancelled"]);
    });
  });

  // Skipped on Windows on purpose. A closed pipe does not give the child process an EPIPE error
  // in the same way there, so this test cannot reproduce the broken terminal. The same code
  // path is checked with injected streams in test/cli.test.ts on every operating system.
  it.skipIf(process.platform === "win32")(
    "serve prints only the fixed line and exits 1 when standard output is closed early",
    async () => {
      const program = run(["serve"], envFor(await makeTempDir()));
      // Close the read end of the pipe at once, like `imbehind serve | true`.
      program.child.stdout?.destroy();
      expect(await program.exit).toBe(1);
      expect(program.stderr()).toBe("Error: unexpected failure.\n");
    },
  );
});
