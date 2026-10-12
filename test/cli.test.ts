import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { type CliOptions, main } from "../src/cli.js";
import { type Clock, systemClock } from "../src/clock.js";
import {
  type ConversationRequest,
  createReplyFile,
  createRequestFile,
  createStateFile,
  serializeFile,
} from "../src/model.js";
import { ExchangeStore, nodeFs, type StoreFs } from "../src/store/exchange-store.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { errno, makeTempDir } from "./helpers/fs.js";
import { makeIo, waitFor } from "./helpers/io.js";
import { placeRunningLock } from "./helpers/lock.js";

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

/** chmod 000 does not stop the superuser, so the tests that need it only run for other users. */
const canBeDenied = process.platform !== "win32" && process.getuid?.() !== 0;

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

const USAGE_LINE = "Error: usage: imbehind serve | answer | path";

describe("choosing the command", () => {
  it("ends with the usage line and exit 2 for a wrong way of writing, and touches nothing", async () => {
    const wrong = [
      [],
      ["nope"],
      ["serve", "--bogus"],
      ["serve", "5"],
      ["serve", "--port"],
      ["serve", "--port", "4000", "--port", "4001"],
      ["answer", "extra"],
      ["answer", "--port", "4000"],
      ["answer", "--host=127.0.0.1"],
      ["path", "--timeout", "5"],
      ["path", "x"],
    ];
    for (const argv of wrong) {
      const t = makeIo();
      const dir = path.join(await makeTempDir(), "never-created");
      const exit = await main(argv, t.io, { settings: { port: 0, storageDir: dir } });
      expect(exit, argv.join(" ")).toBe(2);
      expect(t.err.lines()).toEqual([USAGE_LINE]);
      expect(t.out.text()).toBe("");
      await expect(stat(dir)).rejects.toThrow();
    }
  });
});

describe("settings that are not valid", () => {
  async function refused(argv: string[], env: Record<string, string> = {}) {
    const t = makeIo({ platform: "linux", env, homedir: "/home/alice" });
    const dir = path.join(await makeTempDir(), "never-created");
    const exit = await main(argv, t.io, { settings: { port: 0, storageDir: dir } });
    await expect(stat(dir)).rejects.toThrow();
    return { exit, err: t.err.lines(), out: t.out.text() };
  }

  it("ends with exit 2 and the fixed sentence, before anything is created or listened to", async () => {
    const cases: Array<[string[], Record<string, string>, string]> = [
      [
        ["serve", "--host", "0.0.0.0"],
        {},
        "Error: 0.0.0.0 is not a local address. imbehind only listens on this machine (127.0.0.0/8, ::1, localhost).",
      ],
      [
        ["serve", "--port", "abc"],
        {},
        'Error: --port must be a number from 1 to 65535 (got "abc").',
      ],
      [
        ["serve", "--retention", "600", "--timeout", "1800"],
        {},
        "Error: --retention (600 seconds) must not be shorter than --timeout (1800 seconds).",
      ],
      [
        ["serve"],
        { IMBEHIND_SWEEP_INTERVAL: "0" },
        'Error: IMBEHIND_SWEEP_INTERVAL must be a whole number of seconds from 1 to 2147483 (got "0").',
      ],
      [["serve", "--dir", ""], {}, "Error: --dir must not be empty."],
    ];
    for (const [argv, env, line] of cases) {
      const result = await refused(argv, env);
      expect(result.exit, line).toBe(2);
      expect(result.err).toEqual([line]);
      expect(result.out).toBe("");
    }
  });

  it("gives only the first failure of the fixed order", async () => {
    const result = await refused(["serve", "--timeout", "x", "--port", "x", "--host", "10.0.0.1"]);
    expect(result.err).toEqual([
      "Error: 10.0.0.1 is not a local address. imbehind only listens on this machine (127.0.0.0/8, ::1, localhost).",
    ]);
  });

  it("checks the settings of answer and path as far as they use them: only --dir", async () => {
    expect((await refused(["answer", "--dir", ""])).exit).toBe(2);
    expect((await refused(["path", "--dir="])).err).toEqual(["Error: --dir must not be empty."]);
  });

  it("lets a name be looked up by an injected lookup, and refuses localhost that names another machine", async () => {
    const t = makeIo();
    const lookup = async () => ["127.0.0.1", "10.0.0.1"];
    const exit = await main(["serve", "--host", "localhost"], t.io, {
      settings: { port: 0, storageDir: await makeTempDir() },
      lookup,
    });
    expect(exit).toBe(2);
    expect(t.err.lines()).toEqual([
      "Error: localhost is not a local address. imbehind only listens on this machine (127.0.0.0/8, ::1, localhost).",
    ]);
  });
});

describe("imbehind path", () => {
  async function pathOf(argv: string[], env: Record<string, string> = {}, cwd = "/work") {
    const t = makeIo({ platform: "linux", env, homedir: "/home/alice", cwd });
    const exit = await main(argv, t.io);
    return { exit, out: t.out.text(), err: t.err.text() };
  }

  it("prints the storage directory, one line, and ends with exit 0", async () => {
    const result = await pathOf(["path"]);
    expect(result).toEqual({
      exit: 0,
      out: "/home/alice/.local/share/imbehind\n",
      err: "",
    });
  });

  it("follows --dir and IMBEHIND_DIR like serve does", async () => {
    expect((await pathOf(["path", "--dir", "/a"], { IMBEHIND_DIR: "/b" })).out).toBe("/a\n");
    expect((await pathOf(["path", "--dir=/a"])).out).toBe("/a\n");
    expect((await pathOf(["path"], { IMBEHIND_DIR: "/b" })).out).toBe("/b\n");
    expect((await pathOf(["path", "--dir", "rel/x"])).out).toBe("/work/rel/x\n");
  });

  it("uses the default of the operating system in the information it is given", async () => {
    const mac = makeIo({ platform: "darwin", env: {}, homedir: "/Users/alice" });
    expect(await main(["path"], mac.io)).toBe(0);
    expect(mac.out.text()).toBe("/Users/alice/Library/Application Support/imbehind\n");
    const windows = makeIo({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
      homedir: "C:\\Users\\alice",
    });
    expect(await main(["path"], windows.io)).toBe(0);
    expect(windows.out.text()).toBe("C:\\Users\\alice\\AppData\\Local\\imbehind\n");
  });

  it("does not create, read or look at anything, whether or not the directory exists", async () => {
    const dir = path.join(await makeTempDir(), "not", "there");
    const touched: string[] = [];
    const t = makeIo();
    const exit = await main(["path", "--dir", dir], t.io, {
      storeFs: new Proxy(nodeFs, {
        get: (target, name) => {
          touched.push(String(name));
          return target[name as keyof typeof target];
        },
      }),
    });
    expect(exit).toBe(0);
    expect(t.out.lines()).toEqual([dir]);
    expect(touched).toEqual([]);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("prints nothing on standard output and an Error line when the directory cannot be decided", async () => {
    const lost = makeIo({ platform: "linux", env: {}, homedir: undefined });
    expect(await main(["path"], lost.io)).toBe(1);
    expect(lost.out.text()).toBe("");
    expect(lost.err.text()).toMatch(/^Error: .*home directory/);
    const empty = makeIo();
    expect(await main(["path", "--dir", ""], empty.io)).toBe(2);
    expect(empty.out.text()).toBe("");
    expect(empty.err.lines()).toEqual(["Error: --dir must not be empty."]);
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
    expect(refused.exit).toBe(2);
    expect(refused.err).toEqual([USAGE_LINE]);
    const t = makeIo(
      { platform: "linux", env: { IMBEHIND_TIMEOUT: "abc" }, homedir: "/h" },
      undefined,
      false,
      "interactive",
    );
    const storageDir = await makeTempDir();
    await placeRunningLock(storageDir);
    const exit = main(["answer"], t.io, { settings: { storageDir } });
    stopped.push(async () => {
      t.interrupt();
      await exit;
    });
    await waitFor(() => t.out.text().includes("Waiting for requests"));
    t.interrupt();
    expect(await exit).toBe(130);
    expect(t.err.text()).toBe("");
  });

  it("gives the usage line and exit 2 for other unknown arguments", async () => {
    for (const argv of [
      ["serve", "--bogus"],
      ["serve", "5"],
      ["serve", "--timeout", "5", "x"],
    ]) {
      const result = await runWith(argv);
      expect(result.exit).toBe(2);
      expect(result.err).toEqual([USAGE_LINE]);
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
    expect(t.err.lines()).toEqual([
      `Error: port ${first.port} is already in use. Choose another port with --port or IMBEHIND_PORT.`,
    ]);
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
    const t = makeIo(undefined, undefined, false, "interactive");
    const storageDir = await makeTempDir();
    await placeRunningLock(storageDir);
    const exit = main(["answer"], t.io, { settings: { port: 0, storageDir } });
    await waitFor(() => t.out.text().includes("Waiting for requests..."));
    expect(t.out.lines()).toEqual(["Waiting for requests... (press Ctrl+C to quit)"]);
    t.interrupt();
    expect(await exit).toBe(130);
    expect(t.listeners()).toBe(0);
  });

  it("does not make hard links or create anything of its own: it only reads", async () => {
    const storageDir = await makeTempDir();
    await placeRunningLock(storageDir);
    const t = makeIo(undefined, undefined, false, "interactive");
    const storeFs = { ...nodeFs, link: () => Promise.reject(errno("EPERM")) };
    const exit = main(["answer"], t.io, { settings: { port: 0, storageDir }, storeFs });
    await waitFor(() => t.out.text().includes("Waiting for requests..."));
    t.interrupt();
    expect(await exit).toBe(130);
    expect(t.err.text()).toBe("");
    expect((await readdir(storageDir)).sort()).toEqual(["requests", "serve.lock"]);
    expect(await readdir(path.join(storageDir, "requests"))).toEqual([]);
  });

  it("ends a reply on Ctrl+Z and Enter when the platform is Windows", async () => {
    const storageDir = await makeTempDir();
    const store = new ExchangeStore({ rootDir: storageDir });
    await store.prepare();
    await placeRunningLock(storageDir);
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
    const windows = {
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
      homedir: "C:\\Users\\alice",
    } as const;
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

  describe("how it uses its input", () => {
    const id = "20261009T140512123Z-a1b2c3";

    async function withWaitingRequest() {
      const storageDir = await makeTempDir();
      const store = new ExchangeStore({ rootDir: storageDir });
      await store.prepare();
      await placeRunningLock(storageDir);
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
      return { storageDir, store };
    }

    async function replyBody(store: ExchangeStore): Promise<string | undefined> {
      await waitFor(async () => (await store.listFiles(id)).has("reply.json"));
      const reply = await store.readReply(id, "reply.json");
      return reply?.parsed.kind === "ok" ? reply.parsed.value.body : undefined;
    }

    it("reads the input as the reply when it is not a terminal, and shows nothing", async () => {
      const { storageDir, store } = await withWaitingRequest();
      const t = makeIo(undefined, Readable.from(["Hi from a pipe\n"]), false);
      const exit = main(["answer"], t.io, { settings: { port: 0, storageDir } });
      expect(await replyBody(store)).toBe("Hi from a pipe");
      expect(t.out.text()).toBe("");
      expect(t.err.text()).toBe("");
      t.interrupt();
      expect(await exit).toBe(130);
    });

    it("shows the screen and reads typed lines when it is a terminal", async () => {
      const { storageDir, store } = await withWaitingRequest();
      const stdin = new PassThrough();
      const t = makeIo(undefined, stdin, true);
      const exit = main(["answer"], t.io, { settings: { port: 0, storageDir } });
      await waitFor(() => t.out.text().includes("Type your reply."));
      stdin.write("typed\n");
      stdin.write("\u0004");
      expect(await replyBody(store)).toBe("typed");
      t.interrupt();
      expect(await exit).toBe(130);
    });

    it("lets answerInput stdin win over a terminal", async () => {
      const { storageDir, store } = await withWaitingRequest();
      const t = makeIo(undefined, Readable.from(["forced\n"]), true, "stdin");
      const exit = main(["answer"], t.io, { settings: { port: 0, storageDir } });
      expect(await replyBody(store)).toBe("forced");
      expect(t.out.text()).toBe("");
      t.interrupt();
      expect(await exit).toBe(130);
    });

    it("lets answerInput interactive win over a pipe", async () => {
      const { storageDir } = await withWaitingRequest();
      const t = makeIo(undefined, new PassThrough(), false, "interactive");
      const exit = main(["answer"], t.io, { settings: { port: 0, storageDir } });
      await waitFor(() => t.out.text().includes("Type your reply."));
      t.interrupt();
      expect(await exit).toBe(130);
      expect(t.out.text()).toContain("Quit. Request a1b2c3 is still waiting.");
    });

    it("does not read the input at all when no serve runs", async () => {
      const storageDir = await makeTempDir();
      let reads = 0;
      const stdin = new Readable({
        read() {
          reads += 1;
        },
      });
      const t = makeIo(undefined, stdin, false);
      const exit = await main(["answer"], t.io, { settings: { storageDir } });
      expect(exit).toBe(1);
      expect(t.err.lines()).toEqual([
        `Error: imbehind serve is not running for ${storageDir}.`,
        "Start it with: imbehind serve",
      ]);
      expect(reads).toBe(0);
      expect(stdin.listenerCount("data")).toBe(0);
    });
  });

  it("leaves unrelated files in the storage directory alone", async () => {
    const storageDir = await makeTempDir();
    await mkdir(path.join(storageDir, "requests", "not-an-id"), { recursive: true });
    await writeFile(path.join(storageDir, "requests", ".half.tmp"), "x");
    await placeRunningLock(storageDir);
    const t = makeIo(undefined, undefined, false, "interactive");
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

describe("imbehind answer when serve is not running", () => {
  const notRunning = (dir: string) => [
    `Error: imbehind serve is not running for ${dir}.`,
    "Start it with: imbehind serve",
  ];

  async function answerIn(
    storageDir: string,
    options: Partial<CliOptions> = {},
    isTerminal = false,
  ) {
    const t = makeIo(undefined, undefined, isTerminal);
    const exit = await main(["answer"], t.io, { settings: { storageDir }, ...options });
    return { exit, err: t.err.lines(), out: t.out.text(), listeners: t.listeners() };
  }

  it("ends with exit 1 and the two lines, and creates nothing, when there is no storage directory", async () => {
    const dir = path.join(await makeTempDir(), "never-created");
    const result = await answerIn(dir);
    expect(result.exit).toBe(1);
    expect(result.err).toEqual(notRunning(dir));
    expect(result.out).toBe("");
    expect(result.listeners).toBe(0);
    await expect(stat(dir)).rejects.toThrow();
  });

  it("ends the same way when the directory exists but has no serve.lock, and creates nothing in it", async () => {
    const dir = await makeTempDir();
    const result = await answerIn(dir);
    expect(result.exit).toBe(1);
    expect(result.err).toEqual(notRunning(dir));
    expect(await readdir(dir)).toEqual([]);
  });

  it("ends the same way for a lock whose process is gone, whose heartbeat is old, or that is foreign", async () => {
    const now = Date.now();
    const gone = await makeTempDir();
    await placeRunningLock(gone);
    const old = await makeTempDir();
    await placeRunningLock(old, new Date(now - 20000));
    const foreign = await makeTempDir();
    await writeFile(path.join(foreign, "serve.lock"), "not a lock");
    for (const [dir, alive] of [
      [gone, () => false],
      [old, () => true],
      [foreign, () => true],
    ] as const) {
      const result = await answerIn(dir, { isProcessAlive: alive });
      expect(result.exit).toBe(1);
      expect(result.err).toEqual(notRunning(dir));
    }
    expect(await readFile(path.join(foreign, "serve.lock"), "utf8")).toBe("not a lock");
  });

  it.skipIf(!canBeDenied)(
    "ends with 'cannot read <dir>' and exit 1, not with the not-running lines, for a serve.lock that the permissions forbid reading",
    async () => {
      const dir = await makeTempDir();
      const lockFile = path.join(dir, "serve.lock");
      await placeRunningLock(dir);
      await chmod(lockFile, 0o000);
      try {
        const result = await answerIn(dir);
        expect(result.exit).toBe(1);
        expect(result.err).toEqual([`Error: cannot read ${dir}: permission denied.`]);
        expect(result.out).toBe("");
      } finally {
        await chmod(lockFile, 0o600);
      }
      expect((await readdir(dir)).filter((name) => name !== "requests")).toEqual(["serve.lock"]);
    },
  );

  it("does not depend on whether standard input is a terminal", async () => {
    const dir = await makeTempDir();
    const result = await answerIn(dir, {}, true);
    expect(result.exit).toBe(1);
    expect(result.err).toEqual(notRunning(dir));
  });

  it("names the directory and the reason when serve.lock cannot be read", async () => {
    const dir = await makeTempDir();
    const storeFs = {
      ...nodeFs,
      readFile: (file: string) =>
        file.endsWith("serve.lock") ? Promise.reject(errno("EACCES")) : nodeFs.readFile(file),
    };
    const result = await answerIn(dir, { storeFs });
    expect(result.exit).toBe(1);
    expect(result.err).toEqual([`Error: cannot read ${dir}: permission denied.`]);
    const file = path.join(await makeTempDir(), "plain-file");
    await writeFile(file, "x");
    const notDirectory = await answerIn(file);
    expect(notDirectory.err).toEqual([`Error: cannot read ${file}: not a directory.`]);
  });

  it("goes on as before when a serve runs: it reads the lock once, at the start", async () => {
    const dir = await makeTempDir();
    await placeRunningLock(dir);
    let lockReads = 0;
    const storeFs = {
      ...nodeFs,
      readFile: (file: string) => {
        lockReads += file.endsWith("serve.lock") ? 1 : 0;
        return nodeFs.readFile(file);
      },
    };
    const t = makeIo(undefined, undefined, false, "interactive");
    const exit = main(["answer"], t.io, { settings: { storageDir: dir }, storeFs });
    await waitFor(() => t.out.text().includes("Waiting for requests..."));
    await new Promise((resolve) => setTimeout(resolve, 800));
    t.interrupt();
    expect(await exit).toBe(130);
    expect(lockReads).toBe(1);
  });
});

const ID_A = "20261009T100000000Z-aaaaaa";
const ID_B = "20261009T100001000Z-bbbbbb";
const ID_C = "20261009T100002000Z-cccccc";
const REQUEST: ConversationRequest = {
  format: "chat.completions",
  model: "whatever",
  replyKind: "text",
  requiredShape: null,
  stream: false,
  includeUsage: false,
  conversation: [{ role: "user", content: "Hello" }],
  originalRequest: { model: "whatever" },
};

/** The id of a process that has ended. Nothing else is guessed. */
async function deadProcessId(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""]);
  await new Promise((resolve) => child.on("close", resolve));
  return child.pid ?? 0;
}

/** Puts a request in the storage directory the way an earlier run of serve would have left it. */
async function leaveRequest(
  dir: string,
  id: string,
  state: "waiting" | "replied" = "waiting",
  endedAt: string | null = null,
): Promise<ExchangeStore> {
  const store = new ExchangeStore({ rootDir: dir });
  await store.prepare();
  const received = "2026-10-09T09:00:00.000Z";
  await store.createRequest(
    createRequestFile(id, received, REQUEST),
    createStateFile(id, state, endedAt ?? received, endedAt),
  );
  return store;
}

async function stateOf(store: ExchangeStore, id: string): Promise<string | undefined> {
  const state = await store.readState(id);
  return state.kind === "ok" ? state.value.state : state.kind;
}

/** Runs a serve with a fake clock and waits for its first line. */
async function serveWithClock(dir: string, options: Partial<CliOptions> = {}, args: string[] = []) {
  const t = makeIo();
  const clock = new FakeClock();
  const exit = main(["serve", ...args], t.io, {
    settings: { port: 0, storageDir: dir },
    clock,
    ...options,
  });
  stopped.push(async () => {
    t.interrupt();
    await exit;
  });
  await Promise.race([waitFor(() => t.out.text().includes("Listening on")), exit]);
  return { ...t, clock, exit };
}

/** Moves the fake clock in steps until the condition holds. The files take real time. */
async function runUntil(clock: FakeClock, condition: () => boolean | Promise<boolean>) {
  for (let step = 0; step < 400; step += 1) {
    if (await condition()) {
      return;
    }
    await clock.advance(500);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("the condition never held");
}

describe("the order of the start", () => {
  it("checks, prepares, takes the lock, starts the heartbeat, lists, listens, then abandons and sweeps", async () => {
    const dir = await makeTempDir();
    await leaveRequest(dir, ID_B);
    await leaveRequest(dir, ID_A);
    await leaveRequest(dir, ID_C, "replied", "2026-10-07T00:00:00.000Z");
    const steps: string[] = [];
    let sleepingAtListing = -1;
    const clock = new FakeClock();
    const storeFs: StoreFs = {
      ...nodeFs,
      mkdir: (target, options) => {
        steps.push("prepare");
        return nodeFs.mkdir(target, options);
      },
      link: (existing, target) => {
        if (target.endsWith("serve.lock")) {
          steps.push("lock");
        }
        return nodeFs.link(existing, target);
      },
      readFile: (file) => {
        if (file.endsWith("state.json") && !steps.includes("list")) {
          steps.push("list");
          sleepingAtListing = clock.sleeping;
        }
        return nodeFs.readFile(file);
      },
      rename: (from, to) => {
        if (to.endsWith("state.json")) {
          steps.push(`abandon ${path.basename(path.dirname(to))}`);
        }
        return nodeFs.rename(from, to);
      },
      rmdir: (target) => {
        steps.push(`sweep ${path.basename(target)}`);
        return nodeFs.rmdir(target);
      },
    };
    const t = makeIo();
    const exit = main(["serve"], t.io, {
      settings: { port: 0, storageDir: dir },
      clock,
      storeFs,
      createServer: (listener) => {
        steps.push("listen");
        return http.createServer({ requireHostHeader: false }, listener);
      },
    });
    stopped.push(async () => {
      t.interrupt();
      await exit;
    });
    await waitFor(() => steps.includes(`sweep ${ID_C}`));
    expect(steps).toEqual([
      "prepare",
      "lock",
      "list",
      "listen",
      `abandon ${ID_A}`,
      `abandon ${ID_B}`,
      `sweep ${ID_C}`,
    ]);
    expect(sleepingAtListing).toBe(1);
    const lines = t.out.lines();
    expect(lines[0]).toMatch(/^Listening on http:\/\/127\.0\.0\.1:\d+ \(storage: /);
    expect(lines[1]).toMatch(/^\d\d:\d\d:\d\d abandoned {2}aaaaaa {2}server restarted$/);
    expect(lines[2]).toMatch(/^\d\d:\d\d:\d\d abandoned {2}bbbbbb {2}server restarted$/);
    expect(lines).toHaveLength(3);
  });
});

describe("abandoning at start (BR22)", () => {
  it("ends the requests that waited, and a reply file that was left for them is not used", async () => {
    const dir = await makeTempDir();
    const store = await leaveRequest(dir, ID_A);
    await store.placeReply(
      ID_A,
      serializeFile(createReplyFile("late", "2026-10-09T09:01:00.000Z")),
    );
    const t = await serveWithClock(dir);
    await waitFor(() => t.out.text().includes("abandoned"));
    const state = await store.readState(ID_A);
    expect(state.kind === "ok" && state.value).toMatchObject({
      state: "abandoned",
      endedAt: t.clock.now().toISOString(),
      updatedAt: t.clock.now().toISOString(),
      endReason: "server restarted",
    });
    await t.clock.advance(2000);
    expect(await stateOf(store, ID_A)).toBe("abandoned");
    expect(t.out.text()).not.toContain("replied");
  });

  it("does not abandon a request that arrives after the start", async () => {
    const dir = await makeTempDir();
    const t = await serveWithClock(dir);
    const port = Number(/:(\d+) \(storage/.exec(t.out.text())?.[1]);
    const pending = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "Hi" }] }),
    }).catch(() => undefined);
    const store = new ExchangeStore({ rootDir: dir });
    await waitFor(async () => (await store.listIds()).length === 1);
    const [id] = await store.listIds();
    expect(await stateOf(store, id as string)).toBe("waiting");
    t.interrupt();
    await t.exit;
    await pending;
    expect(await stateOf(store, id as string)).toBe("waiting");
  });

  it("says which request it could not abandon, keeps trying every 5 seconds, and goes on", async () => {
    const dir = await makeTempDir();
    const store = await leaveRequest(dir, ID_A);
    let failures = 1;
    const storeFs: StoreFs = {
      ...nodeFs,
      rename: (from, to) => {
        if (to.endsWith("state.json") && failures > 0) {
          failures -= 1;
          return Promise.reject(errno("EBUSY"));
        }
        return nodeFs.rename(from, to);
      },
    };
    const t = await serveWithClock(dir, { storeFs });
    await waitFor(() => t.out.text().includes("abandon failed"));
    expect(t.out.lines()[1]).toMatch(/^\d\d:\d\d:\d\d error {6}aaaaaa {2}abandon failed$/);
    expect(await stateOf(store, ID_A)).toBe("waiting");
    await t.clock.advance(5000);
    await runUntil(t.clock, () => t.out.text().includes("server restarted"));
    expect(await stateOf(store, ID_A)).toBe("abandoned");
    expect(t.out.text().match(/abandon failed/g)).toHaveLength(1);
  });

  it("leaves every request as it is when listening fails, and returns the lock", async () => {
    const dir = await makeTempDir();
    const store = await leaveRequest(dir, ID_A);
    const t = makeIo();
    const emitter = new EventEmitter();
    const exit = await main(["serve"], t.io, {
      settings: { port: 3000, storageDir: dir },
      createServer: () =>
        Object.assign(emitter, {
          listen: () =>
            queueMicrotask(() =>
              emitter.emit("error", Object.assign(new Error("x"), { code: "EADDRNOTAVAIL" })),
            ),
          address: () => null,
          close: (callback: () => void) => callback(),
          closeAllConnections: () => {},
        }),
    });
    expect(exit).toBe(1);
    expect(t.err.lines()).toEqual([
      "Error: cannot listen on 127.0.0.1:3000: address not available.",
    ]);
    expect(t.out.text()).toBe("");
    expect(await stateOf(store, ID_A)).toBe("waiting");
    await expect(stat(path.join(dir, "serve.lock"))).rejects.toThrow();
  });
});

describe("serve.lock while serve runs", () => {
  async function readLock(dir: string): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(path.join(dir, "serve.lock"), "utf8")) as Record<
      string,
      unknown
    >;
  }

  it("holds the lock while it runs and returns it on Ctrl+C", async () => {
    const dir = await makeTempDir();
    const t = await serveWithClock(dir);
    expect(await readLock(dir)).toMatchObject({
      formatVersion: 1,
      processId: process.pid,
      startedAt: t.clock.now().toISOString(),
      heartbeatAt: t.clock.now().toISOString(),
    });
    t.interrupt();
    expect(await t.exit).toBe(130);
    await expect(stat(path.join(dir, "serve.lock"))).rejects.toThrow();
  });

  it("returns the lock when it ends for an unexpected failure", async () => {
    const dir = await makeTempDir();
    const exit = await main(["serve"], makeIo().io, {
      settings: { port: 0, storageDir: dir },
      clock: sleepFails,
    });
    expect(exit).toBe(1);
    await expect(stat(path.join(dir, "serve.lock"))).rejects.toThrow();
  });

  it("returns the lock when the start fails after taking it", async () => {
    const dir = await makeTempDir();
    const t = makeIo();
    const storeFs = { ...nodeFs, readdir: () => Promise.reject(errno("EACCES")) };
    const exit = await main(["serve"], t.io, { settings: { port: 0, storageDir: dir }, storeFs });
    expect(exit).toBe(1);
    expect(t.err.lines()).toEqual([`Error: cannot read ${dir}: permission denied.`]);
    await expect(stat(path.join(dir, "serve.lock"))).rejects.toThrow();
  });

  it("rewrites heartbeatAt every 5 seconds without waiting for anything else", async () => {
    const dir = await makeTempDir();
    const t = await serveWithClock(dir);
    const startedAt = t.clock.now().toISOString();
    await t.clock.advance(5000);
    const later = t.clock.now().toISOString();
    await waitFor(async () => (await readLock(dir)).heartbeatAt === later);
    expect((await readLock(dir)).startedAt).toBe(startedAt);
    expect(later).not.toBe(startedAt);
  });

  it("stops with exit 1, says another serve took over, and does not delete the lock that is not its own", async () => {
    const dir = await makeTempDir();
    const t = await serveWithClock(dir);
    const theirs = JSON.stringify({
      formatVersion: 1,
      processId: process.pid + 1,
      startedAt: t.clock.now().toISOString(),
      heartbeatAt: t.clock.now().toISOString(),
    });
    await writeFile(path.join(dir, "serve.lock"), theirs);
    await t.clock.advance(5000);
    expect(await t.exit).toBe(1);
    expect(t.err.lines()).toEqual([`Error: another imbehind serve took over ${dir}.`]);
    expect(await readFile(path.join(dir, "serve.lock"), "utf8")).toBe(theirs);
    expect(t.listeners()).toBe(0);
  });

  it("refuses to start while another serve runs, and leaves everything as it is", async () => {
    const dir = await makeTempDir();
    const store = await leaveRequest(dir, ID_A);
    await placeRunningLock(dir);
    const before = await readFile(path.join(dir, "serve.lock"), "utf8");
    const t = makeIo();
    const exit = await main(["serve"], t.io, { settings: { port: 0, storageDir: dir } });
    expect(exit).toBe(1);
    expect(t.err.lines()).toEqual([`Error: ${dir} is already used by another imbehind serve.`]);
    expect(t.out.text()).toBe("");
    expect(await readFile(path.join(dir, "serve.lock"), "utf8")).toBe(before);
    expect(await stateOf(store, ID_A)).toBe("waiting");
  });

  it("refuses a serve.lock that is not a lock file, without reading further or deleting it", async () => {
    const dir = await makeTempDir();
    const store = await leaveRequest(dir, ID_A);
    await writeFile(path.join(dir, "serve.lock"), "something else");
    const t = makeIo();
    const exit = await main(["serve"], t.io, { settings: { port: 0, storageDir: dir } });
    expect(exit).toBe(1);
    expect(t.err.lines()).toEqual([
      `Error: ${path.join(dir, "serve.lock")} is not an imbehind lock file. Remove it if no imbehind serve uses this directory.`,
    ]);
    expect(await readFile(path.join(dir, "serve.lock"), "utf8")).toBe("something else");
    expect(await stateOf(store, ID_A)).toBe("waiting");
  });

  it.skipIf(!canBeDenied)(
    "ends with 'cannot read <dir>/serve.lock' and exit 1 for a serve.lock that the permissions forbid reading, and keeps it",
    async () => {
      const dir = await makeTempDir();
      const store = await leaveRequest(dir, ID_A);
      const lockFile = path.join(dir, "serve.lock");
      await writeFile(lockFile, "something else");
      await chmod(lockFile, 0o000);
      const t = makeIo();
      try {
        const exit = await main(["serve"], t.io, { settings: { port: 0, storageDir: dir } });
        expect(exit).toBe(1);
        expect(t.err.lines()).toEqual([`Error: cannot read ${lockFile}: permission denied.`]);
        expect(t.out.text()).toBe("");
      } finally {
        await chmod(lockFile, 0o600);
      }
      expect(await readFile(lockFile, "utf8")).toBe("something else");
      expect(await stateOf(store, ID_A)).toBe("waiting");
    },
  );

  it("takes over a lock whose process is gone, or whose heartbeat is old, without any manual work", async () => {
    const gone = await deadProcessId();
    for (const [processId, ageMs] of [
      [gone, 1000],
      [process.pid, 30000],
    ] as const) {
      const dir = await makeTempDir();
      const at = new Date(Date.now() - ageMs).toISOString();
      await writeFile(
        path.join(dir, "serve.lock"),
        JSON.stringify({ formatVersion: 1, processId, startedAt: at, heartbeatAt: at }),
      );
      const t = await startServe(dir, 0);
      expect(t.err.text()).toBe("");
      expect(JSON.parse(await readFile(path.join(dir, "serve.lock"), "utf8"))).toMatchObject({
        processId: process.pid,
      });
      t.interrupt();
      expect(await t.exit).toBe(130);
    }
  });
});

describe("the first sweep", () => {
  it("deletes an old finished request while serve already takes requests, and keeps the others", async () => {
    const dir = await makeTempDir();
    const old = await leaveRequest(dir, ID_A, "replied", "2026-10-07T00:00:00.000Z");
    const recent = await leaveRequest(dir, ID_B, "replied", "2026-10-09T14:00:00.000Z");
    const t = await serveWithClock(dir);
    await waitFor(async () => (await old.listIds()).length === 1);
    expect(await recent.listIds()).toEqual([ID_B]);
    const port = Number(/:(\d+) \(storage/.exec(t.out.text())?.[1]);
    expect(await get(port, "/nothing")).toBe(404);
  });

  it("does nothing with --retention 0", async () => {
    const dir = await makeTempDir();
    const old = await leaveRequest(dir, ID_A, "replied", "2026-10-07T00:00:00.000Z");
    const t = await serveWithClock(dir, {}, ["--retention", "0"]);
    await t.clock.advance(5000);
    expect(await old.listIds()).toEqual([ID_A]);
  });

  it("says once that it kept a folder with a file of someone else", async () => {
    const dir = await makeTempDir();
    await leaveRequest(dir, ID_A, "replied", "2026-10-07T00:00:00.000Z");
    await writeFile(path.join(dir, "requests", ID_A, "notes.txt"), "mine");
    const t = await serveWithClock(dir, {}, ["--sweep-interval", "1"]);
    await waitFor(() => t.out.text().includes("kept unknown files"));
    await t.clock.advance(1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    await t.clock.advance(1000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(t.out.text().match(/kept unknown files/g)).toHaveLength(1);
    expect(t.out.text()).toMatch(/ error {6}aaaaaa {2}kept unknown files\n/);
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
    let armed = false;
    // Once serve listens: the broker reads the time once to save the request, and the log line
    // reads it again and fails. The start itself reads the time as it likes.
    const clock: Clock = {
      now: () => {
        if (armed) {
          calls += 1;
        }
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
    armed = true;
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
    const t = makeIo(undefined, undefined, false, "interactive");
    const storageDir = await makeTempDir();
    await placeRunningLock(storageDir);
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
    expect(t.err.text()).toBe(
      `Error: port ${first.port} is already in use. Choose another port with --port or IMBEHIND_PORT.\n`,
    );
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
    const exit = main(["serve"], t.io, { settings: { port: 0, storageDir } });
    await waitFor(() => t.out.text().includes("Listening on"));
    const port = Number(/Listening on http:\/\/127\.0\.0\.1:(\d+) /.exec(t.out.text())?.[1]);
    // A request that arrives after the start waits, and stays as it is when serve ends.
    const client = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "Hello" }] }),
    }).catch(() => undefined);
    await waitFor(async () => (await store.listIds()).length === 1);
    const [id] = await store.listIds();
    breakStream(t.io.stdout);
    expect(await exit).toBe(1);
    await client;
    expect(t.err.text()).toBe(UNEXPECTED);
    expectNothingRevealed(t.err.text(), t.out.text());
    expect(t.listeners()).toBe(0);
    expect(t.fatalListeners()).toBe(0);
    const state = await store.readState(id as string);
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
    const t = makeIo(undefined, undefined, false, "interactive");
    const storageDir = await makeTempDir();
    await placeRunningLock(storageDir);
    const exit = main(["answer"], t.io, { settings: { port: 0, storageDir } });
    await waitFor(() => t.out.text().includes("Waiting for requests"));
    breakStream(t.io.stdout);
    expect(await exit).toBe(1);
    expect(t.err.text()).toBe(UNEXPECTED);
    expectNothingRevealed(t.err.text());
    expect(t.listeners()).toBe(0);
    expect(t.fatalListeners()).toBe(0);
  });

  it("writes the fixed line once when several streams break", async () => {
    const t = makeIo(undefined, undefined, false, "interactive");
    const storageDir = await makeTempDir();
    await placeRunningLock(storageDir);
    const exit = main(["answer"], t.io, { settings: { port: 0, storageDir } });
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
      const storageDir = await makeTempDir();
      await placeRunningLock(storageDir);
      const exit = main([command], t.io, { settings: { port: 0, storageDir } });
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
    expect(exit).toBe(2);
    const after = t.io.stdout.listenerCount("error") + t.io.stderr.listenerCount("error");
    expect(after).toBe(before);
    expect(t.fatalListeners()).toBe(0);
  });
});
