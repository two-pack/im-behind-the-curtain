import { lstat, mkdir, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExchangeBroker } from "../src/broker/exchange-broker.js";
import type { IoReason } from "../src/errors.js";
import {
  type ConversationRequest,
  createRequestFile,
  createStateFile,
  serializeFile,
} from "../src/model.js";
import { ExchangeStore, nodeFs, type StoreFs } from "../src/store/exchange-store.js";
import { Sweeper } from "../src/sweeper/sweeper.js";
import { FakeClock, settle } from "./helpers/fake-clock.js";
import { errno, makeTempDir } from "./helpers/fs.js";
import { waitFor } from "./helpers/io.js";

const RETENTION = 3600;
const HOUR = 3600 * 1000;

const ID_A = "20261009T100000000Z-aaaaaa";
const ID_B = "20261009T100001000Z-bbbbbb";
const ID_C = "20261009T100002000Z-cccccc";

type Problem = [string | undefined, IoReason];

async function setup(overrides: Partial<StoreFs> = {}, retentionSeconds = RETENTION) {
  const root = await makeTempDir();
  const clock = new FakeClock();
  const store = new ExchangeStore({ rootDir: root, fs: { ...nodeFs, ...overrides } });
  await store.prepare();
  const broker = new ExchangeBroker({ store, clock, pollIntervalMs: 500 });
  const problems: Problem[] = [];
  const failures: unknown[] = [];
  const sweeper = new Sweeper({
    broker,
    clock,
    retentionSeconds,
    intervalSeconds: 1,
    onProblem: (id, reason) => problems.push([id, reason]),
  });
  const requests = path.join(root, "requests");
  return { root, requests, clock, store, broker, sweeper, problems, failures };
}

type Context = Awaited<ReturnType<typeof setup>>;

const request: ConversationRequest = {
  format: "chat.completions",
  model: "m",
  replyKind: "text",
  requiredShape: null,
  stream: false,
  includeUsage: false,
  conversation: [{ role: "user", content: "Hello" }],
  originalRequest: { model: "m" },
};

/** A request on disk whose state ended `agoMs` before the clock. */
async function addEnded(
  t: Context,
  id: string,
  state: string,
  agoMs: number,
  endedAt?: string | null,
) {
  const ended =
    endedAt === undefined ? new Date(t.clock.now().getTime() - agoMs).toISOString() : endedAt;
  const created = "2026-10-09T09:00:00.000Z";
  await t.store.createRequest(
    createRequestFile(id, created, request),
    createStateFile(id, "waiting", created, null),
  );
  const content = {
    formatVersion: 1,
    id,
    state,
    updatedAt: created,
    endedAt: ended,
    endReason: null,
  };
  await writeFile(path.join(t.requests, id, "state.json"), serializeFile(content));
}

async function present(t: Context): Promise<string[]> {
  return (await readdir(t.requests)).sort();
}

describe("what is deleted and what is not", () => {
  it("deletes the finished requests whose retention has passed, in every known ending state", async () => {
    const t = await setup();
    const states = ["replied", "skipped", "cancelled", "timed_out", "abandoned", "invalid_reply"];
    const ids = [
      ID_A,
      ID_B,
      ID_C,
      "20261009T100003000Z-dddddd",
      "20261009T100004000Z-eeeeee",
      "20261009T100005000Z-ffffff",
    ];
    for (const [index, state] of states.entries()) {
      await addEnded(t, ids[index] as string, state, HOUR + 1);
    }
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([]);
  });

  it("deletes at exactly the retention time and keeps a request that is a millisecond too new", async () => {
    const t = await setup();
    await addEnded(t, ID_A, "replied", HOUR);
    await addEnded(t, ID_B, "replied", HOUR - 1);
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([ID_B]);
  });

  it("never deletes a waiting request, however old", async () => {
    const t = await setup();
    await t.store.createRequest(
      createRequestFile(ID_A, "2020-01-01T00:00:00.000Z", request),
      createStateFile(ID_A, "waiting", "2020-01-01T00:00:00.000Z", null),
    );
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([ID_A]);
  });

  it("never deletes a request with an unreadable state, an unknown state, or a bad endedAt", async () => {
    const t = await setup();
    await addEnded(t, ID_A, "future-state", 10 * HOUR);
    await addEnded(t, ID_B, "replied", 0, null);
    await addEnded(t, ID_C, "replied", 0, "yesterday");
    const broken = "20261009T100003000Z-dddddd";
    await addEnded(t, broken, "replied", 10 * HOUR);
    await writeFile(path.join(t.requests, broken, "state.json"), "{ not json");
    const future = "20261009T100004000Z-eeeeee";
    await addEnded(t, future, "replied", -HOUR);
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([ID_A, ID_B, ID_C, broken, future]);
  });

  it("looks only at folders named like a request id, and at nothing without state.json", async () => {
    const t = await setup();
    await mkdir(path.join(t.requests, "not-an-id"));
    await writeFile(path.join(t.requests, "not-an-id", "state.json"), "x");
    await mkdir(path.join(t.requests, `.${ID_A}`));
    await writeFile(path.join(t.requests, "notes.txt"), "mine");
    await mkdir(path.join(t.requests, ID_B));
    await writeFile(path.join(t.requests, ID_B, "request.json"), "{}");
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([`.${ID_A}`, ID_B, "not-an-id", "notes.txt"]);
    expect(await readdir(path.join(t.requests, ID_B))).toEqual(["request.json"]);
  });

  it("removes the folder with the four known files and nothing else", async () => {
    const t = await setup();
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    for (const name of ["reply.json", "reply.accepted.json"]) {
      await writeFile(path.join(t.requests, ID_A, name), "{}");
    }
    expect((await readdir(path.join(t.requests, ID_A))).sort()).toEqual([
      "reply.accepted.json",
      "reply.json",
      "request.json",
      "state.json",
    ]);
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([]);
    expect((await stat(t.requests)).isDirectory()).toBe(true);
    expect(t.problems).toEqual([]);
  });
});

/** What a stopped accept leaves behind: a hidden copy in the temporary form. */
const LEFTOVER = ".reply.accepted.31337.12.0a1b2c3d.tmp";

describe("what a stopped accept leaves behind", () => {
  it("removes a folder that still holds a hidden copy of an accept, and removes state.json last", async () => {
    const order: string[] = [];
    const t = await setup({
      unlink: (file) => {
        order.push(path.basename(file));
        return nodeFs.unlink(file);
      },
    });
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    for (const name of ["reply.accepted.json", LEFTOVER]) {
      await writeFile(path.join(t.requests, ID_A, name), "{}");
    }
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([]);
    expect(order).toContain(LEFTOVER);
    expect(order[order.length - 1]).toBe("state.json");
    expect(t.problems).toEqual([]);
  });

  it("removes a folder that holds leftovers of the state, reply and reply.accepted kinds", async () => {
    const t = await setup();
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    for (const kind of ["state", "reply", "reply.accepted"]) {
      await writeFile(path.join(t.requests, ID_A, `.${kind}.4242.3.9f8e7d6c.tmp`), "{}");
    }
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([]);
    expect(t.problems).toEqual([]);
  });

  it("still keeps a folder that holds another hidden file next to such a leftover", async () => {
    const t = await setup();
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    await writeFile(path.join(t.requests, ID_A, LEFTOVER), "{}");
    await writeFile(path.join(t.requests, ID_A, ".other.tmp"), "{}");
    await t.sweeper.sweepOnce();
    expect((await readdir(path.join(t.requests, ID_A))).sort()).toEqual([
      ".other.tmp",
      LEFTOVER,
      "request.json",
      "state.json",
    ]);
    expect(t.problems).toEqual([[ID_A, "kept unknown files"]]);
  });

  it("keeps a folder whose dot file is the fixed name .reply.accepted.tmp, which no writer makes any more", async () => {
    const t = await setup();
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    await writeFile(path.join(t.requests, ID_A, ".reply.accepted.tmp"), "{}");
    await t.sweeper.sweepOnce();
    expect((await readdir(path.join(t.requests, ID_A))).sort()).toContain(".reply.accepted.tmp");
    expect(t.problems).toEqual([[ID_A, "kept unknown files"]]);
  });
});

describe.skipIf(process.platform === "win32")("entries that are not real directories", () => {
  it("neither follows nor deletes a symbolic link named like a request id", async () => {
    const t = await setup();
    const outside = await makeTempDir();
    await writeFile(
      path.join(outside, "state.json"),
      serializeFile(
        createStateFile(ID_A, "replied", "2020-01-01T00:00:00.000Z", "2020-01-01T00:00:00.000Z"),
      ),
    );
    await writeFile(path.join(outside, "request.json"), "{}");
    await symlink(outside, path.join(t.requests, ID_A));
    await addEnded(t, ID_B, "replied", 2 * HOUR);
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([ID_A]);
    expect((await lstat(path.join(t.requests, ID_A))).isSymbolicLink()).toBe(true);
    expect((await readdir(outside)).sort()).toEqual(["request.json", "state.json"]);
    expect(t.problems).toEqual([]);
  });

  it("ignores a symbolic link to a file as well", async () => {
    const t = await setup();
    const outside = path.join(await makeTempDir(), "target.txt");
    await writeFile(outside, "mine");
    await symlink(outside, path.join(t.requests, ID_A));
    await t.sweeper.sweepOnce();
    expect(await readFile(outside, "utf8")).toBe("mine");
    expect(await present(t)).toEqual([ID_A]);
  });
});

describe("a folder with files the server did not make", () => {
  it("keeps the folder untouched, and says so once for the request however often it looks", async () => {
    const t = await setup();
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    await writeFile(path.join(t.requests, ID_A, "notes.txt"), "mine");
    await addEnded(t, ID_B, "replied", 2 * HOUR);
    await writeFile(path.join(t.requests, ID_B, ".half.tmp"), "x");
    for (let pass = 0; pass < 3; pass += 1) {
      await t.sweeper.sweepOnce();
    }
    expect((await readdir(path.join(t.requests, ID_A))).sort()).toEqual([
      "notes.txt",
      "request.json",
      "state.json",
    ]);
    expect((await readdir(path.join(t.requests, ID_B))).sort()).toEqual([
      ".half.tmp",
      "request.json",
      "state.json",
    ]);
    expect(t.problems).toEqual([
      [ID_A, "kept unknown files"],
      [ID_B, "kept unknown files"],
    ]);
  });
});

describe.skipIf(process.platform === "win32")(
  "a folder with a directory or a link named like a known or temp file",
  () => {
    const TEMP_FORM = ".reply.4242.3.9f8e7d6c.tmp";

    for (const name of ["reply.accepted.json", TEMP_FORM]) {
      for (const kind of ["directory", "symbolic link"]) {
        it(`keeps the folder and says 'kept unknown files' once when ${name} is a ${kind}`, async () => {
          const t = await setup();
          await addEnded(t, ID_A, "replied", 2 * HOUR);
          const folder = path.join(t.requests, ID_A);
          const outside = path.join(await makeTempDir(), "target.txt");
          await writeFile(outside, "mine");
          if (kind === "directory") {
            await mkdir(path.join(folder, name));
          } else {
            await symlink(outside, path.join(folder, name));
          }
          for (let pass = 0; pass < 3; pass += 1) {
            await t.sweeper.sweepOnce();
          }
          expect((await readdir(folder)).sort()).toEqual([name, "request.json", "state.json"]);
          expect(await readFile(outside, "utf8")).toBe("mine");
          expect(t.problems).toEqual([[ID_A, "kept unknown files"]]);
        });
      }
    }
  },
);

describe("a delete that fails", () => {
  it("skips the request, goes on with the next ones, and tries again in the next pass", async () => {
    let broken = true;
    const t = await setup({
      unlink: (file) =>
        broken && file.includes(ID_A) ? Promise.reject(errno("EBUSY")) : nodeFs.unlink(file),
    });
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    await addEnded(t, ID_B, "replied", 2 * HOUR);
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([ID_A]);
    expect(t.problems).toEqual([[ID_A, "delete failed"]]);
    await t.sweeper.sweepOnce();
    expect(t.problems).toHaveLength(1);
    broken = false;
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([]);
  });

  it("reports a failure again when it comes back after the request was read or deleted well in between", async () => {
    let broken = true;
    const t = await setup({
      unlink: (file) =>
        broken && file.includes(ID_A) ? Promise.reject(errno("EBUSY")) : nodeFs.unlink(file),
    });
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    await t.sweeper.sweepOnce();
    await t.sweeper.sweepOnce();
    expect(t.problems).toEqual([[ID_A, "delete failed"]]);

    // The request is read well and is not due: the note that it was reported is dropped.
    await t.store.writeState(
      createStateFile(ID_A, "replied", "2026-10-09T09:00:00.000Z", t.clock.now().toISOString()),
    );
    await t.sweeper.sweepOnce();
    expect(t.problems).toHaveLength(1);

    // It becomes due and fails again: the line comes again, but only once.
    await t.store.writeState(
      createStateFile(
        ID_A,
        "replied",
        "2026-10-09T09:00:00.000Z",
        new Date(t.clock.now().getTime() - 2 * HOUR).toISOString(),
      ),
    );
    await t.sweeper.sweepOnce();
    await t.sweeper.sweepOnce();
    expect(t.problems).toEqual([
      [ID_A, "delete failed"],
      [ID_A, "delete failed"],
    ]);
    broken = false;
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([]);
  });

  it("reports a read failure again after the request was read well in between", async () => {
    let broken = true;
    const t = await setup({
      readFile: (file) =>
        broken && file.includes(ID_A) ? Promise.reject(errno("EIO")) : nodeFs.readFile(file),
    });
    await addEnded(t, ID_A, "waiting", 0);
    await t.sweeper.sweepOnce();
    broken = false;
    await t.sweeper.sweepOnce();
    broken = true;
    await t.sweeper.sweepOnce();
    expect(t.problems).toEqual([
      [ID_A, "read failed"],
      [ID_A, "read failed"],
    ]);
  });

  it("says 'kept unknown files' once for each request in the whole run, even after the failure notes were dropped", async () => {
    const t = await setup();
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    await writeFile(path.join(t.requests, ID_A, "notes.txt"), "mine");
    await t.sweeper.sweepOnce();
    await t.store.writeState(
      createStateFile(ID_A, "replied", "2026-10-09T09:00:00.000Z", t.clock.now().toISOString()),
    );
    await t.sweeper.sweepOnce();
    await t.store.writeState(
      createStateFile(
        ID_A,
        "replied",
        "2026-10-09T09:00:00.000Z",
        new Date(t.clock.now().getTime() - 2 * HOUR).toISOString(),
      ),
    );
    await t.sweeper.sweepOnce();
    await t.sweeper.sweepOnce();
    expect(t.problems).toEqual([[ID_A, "kept unknown files"]]);
  });

  it("reports a state that cannot be read, once, and goes on", async () => {
    const t = await setup({
      readFile: (file) =>
        file.includes(ID_A) ? Promise.reject(errno("EIO")) : nodeFs.readFile(file),
    });
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    await addEnded(t, ID_B, "replied", 2 * HOUR);
    await t.sweeper.sweepOnce();
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([ID_A]);
    expect(t.problems).toEqual([[ID_A, "read failed"]]);
  });

  it("reports a storage directory that cannot be listed once, without stopping the sweeper", async () => {
    let broken = true;
    const t = await setup({
      readdir: (dir) =>
        broken && dir.endsWith("requests") ? Promise.reject(errno("EACCES")) : nodeFs.readdir(dir),
    });
    await t.sweeper.sweepOnce();
    await t.sweeper.sweepOnce();
    expect(t.problems).toEqual([[undefined, "read failed"]]);
    broken = false;
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    await t.sweeper.sweepOnce();
    expect(await present(t)).toEqual([]);
    broken = true;
    await t.sweeper.sweepOnce();
    expect(t.problems).toHaveLength(2);
  });
});

describe("retention 0", () => {
  it("looks at nothing, deletes nothing and keeps no timer", async () => {
    let listings = 0;
    const t = await setup(
      {
        readdir: (dir) => {
          listings += 1;
          return nodeFs.readdir(dir);
        },
      },
      0,
    );
    await addEnded(t, ID_A, "replied", 1000 * HOUR);
    listings = 0;
    await t.sweeper.sweepOnce();
    const sweeping = t.sweeper.start(() => {});
    await settle();
    expect(listings).toBe(0);
    expect(t.clock.sleeping).toBe(0);
    await sweeping.stop();
    expect(await present(t)).toEqual([ID_A]);
  });
});

describe("when it runs", () => {
  it("starts the first pass at once, then waits the interval after each pass ends", async () => {
    const t = await setup();
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    const sweeping = t.sweeper.start((error) => t.failures.push(error));
    await waitFor(async () => (await present(t)).length === 0);
    await waitFor(() => t.clock.sleeping === 1);
    await addEnded(t, ID_B, "replied", 2 * HOUR);
    await t.clock.advance(999);
    await settle();
    expect(await present(t)).toEqual([ID_B]);
    await t.clock.advance(1);
    await waitFor(async () => (await present(t)).length === 0);
    await sweeping.stop();
    expect(t.failures).toEqual([]);
  });

  it("does not start a second pass while one is running", async () => {
    let listings = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = await setup({
      readdir: async (dir) => {
        if (dir.endsWith("requests")) {
          listings += 1;
          await gate;
        }
        return nodeFs.readdir(dir);
      },
    });
    listings = 0;
    const first = t.sweeper.sweepOnce();
    const second = t.sweeper.sweepOnce();
    await settle();
    expect(listings).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(listings).toBe(1);
  });

  it("does not wait for the first pass: start returns at once", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const t = await setup({
      readdir: async (dir) => {
        if (dir.endsWith("requests")) {
          await gate;
        }
        return nodeFs.readdir(dir);
      },
    });
    const sweeping = t.sweeper.start(() => {});
    expect(typeof sweeping.stop).toBe("function");
    release();
    await sweeping.stop();
  });

  it("on stop, finishes the delete in progress and starts no other", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding = false;
    const t = await setup({
      unlink: async (file) => {
        if (file.includes(ID_A)) {
          holding = true;
          await gate;
        }
        return nodeFs.unlink(file);
      },
    });
    await addEnded(t, ID_A, "replied", 2 * HOUR);
    await addEnded(t, ID_B, "replied", 2 * HOUR);
    await addEnded(t, ID_C, "replied", 2 * HOUR);
    const sweeping = t.sweeper.start(() => {});
    await waitFor(() => holding);
    let stopped = false;
    const stopping = sweeping.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(await present(t)).toEqual([ID_B, ID_C]);
  });

  it("passes an exception that escapes the loop to the caller and ends", async () => {
    const t = await setup();
    t.clock.sleep = () => Promise.reject(new Error("clock broke"));
    const sweeping = t.sweeper.start((error) => t.failures.push(error));
    await waitFor(() => t.failures.length === 1);
    await sweeping.stop();
    expect(t.failures).toHaveLength(1);
  });
});
