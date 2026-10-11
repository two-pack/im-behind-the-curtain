import { type ChildProcess, spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRequestFile, createStateFile } from "../../src/model.js";
import { ExchangeStore } from "../../src/store/exchange-store.js";
import { makeTempDir } from "../helpers/fs.js";
import { waitFor } from "../helpers/io.js";
import { placeRunningLock } from "../helpers/lock.js";
import { freePort } from "../helpers/system.js";

const BIN = path.resolve("dist", "bin.js");

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

interface Running {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exit: Promise<number | null>;
}

function run(args: string[], env: NodeJS.ProcessEnv): Running {
  const child = spawn(process.execPath, [BIN, ...args], { env, stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exit = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { child, stdout: () => stdout, stderr: () => stderr, exit };
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
    "reads a reply from standard input, puts it next to the request, and exits 130 on Ctrl+C",
    async () => {
      const home = await makeTempDir();
      const storageDir = storageFor(home);
      const id = await addWaitingRequest(storageDir);
      const program = run(["answer"], envFor(home));
      program.child.stdin?.end("Hi from stdin\r\n");

      const replyFile = path.join(storageDir, "requests", id, "reply.json");
      await waitFor(() => program.stdout().includes("Hello from the process test"), 10_000);
      await waitFor(async () => (await readFile(replyFile, "utf8").catch(() => "")) !== "");
      expect(JSON.parse(await readFile(replyFile, "utf8"))).toMatchObject({
        formatVersion: 1,
        kind: "text",
        body: "Hi from stdin",
        source: "imbehind-answer",
      });
      program.child.kill("SIGINT");
      expect(await program.exit).toBe(130);
    },
  );

  it("stops with Error: input ended. when standard input is closed at the skip question", async () => {
    const home = await makeTempDir();
    await addWaitingRequest(storageFor(home));
    const program = run(["answer"], envFor(home));
    program.child.stdin?.end();
    expect(await program.exit).toBe(1);
    expect(program.stderr()).toBe(
      "Error: input ended. Nothing was sent; the request is still waiting.\n",
    );
    expect(program.stdout()).toContain("Request 1 of 1");
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
