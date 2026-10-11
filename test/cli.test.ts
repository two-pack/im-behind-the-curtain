import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { type CliOptions, main } from "../src/cli.js";
import { type Clock, systemClock } from "../src/clock.js";
import { createRequestFile, createStateFile } from "../src/model.js";
import { ExchangeStore, nodeFs } from "../src/store/exchange-store.js";
import { errno, makeTempDir } from "./helpers/fs.js";
import { makeIo, waitFor } from "./helpers/io.js";

function get(port: number, requestPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http
      .get({ host: "127.0.0.1", port, path: requestPath }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      })
      .on("error", reject);
  });
}

const stopped: Array<() => Promise<unknown>> = [];

afterEach(async () => {
  await Promise.all(stopped.splice(0, stopped.length).map((stop) => stop()));
});

/** Starts `imbehind serve` on a free port and waits for its listening line. */
async function startServe(dir?: string, port = 0) {
  const t = makeIo();
  const storageDir = dir ?? (await makeTempDir());
  const options: CliOptions = { settings: { port, storageDir } };
  const exit = main(["serve"], t.io, options);
  stopped.push(async () => {
    t.interrupt();
    await exit;
  });
  await Promise.race([waitFor(() => t.out.text().includes("Listening on")), exit]);
  const match = /Listening on http:\/\/127\.0\.0\.1:(\d+) \(storage: (.*)\)/.exec(t.out.text());
  return { ...t, exit, storageDir, port: Number(match?.[1]), match };
}

describe("choosing the command", () => {
  it("fails with an Error line and exit 1 when there is no command or an unknown one", async () => {
    for (const argv of [[], ["nope"], ["serve", "--port", "4000"], ["answer", "extra"]]) {
      const t = makeIo();
      const exit = await main(argv, t.io, {
        settings: { port: 0, storageDir: await makeTempDir() },
      });
      expect(exit).toBe(1);
      expect(t.err.lines()).toHaveLength(1);
      expect(t.err.text()).toMatch(/^Error: /);
      expect(t.out.text()).toBe("");
    }
  });
});

describe("the wait limit option", () => {
  async function runWith(argv: string[], env: Record<string, string | undefined> = {}) {
    const t = makeIo({ platform: "linux", env, homedir: "/home/alice" });
    const exit = await main(argv, t.io, {
      settings: { port: 0, storageDir: await makeTempDir() },
    });
    return { exit, err: t.err.lines(), out: t.out.text() };
  }

  it("accepts --timeout for serve, as separate words or with =", async () => {
    for (const argv of [
      ["serve", "--timeout", "5"],
      ["serve", "--timeout=5"],
    ]) {
      const t = makeIo();
      const exit = main(argv, t.io, { settings: { port: 0, storageDir: await makeTempDir() } });
      stopped.push(async () => {
        t.interrupt();
        await exit;
      });
      await Promise.race([waitFor(() => t.out.text().includes("Listening on")), exit]);
      expect(t.out.text()).toContain("Listening on");
      expect(t.err.text()).toBe("");
      t.interrupt();
      expect(await exit).toBe(130);
    }
  });

  it("ends with exit 2 and one Error line for a bad option value, before it touches storage", async () => {
    const dir = path.join(await makeTempDir(), "never-created");
    const t = makeIo();
    const exit = await main(["serve", "--timeout", "abc"], t.io, {
      settings: { port: 0, storageDir: dir },
    });
    expect(exit).toBe(2);
    expect(t.err.lines()).toEqual([
      'Error: --timeout must be a whole number of seconds from 0 to 2147483 (got "abc").',
    ]);
    expect(t.out.text()).toBe("");
    await expect(stat(dir)).rejects.toThrow();
  });

  it("ends with exit 2 for a bad value of IMBEHIND_TIMEOUT and for an empty --timeout", async () => {
    const fromEnv = await runWith(["serve"], { IMBEHIND_TIMEOUT: "-5" });
    expect(fromEnv.exit).toBe(2);
    expect(fromEnv.err).toEqual([
      'Error: IMBEHIND_TIMEOUT must be a whole number of seconds from 0 to 2147483 (got "-5").',
    ]);
    const empty = await runWith(["serve", "--timeout", ""]);
    expect(empty.exit).toBe(2);
    expect(empty.err).toEqual([
      'Error: --timeout must be a whole number of seconds from 0 to 2147483 (got "").',
    ]);
    const missing = await runWith(["serve", "--timeout"]);
    expect(missing.exit).toBe(2);
  });

  it("does not accept --timeout for answer, and ignores IMBEHIND_TIMEOUT there", async () => {
    const refused = await runWith(["answer", "--timeout", "5"]);
    expect(refused.exit).toBe(1);
    expect(refused.err).toEqual(["Error: usage: imbehind serve | imbehind answer"]);
    const t = makeIo({ platform: "linux", env: { IMBEHIND_TIMEOUT: "abc" }, homedir: "/h" });
    const exit = main(["answer"], t.io, { settings: { storageDir: await makeTempDir() } });
    stopped.push(async () => {
      t.interrupt();
      await exit;
    });
    await waitFor(() => t.out.text().includes("Waiting for requests"));
    t.interrupt();
    expect(await exit).toBe(130);
    expect(t.err.text()).toBe("");
  });

  it("keeps the usage line and exit 1 for other unknown arguments", async () => {
    for (const argv of [
      ["serve", "--bogus"],
      ["serve", "5"],
      ["serve", "--timeout", "5", "x"],
    ]) {
      const result = await runWith(argv);
      expect(result.exit).toBe(1);
      expect(result.err).toEqual(["Error: usage: imbehind serve | imbehind answer"]);
    }
  });
});

describe("imbehind serve", () => {
  it("prints the listening line, serves requests, and exits 130 on Ctrl+C", async () => {
    const t = await startServe();
    expect(t.match).not.toBeNull();
    expect(t.out.lines()).toEqual([
      `Listening on http://127.0.0.1:${t.port} (storage: ${t.storageDir})`,
    ]);
    expect(await get(t.port, "/nothing")).toBe(404);
    t.interrupt();
    expect(await t.exit).toBe(130);
    await expect(get(t.port, "/nothing")).rejects.toThrow();
    expect(t.listeners()).toBe(0);
    expect(t.err.text()).toBe("");
  });

  it("creates the storage directory and requests/ when they are missing", async () => {
    const parent = await makeTempDir();
    const dir = path.join(parent, "new", "imbehind");
    const t = await startServe(dir);
    expect(await get(t.port, "/nothing")).toBe(404);
    expect((await stat(path.join(dir, "requests"))).isDirectory()).toBe(true);
  });

  it("fails with exit 1 and an Error line when the storage directory cannot be created", async () => {
    const parent = await makeTempDir();
    await writeFile(path.join(parent, "file"), "x");
    const t = makeIo();
    const storageDir = path.join(parent, "file", "imbehind");
    const exit = await main(["serve"], t.io, { settings: { port: 0, storageDir } });
    expect(exit).toBe(1);
    expect(t.err.lines()).toEqual([`Error: cannot create ${storageDir}: not a directory.`]);
    expect(t.out.text()).toBe("");
  });

  it("fails with exit 1 when the port is already in use", async () => {
    const first = await startServe();
    const t = makeIo();
    const exit = await main(["serve"], t.io, {
      settings: { port: first.port, storageDir: await makeTempDir() },
    });
    expect(exit).toBe(1);
    expect(t.err.lines()).toEqual([`Error: port ${first.port} is already in use.`]);
    expect(t.out.text()).toBe("");
  });

  it("fails with exit 1 when the home directory is unknown", async () => {
    const t = makeIo({ platform: "linux", env: {}, homedir: undefined });
    const exit = await main(["serve"], t.io);
    expect(exit).toBe(1);
    expect(t.err.text()).toMatch(/^Error: .*home directory/);
  });

  it("fails with exit 1 and names the directory when it cannot make hard links (NFR13.8)", async () => {
    const storageDir = await makeTempDir();
    const t = makeIo();
    const storeFs = { ...nodeFs, link: () => Promise.reject(errno("EPERM")) };
    const exit = await main(["serve"], t.io, { settings: { port: 0, storageDir }, storeFs });
    expect(exit).toBe(1);
    expect(t.err.lines()).toEqual([
      `Error: cannot create hard links in ${storageDir}: operation not permitted.`,
    ]);
    expect(t.out.text()).toBe("");
  });

  it("fails with exit 1 when the storage directory cannot be read at start", async () => {
    const storageDir = await makeTempDir();
    const t = makeIo();
    const storeFs = { ...nodeFs, readdir: () => Promise.reject(errno("EACCES")) };
    const exit = await main(["serve"], t.io, { settings: { port: 0, storageDir }, storeFs });
    expect(exit).toBe(1);
    expect(t.err.lines()).toEqual([`Error: cannot read ${storageDir}: permission denied.`]);
  });
});

describe("imbehind answer", () => {
  it("shows the waiting line and exits 130 on Ctrl+C", async () => {
    const t = makeIo();
    const storageDir = await makeTempDir();
    const exit = main(["answer"], t.io, { settings: { port: 0, storageDir } });
    await waitFor(() => t.out.text().includes("Waiting for requests..."));
    expect(t.out.lines()).toEqual(["Waiting for requests... (press Ctrl+C to quit)"]);
    t.interrupt();
    expect(await exit).toBe(130);
    expect(t.listeners()).toBe(0);
  });

  it("fails with exit 1 when the storage directory cannot make hard links (NFR13.8)", async () => {
    const storageDir = await makeTempDir();
    const t = makeIo();
    const storeFs = { ...nodeFs, link: () => Promise.reject(errno("EPERM")) };
    const exit = await main(["answer"], t.io, { settings: { port: 0, storageDir }, storeFs });
    expect(exit).toBe(1);
    expect(t.err.text()).toContain(`cannot create hard links in ${storageDir}`);
    expect(t.out.text()).toBe("");
  });

  it("ends a reply on Ctrl+Z and Enter when the platform is Windows", async () => {
    const storageDir = await makeTempDir();
    const store = new ExchangeStore({ rootDir: storageDir });
    await store.prepare();
    const id = "20261009T140512123Z-a1b2c3";
    const now = "2026-10-09T14:05:12.123Z";
    await store.createRequest(
      createRequestFile(id, now, {
        format: "chat.completions",
        model: "whatever",
        replyKind: "text",
        requiredShape: null,
        stream: false,
        includeUsage: false,
        conversation: [{ role: "user", content: "Hello" }],
        originalRequest: { model: "whatever" },
      }),
      createStateFile(id, "waiting", now, null),
    );
    const stdin = new PassThrough();
    const windows = { platform: "win32", env: {}, homedir: "C:\\Users\\alice" } as const;
    const t = makeIo(windows, stdin, true);
    const exit = main(["answer"], t.io, { settings: { port: 0, storageDir } });
    await waitFor(() => t.out.text().includes("Type your reply."));

    stdin.write("hello");
    stdin.write("\u001a");
    stdin.write("\r");

    await waitFor(async () => (await store.listFiles(id)).has("reply.json"));
    const reply = await store.readReply(id, "reply.json");
    expect(reply?.parsed.kind === "ok" && reply.parsed.value.body).toBe("hello");
    t.interrupt();
    expect(await exit).toBe(130);
  });

  it("leaves unrelated files in the storage directory alone", async () => {
    const storageDir = await makeTempDir();
    await mkdir(path.join(storageDir, "requests", "not-an-id"), { recursive: true });
    await writeFile(path.join(storageDir, "requests", ".half.tmp"), "x");
    const t = makeIo();
    const exit = main(["answer"], t.io, { settings: { port: 0, storageDir } });
    await waitFor(() => t.out.text().includes("Waiting for requests..."));
    t.interrupt();
    expect(await exit).toBe(130);
    expect((await readdir(path.join(storageDir, "requests"))).sort()).toEqual([
      ".half.tmp",
      "not-an-id",
    ]);
  });
});

const UNEXPECTED = "Error: unexpected failure.\n";

/** A clock that works like the system clock, except that `sleep` fails with a revealing message. */
const sleepFails: Clock = {
  now: () => new Date(),
  sleep: () => Promise.reject(new Error("SECRET-DETAIL at /private/path")),
};

function expectNothingRevealed(...texts: string[]): void {
  const all = texts.join("");
  expect(all).not.toContain("SECRET-DETAIL");
  expect(all).not.toContain("/private/path");
  expect(all).not.toContain("    at ");
}

describe("unexpected failures (NFR10.7)", () => {
  it("serve prints one fixed line and exits 1 when polling fails after listening", async () => {
    const t = makeIo();
    const storageDir = await makeTempDir();
    const exit = await main(["serve"], t.io, {
      settings: { port: 0, storageDir },
      clock: sleepFails,
    });
    expect(exit).toBe(1);
    expect(t.err.text()).toBe(UNEXPECTED);
    expectNothingRevealed(t.err.text(), t.out.text());
    const port = Number(/Listening on http:\/\/127\.0\.0\.1:(\d+) /.exec(t.out.text())?.[1]);
    await expect(get(port, "/nothing")).rejects.toThrow();
    expect(t.listeners()).toBe(0);
  });

  it("serve ends on an exception raised while it handles a request and keeps the request", async () => {
    let calls = 0;
    // The broker reads the time once to save the request. The log line reads it again and fails.
    const clock: Clock = {
      now: () => {
        calls += 1;
        if (calls >= 2) {
          throw new Error("SECRET-DETAIL at /private/path");
        }
        return new Date();
      },
      sleep: systemClock.sleep,
    };
    const t = makeIo();
    const storageDir = await makeTempDir();
    const exit = main(["serve"], t.io, { settings: { port: 0, storageDir }, clock });
    await waitFor(() => t.out.text().includes("Listening on"));
    const port = Number(/Listening on http:\/\/127\.0\.0\.1:(\d+) /.exec(t.out.text())?.[1]);
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "Hello" }] }),
    }).then(
      () => "answered",
      () => "dropped",
    );
    expect(response).toBe("dropped");
    expect(await exit).toBe(1);
    expect(t.err.text()).toBe(UNEXPECTED);
    expectNothingRevealed(t.err.text(), t.out.text());
    const ids = await readdir(path.join(storageDir, "requests"));
    expect(ids).toHaveLength(1);
    const state = await new ExchangeStore({ rootDir: storageDir }).readState(ids[0] as string);
    expect(state.kind === "ok" && state.value.state).toBe("waiting");
  });

  it("answer prints one fixed line and exits 1 for an exception it does not handle", async () => {
    const t = makeIo();
    const storageDir = await makeTempDir();
    const exit = await main(["answer"], t.io, {
      settings: { port: 0, storageDir },
      clock: sleepFails,
    });
    expect(exit).toBe(1);
    expect(t.err.text()).toBe(UNEXPECTED);
    expectNothingRevealed(t.err.text(), t.out.text());
    expect(t.listeners()).toBe(0);
  });

  it("keeps the Error line of a failure before listening (NFR10.6)", async () => {
    const first = await startServe();
    const t = makeIo();
    const exit = await main(["serve"], t.io, {
      settings: { port: first.port, storageDir: await makeTempDir() },
    });
    expect(exit).toBe(1);
    expect(t.err.text()).toBe(`Error: port ${first.port} is already in use.\n`);
  });
});

const BROKEN_PIPE = "write EPIPE SECRET-DETAIL at /private/path";

/** Breaks a recorded stream the way a closed pipe does: an error event with a revealing message. */
function breakStream(stream: NodeJS.WritableStream): void {
  stream.emit("error", Object.assign(new Error(BROKEN_PIPE), { code: "EPIPE" }));
}

describe("a broken terminal and uncaught errors", () => {
  it("serve ends with the fixed line and exit 1 when standard output breaks, keeping requests", async () => {
    const t = makeIo();
    const storageDir = await makeTempDir();
    const store = new ExchangeStore({ rootDir: storageDir });
    await store.prepare();
    const now = new Date().toISOString();
    const id = "20261009T140512123Z-a1b2c3";
    await store.createRequest(
      createRequestFile(id, now, {
        format: "chat.completions",
        model: "m",
        replyKind: "text",
        requiredShape: null,
        stream: false,
        includeUsage: false,
        conversation: [{ role: "user", content: "Hello" }],
        originalRequest: { model: "m" },
      }),
      createStateFile(id, "waiting", now, null),
    );
    const exit = main(["serve"], t.io, { settings: { port: 0, storageDir } });
    await waitFor(() => t.out.text().includes("Listening on"));
    breakStream(t.io.stdout);
    expect(await exit).toBe(1);
    expect(t.err.text()).toBe(UNEXPECTED);
    expectNothingRevealed(t.err.text(), t.out.text());
    expect(t.listeners()).toBe(0);
    expect(t.fatalListeners()).toBe(0);
    const state = await store.readState(id);
    expect(state.kind === "ok" && state.value.state).toBe("waiting");
  });

  it("serve prints nothing and exits 1 when standard error breaks", async () => {
    const t = makeIo();
    const exit = main(["serve"], t.io, {
      settings: { port: 0, storageDir: await makeTempDir() },
    });
    await waitFor(() => t.out.text().includes("Listening on"));
    breakStream(t.io.stderr);
    expect(await exit).toBe(1);
    expect(t.err.text()).toBe("");
    expectNothingRevealed(t.out.text());
  });

  it("answer ends with the fixed line and exit 1 when standard output breaks", async () => {
    const t = makeIo();
    const exit = main(["answer"], t.io, {
      settings: { port: 0, storageDir: await makeTempDir() },
    });
    await waitFor(() => t.out.text().includes("Waiting for requests"));
    breakStream(t.io.stdout);
    expect(await exit).toBe(1);
    expect(t.err.text()).toBe(UNEXPECTED);
    expectNothingRevealed(t.err.text());
    expect(t.listeners()).toBe(0);
    expect(t.fatalListeners()).toBe(0);
  });

  it("writes the fixed line once when several streams break", async () => {
    const t = makeIo();
    const exit = main(["answer"], t.io, {
      settings: { port: 0, storageDir: await makeTempDir() },
    });
    await waitFor(() => t.out.text().includes("Waiting for requests"));
    breakStream(t.io.stdout);
    breakStream(t.io.stdout);
    t.crash();
    expect(await exit).toBe(1);
    expect(t.err.text()).toBe(UNEXPECTED);
  });

  it.each(["serve", "answer"])(
    "%s ends with the fixed line on an uncaught error",
    async (command) => {
      const t = makeIo();
      const exit = main([command], t.io, {
        settings: { port: 0, storageDir: await makeTempDir() },
      });
      await waitFor(() => t.fatalListeners() === 1);
      t.crash();
      expect(await exit).toBe(1);
      expect(t.err.text()).toBe(UNEXPECTED);
      expect(t.fatalListeners()).toBe(0);
      expect(t.listeners()).toBe(0);
    },
  );

  it("leaves no listener on the streams after a normal end", async () => {
    const t = makeIo();
    const before = t.io.stdout.listenerCount("error") + t.io.stderr.listenerCount("error");
    const exit = await main(["nope"], t.io, {});
    expect(exit).toBe(1);
    const after = t.io.stdout.listenerCount("error") + t.io.stderr.listenerCount("error");
    expect(after).toBe(before);
    expect(t.fatalListeners()).toBe(0);
  });
});
