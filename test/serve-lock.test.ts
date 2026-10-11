import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IoFailure, StartupError } from "../src/errors.js";
import {
  inspectLock,
  LOCK_FILE,
  type LockFs,
  nodeLockFs,
  ServeLock,
  type ServeLockOptions,
} from "../src/store/serve-lock.js";
import { FakeClock, settle } from "./helpers/fake-clock.js";
import { errno, makeTempDir } from "./helpers/fs.js";
import { waitFor } from "./helpers/io.js";

const OWN_PID = 4242;
const OTHER_PID = 777;
const posixOnly = process.platform === "win32" ? it.skip : it;

function iso(clock: FakeClock, offsetMs = 0): string {
  return new Date(clock.now().getTime() + offsetMs).toISOString();
}

function lockText(pid: number, startedAt: string, heartbeatAt: string): string {
  return JSON.stringify({ formatVersion: 1, processId: pid, startedAt, heartbeatAt }, null, 2);
}

/** The processes that count as alive in a test. */
function aliveAmong(...pids: number[]): (pid: number) => boolean {
  return (pid) => pids.includes(pid);
}

async function setup(overrides: Partial<ServeLockOptions> = {}) {
  const rootDir = await makeTempDir();
  const clock = new FakeClock();
  const lockPath = path.join(rootDir, LOCK_FILE);
  const lock = new ServeLock({
    rootDir,
    platform: process.platform,
    clock,
    processId: OWN_PID,
    isProcessAlive: aliveAmong(OWN_PID, OTHER_PID),
    ...overrides,
  });
  return { rootDir, clock, lockPath, lock };
}

async function readLock(lockPath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
}

describe("taking serve.lock", () => {
  it("places a lock with the format version, the process id and one time for both stamps", async () => {
    const { lock, lockPath, clock, rootDir } = await setup();
    await lock.acquire();
    expect(await readLock(lockPath)).toEqual({
      formatVersion: 1,
      processId: OWN_PID,
      startedAt: iso(clock),
      heartbeatAt: iso(clock),
    });
    expect(iso(clock)).toMatch(/\.\d{3}Z$/);
    expect(await readdir(rootDir)).toEqual([LOCK_FILE]);
  });

  posixOnly("gives the lock the mode 0600", async () => {
    const { lock, lockPath } = await setup();
    await lock.acquire();
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
  });

  it("stops with the busy sentence when a running serve holds the lock, and leaves it alone", async () => {
    const { lock, lockPath, rootDir, clock } = await setup();
    const theirs = lockText(OTHER_PID, iso(clock, -60000), iso(clock, -3000));
    await writeFile(lockPath, theirs);
    const failure = lock.acquire();
    await expect(failure).rejects.toBeInstanceOf(StartupError);
    await expect(failure).rejects.toThrow(`${rootDir} is already used by another imbehind serve.`);
    expect(await readFile(lockPath, "utf8")).toBe(theirs);
    expect(await readdir(rootDir)).toEqual([LOCK_FILE]);
  });

  it("takes over a lock whose process is not alive", async () => {
    const { lock, lockPath, clock } = await setup({ isProcessAlive: aliveAmong(OWN_PID) });
    await writeFile(lockPath, lockText(OTHER_PID, iso(clock, -60000), iso(clock, -1000)));
    await lock.acquire();
    expect(await readLock(lockPath)).toMatchObject({ processId: OWN_PID, startedAt: iso(clock) });
  });

  it("takes over a lock whose heartbeat is older than 15 seconds, but not one exactly 15 seconds old", async () => {
    const stale = await setup();
    await writeFile(
      stale.lockPath,
      lockText(OTHER_PID, iso(stale.clock, -60000), iso(stale.clock, -15001)),
    );
    await stale.lock.acquire();
    expect(await readLock(stale.lockPath)).toMatchObject({ processId: OWN_PID });

    const edge = await setup();
    await writeFile(
      edge.lockPath,
      lockText(OTHER_PID, iso(edge.clock, -60000), iso(edge.clock, -15000)),
    );
    await expect(edge.lock.acquire()).rejects.toThrow(/already used by another imbehind serve/);
  });

  it("takes over a lock whose heartbeat is more than 15 seconds in the future, but not one a little ahead", async () => {
    const future = await setup();
    await writeFile(
      future.lockPath,
      lockText(OTHER_PID, iso(future.clock), iso(future.clock, 15001)),
    );
    await future.lock.acquire();
    expect(await readLock(future.lockPath)).toMatchObject({ processId: OWN_PID });

    const ahead = await setup();
    await writeFile(ahead.lockPath, lockText(OTHER_PID, iso(ahead.clock), iso(ahead.clock, 5000)));
    await expect(ahead.lock.acquire()).rejects.toThrow(/already used/);
  });

  it("does not use startedAt for the verdict", async () => {
    const { lock, lockPath, clock } = await setup();
    await writeFile(lockPath, lockText(OTHER_PID, iso(clock, -86400000), iso(clock, -1000)));
    await expect(lock.acquire()).rejects.toThrow(/already used/);
  });

  it("stops without reading further or deleting when the file is not a lock of this program", async () => {
    const wrong = [
      "not json at all",
      "[]",
      JSON.stringify({ formatVersion: 2, processId: 1, startedAt: "a", heartbeatAt: "b" }),
      JSON.stringify({ formatVersion: 1, processId: 1, startedAt: "2026-01-01T00:00:00.000Z" }),
      JSON.stringify({ formatVersion: 1, processId: "1", startedAt: "x", heartbeatAt: "y" }),
      JSON.stringify({
        formatVersion: 1,
        processId: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        heartbeatAt: "yesterday",
      }),
      "",
    ];
    for (const text of wrong) {
      const { lock, lockPath, rootDir } = await setup({ isProcessAlive: aliveAmong() });
      await writeFile(lockPath, text);
      const failure = lock.acquire();
      await expect(failure).rejects.toBeInstanceOf(StartupError);
      await expect(failure).rejects.toThrow(
        `${lockPath} is not an imbehind lock file. Remove it if no imbehind serve uses this directory.`,
      );
      expect(await readFile(lockPath, "utf8")).toBe(text);
      expect(await readdir(rootDir)).toEqual([LOCK_FILE]);
    }
  });

  it("treats a directory called serve.lock as not a lock file", async () => {
    const { lock, lockPath } = await setup();
    await mkdir(lockPath);
    await expect(lock.acquire()).rejects.toThrow(/is not an imbehind lock file/);
  });

  it("removes a stale lock only when its content is unchanged on the second read", async () => {
    const { rootDir, lockPath, clock } = await setup();
    const stale = lockText(OTHER_PID, iso(clock, -60000), iso(clock, -40000));
    const fresh = lockText(OTHER_PID, iso(clock, -60000), iso(clock, -1000));
    await writeFile(lockPath, stale);
    let reads = 0;
    const fs: LockFs = {
      ...nodeLockFs,
      readFile: async (file) => {
        reads += 1;
        if (reads === 2) {
          // Another serve renews its lock between the verdict and the removal.
          await writeFile(lockPath, fresh);
        }
        return nodeLockFs.readFile(file);
      },
    };
    const lock = new ServeLock({
      rootDir,
      platform: process.platform,
      clock,
      processId: OWN_PID,
      isProcessAlive: aliveAmong(OWN_PID, OTHER_PID),
      fs,
    });
    await expect(lock.acquire()).rejects.toThrow(/already used by another imbehind serve/);
    expect(await readFile(lockPath, "utf8")).toBe(fresh);
  });

  it("stops with the busy sentence when the lock read back after placing is not ours", async () => {
    const { rootDir, clock } = await setup();
    const theirs = lockText(OTHER_PID, iso(clock, -1000), iso(clock, -1000));
    const fs: LockFs = {
      ...nodeLockFs,
      readFile: (file) =>
        file.endsWith(LOCK_FILE) ? Promise.resolve(theirs) : nodeLockFs.readFile(file),
    };
    const lock = new ServeLock({
      rootDir,
      platform: process.platform,
      clock,
      processId: OWN_PID,
      isProcessAlive: aliveAmong(OWN_PID, OTHER_PID),
      fs,
    });
    await expect(lock.acquire()).rejects.toThrow(`${rootDir} is already used`);
  });

  it("names the place and the reason when the lock cannot be created, and leaves no temporary file", async () => {
    for (const [fault, phrase] of [
      [{ link: () => Promise.reject(errno("EPERM")) }, "operation not permitted"],
      [{ writeFile: () => Promise.reject(errno("EACCES")) }, "permission denied"],
    ] as const) {
      const { rootDir, clock } = await setup();
      const lock = new ServeLock({
        rootDir,
        platform: process.platform,
        clock,
        processId: OWN_PID,
        fs: { ...nodeLockFs, ...fault },
      });
      const failure = lock.acquire();
      await expect(failure).rejects.toBeInstanceOf(StartupError);
      await expect(failure).rejects.toThrow(
        `cannot create ${path.join(rootDir, LOCK_FILE)}: ${phrase}.`,
      );
      expect(await readdir(rootDir)).toEqual([]);
    }
  });

  it("names the place and the reason when an existing lock cannot be read", async () => {
    const { rootDir, lockPath, clock } = await setup();
    await writeFile(lockPath, "x");
    const lock = new ServeLock({
      rootDir,
      platform: process.platform,
      clock,
      processId: OWN_PID,
      fs: { ...nodeLockFs, readFile: () => Promise.reject(errno("EACCES")) },
    });
    await expect(lock.acquire()).rejects.toThrow(`cannot read ${lockPath}: permission denied.`);
  });
});

/** chmod 000 does not stop the superuser, so these tests only run for other users. */
const canBeDenied = process.platform !== "win32" && process.getuid?.() !== 0;

describe("a serve.lock that cannot be read is not a foreign one", () => {
  it.skipIf(!canBeDenied)(
    "names the file and the reason when the permissions forbid reading it, and keeps the file",
    async () => {
      const { rootDir, lockPath, lock, clock } = await setup();
      const theirs = lockText(OTHER_PID, iso(clock, -60000), iso(clock, -3000));
      await writeFile(lockPath, theirs);
      await chmod(lockPath, 0o000);
      try {
        const failure = lock.acquire();
        await expect(failure).rejects.toBeInstanceOf(StartupError);
        await expect(failure).rejects.toThrow(
          new RegExp(`^cannot read ${lockPath}: permission denied\\.$`),
        );
        await expect(failure).rejects.not.toThrow(/not an imbehind lock file/);
        await expect(inspectLock({ rootDir, clock })).rejects.toMatchObject({
          name: "IoFailure",
          detail: "permission denied",
        });
      } finally {
        await chmod(lockPath, 0o600);
      }
      expect(await readFile(lockPath, "utf8")).toBe(theirs);
      expect(await readdir(rootDir)).toEqual([LOCK_FILE]);
    },
  );

  it("names the file and the reason for another input/output failure, and deletes nothing", async () => {
    const { rootDir, lockPath, clock } = await setup();
    await writeFile(lockPath, lockText(OTHER_PID, iso(clock, -60000), iso(clock, -90000)));
    const lock = new ServeLock({
      rootDir,
      platform: process.platform,
      clock,
      processId: OWN_PID,
      isProcessAlive: aliveAmong(OWN_PID),
      fs: { ...nodeLockFs, readFile: () => Promise.reject(errno("EIO")) },
    });
    await expect(lock.acquire()).rejects.toThrow(`cannot read ${lockPath}: input/output error.`);
    expect(await readdir(rootDir)).toEqual([LOCK_FILE]);
  });

  it("calls a file that can be read but is not a lock foreign, and never removes it", async () => {
    for (const content of ["", "plain text", "[]", "null", '{"formatVersion":2}']) {
      const { rootDir, lockPath, lock } = await setup();
      await writeFile(lockPath, content);
      await expect(lock.acquire()).rejects.toThrow(`${lockPath} is not an imbehind lock file.`);
      expect(await readFile(lockPath, "utf8")).toBe(content);
      expect(await readdir(rootDir)).toEqual([LOCK_FILE]);
    }
  });

  it("calls a directory in the place of the lock foreign, not unreadable, and leaves it", async () => {
    const { rootDir, lockPath, lock, clock } = await setup();
    await mkdir(lockPath);
    expect((await inspectLock({ rootDir, clock })).kind).toBe("foreign");
    await expect(lock.acquire()).rejects.toThrow(/is not an imbehind lock file/);
    expect((await stat(lockPath)).isDirectory()).toBe(true);
  });
});

describe("renewing and returning serve.lock", () => {
  it("rewrites heartbeatAt and keeps the rest, through a hidden file and a rename", async () => {
    const calls: string[] = [];
    const fs: LockFs = {
      ...nodeLockFs,
      writeFile: (file, data, mode) => {
        calls.push(`write ${path.basename(file)}`);
        return nodeLockFs.writeFile(file, data, mode);
      },
      rename: (from, to) => {
        calls.push(`rename ${path.basename(from)} ${path.basename(to)}`);
        return nodeLockFs.rename(from, to);
      },
    };
    const { lock, lockPath, clock, rootDir } = await setup({ fs });
    await lock.acquire();
    const startedAt = iso(clock);
    calls.length = 0;
    await clock.advance(5000);
    expect(await lock.heartbeat()).toBe("renewed");
    expect(await readLock(lockPath)).toEqual({
      formatVersion: 1,
      processId: OWN_PID,
      startedAt,
      heartbeatAt: iso(clock),
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/^write \..*\.tmp$/);
    expect(calls[1]).toMatch(/^rename \..*\.tmp serve\.lock$/);
    expect(await readdir(rootDir)).toEqual([LOCK_FILE]);
  });

  posixOnly("keeps the mode 0600 on the rewritten lock", async () => {
    const { lock, lockPath, clock } = await setup();
    await lock.acquire();
    await clock.advance(5000);
    await lock.heartbeat();
    expect((await stat(lockPath)).mode & 0o777).toBe(0o600);
  });

  it("says the lock is lost, and leaves the file as it is, when it is not ours any more", async () => {
    const { lock, lockPath, clock } = await setup();
    await lock.acquire();
    const theirs = lockText(OTHER_PID, iso(clock), iso(clock));
    await writeFile(lockPath, theirs);
    expect(await lock.heartbeat()).toBe("lost");
    expect(await readFile(lockPath, "utf8")).toBe(theirs);
    await writeFile(lockPath, "garbage");
    expect(await lock.heartbeat()).toBe("lost");
    expect(await readFile(lockPath, "utf8")).toBe("garbage");
  });

  it("says the lock is lost when it was taken over with the same process id but another start", async () => {
    const { lock, lockPath, clock } = await setup();
    await lock.acquire();
    await writeFile(lockPath, lockText(OWN_PID, iso(clock, 1), iso(clock, 1)));
    expect(await lock.heartbeat()).toBe("lost");
  });

  it("says the lock is lost when serve.lock has gone", async () => {
    const { lock, rootDir } = await setup();
    await lock.acquire();
    await nodeLockFs.unlink(path.join(rootDir, LOCK_FILE));
    expect(await lock.heartbeat()).toBe("lost");
  });

  it("says a rewrite failed, without giving up, and renews at the next try", async () => {
    let failures = 1;
    const fs: LockFs = {
      ...nodeLockFs,
      rename: (from, to) => {
        if (failures > 0) {
          failures -= 1;
          return Promise.reject(errno("EBUSY"));
        }
        return nodeLockFs.rename(from, to);
      },
    };
    const { lock, rootDir, clock } = await setup({ fs });
    await lock.acquire();
    await clock.advance(5000);
    expect(await lock.heartbeat()).toBe("failed");
    expect(await readdir(rootDir)).toEqual([LOCK_FILE]);
    expect(await lock.heartbeat()).toBe("renewed");
  });

  it("says a rewrite failed when the lock cannot be read", async () => {
    const { lock, rootDir, clock } = await setup();
    await lock.acquire();
    const broken = new ServeLock({
      rootDir,
      platform: process.platform,
      clock,
      processId: OWN_PID,
      fs: { ...nodeLockFs, readFile: () => Promise.reject(errno("EIO")) },
    });
    expect(await broken.heartbeat()).toBe("failed");
  });

  it("removes the lock on release when it is ours, and only then", async () => {
    const mine = await setup();
    await mine.lock.acquire();
    await mine.lock.release();
    expect(await readdir(mine.rootDir)).toEqual([]);

    const theirs = await setup();
    await theirs.lock.acquire();
    const text = lockText(OTHER_PID, iso(theirs.clock), iso(theirs.clock));
    await writeFile(theirs.lockPath, text);
    await theirs.lock.release();
    expect(await readFile(theirs.lockPath, "utf8")).toBe(text);
  });

  it("says nothing when the lock is already gone or cannot be removed", async () => {
    const gone = await setup();
    await expect(gone.lock.release()).resolves.toBeUndefined();
    let broken = false;
    const fs: LockFs = {
      ...nodeLockFs,
      unlink: (file) => (broken ? Promise.reject(errno("EBUSY")) : nodeLockFs.unlink(file)),
    };
    const stuck = await setup({ fs });
    await stuck.lock.acquire();
    broken = true;
    await expect(stuck.lock.release()).resolves.toBeUndefined();
    expect((await readLock(stuck.lockPath)).processId).toBe(OWN_PID);
  });
});

/** Waits until the loop sleeps, then lets 5 seconds pass. The file work takes real time. */
async function tick(clock: FakeClock): Promise<void> {
  await waitFor(() => clock.sleeping === 1);
  await clock.advance(5000);
}

describe("the heartbeat loop", () => {
  it("renews every 5 seconds without waiting for anything else", async () => {
    const { lock, lockPath, clock } = await setup();
    await lock.acquire();
    const beat = lock.startHeartbeat({ onLost: () => {}, onFailure: () => {} });
    for (let round = 0; round < 2; round += 1) {
      await tick(clock);
      await waitFor(async () => (await readLock(lockPath)).heartbeatAt === iso(clock));
    }
    await beat.stop();
  });

  it("calls onLost once and ends when the lock is taken over, without deleting it", async () => {
    const { lock, lockPath, clock } = await setup();
    await lock.acquire();
    let lost = 0;
    const beat = lock.startHeartbeat({ onLost: () => (lost += 1), onFailure: () => {} });
    const theirs = lockText(OTHER_PID, iso(clock), iso(clock));
    await writeFile(lockPath, theirs);
    await tick(clock);
    await waitFor(() => lost === 1);
    expect(clock.sleeping).toBe(0);
    expect(await readFile(lockPath, "utf8")).toBe(theirs);
    await beat.stop();
    expect(lost).toBe(1);
  });

  it("does not stop for a failed rewrite", async () => {
    let failing = true;
    const fs: LockFs = {
      ...nodeLockFs,
      rename: (from, to) =>
        failing ? Promise.reject(errno("EBUSY")) : nodeLockFs.rename(from, to),
    };
    const { lock, lockPath, clock } = await setup({ fs });
    await lock.acquire();
    let lost = 0;
    const beat = lock.startHeartbeat({ onLost: () => (lost += 1), onFailure: () => {} });
    await tick(clock);
    await tick(clock);
    failing = false;
    await tick(clock);
    await waitFor(async () => (await readLock(lockPath)).heartbeatAt === iso(clock));
    expect(lost).toBe(0);
    await beat.stop();
  });

  it("stops renewing after stop(), and stop() waits for a rewrite in progress", async () => {
    const { lock, lockPath, clock } = await setup();
    await lock.acquire();
    const beat = lock.startHeartbeat({ onLost: () => {}, onFailure: () => {} });
    await beat.stop();
    const before = await readFile(lockPath, "utf8");
    await clock.advance(10000);
    await settle();
    expect(await readFile(lockPath, "utf8")).toBe(before);
    expect(clock.sleeping).toBe(0);
  });

  it("passes an unexpected failure of the loop to onFailure", async () => {
    const { rootDir } = await setup();
    const failing = new FakeClock();
    failing.sleep = () => Promise.reject(new Error("clock broke"));
    const lock = new ServeLock({ rootDir, platform: process.platform, clock: failing });
    await lock.acquire();
    const seen: unknown[] = [];
    const beat = lock.startHeartbeat({ onLost: () => {}, onFailure: (error) => seen.push(error) });
    await beat.stop();
    expect(seen).toHaveLength(1);
  });
});

describe("looking at serve.lock without taking it", () => {
  async function inspectWith(
    text: string | undefined,
    alive: (pid: number) => boolean = aliveAmong(OTHER_PID),
  ) {
    const rootDir = await makeTempDir();
    const clock = new FakeClock();
    if (text !== undefined) {
      await writeFile(path.join(rootDir, LOCK_FILE), text);
    }
    return inspectLock({ rootDir, clock, isProcessAlive: alive });
  }

  it("says absent when there is no lock, and also when the storage directory does not exist", async () => {
    expect(await inspectWith(undefined)).toEqual({ kind: "absent" });
    const clock = new FakeClock();
    const missing = path.join(await makeTempDir(), "nowhere");
    expect(await inspectLock({ rootDir: missing, clock })).toEqual({ kind: "absent" });
  });

  it("says running, stale or foreign by the process, the heartbeat and the form", async () => {
    const clock = new FakeClock();
    const fresh = lockText(OTHER_PID, iso(clock, -90000), iso(clock, -2000));
    expect((await inspectWith(fresh)).kind).toBe("running");
    expect((await inspectWith(fresh, aliveAmong())).kind).toBe("stale");
    const old = lockText(OTHER_PID, iso(clock, -90000), iso(clock, -16000));
    expect((await inspectWith(old)).kind).toBe("stale");
    expect((await inspectWith("{}")).kind).toBe("foreign");
  });

  it("does not create anything", async () => {
    const rootDir = await makeTempDir();
    await inspectLock({ rootDir, clock: new FakeClock() });
    expect(await readdir(rootDir)).toEqual([]);
  });

  it("fails with the reason when the storage directory cannot be read", async () => {
    const clock = new FakeClock();
    const rootDir = await makeTempDir();
    const denied = inspectLock({
      rootDir,
      clock,
      fs: { ...nodeLockFs, readFile: () => Promise.reject(errno("EACCES")) },
    });
    await expect(denied).rejects.toBeInstanceOf(IoFailure);
    await expect(denied).rejects.toMatchObject({ detail: "permission denied" });
    const notDirectory = path.join(rootDir, "file");
    await writeFile(notDirectory, "x");
    await expect(inspectLock({ rootDir: notDirectory, clock })).rejects.toMatchObject({
      detail: "not a directory",
    });
  });
});

describe("no mode on Windows", () => {
  it("passes no mode when the platform is win32", async () => {
    const modes: Array<number | undefined> = [];
    const fs: LockFs = {
      ...nodeLockFs,
      writeFile: (file, data, mode) => {
        modes.push(mode);
        return nodeLockFs.writeFile(file, data, mode);
      },
    };
    const { rootDir, clock } = await setup();
    const lock = new ServeLock({ rootDir, platform: "win32", clock, processId: OWN_PID, fs });
    await lock.acquire();
    await clock.advance(5000);
    await lock.heartbeat();
    expect(modes).toEqual([undefined, undefined]);
  });

  posixOnly("passes 0600 on Linux and macOS", async () => {
    const modes: Array<number | undefined> = [];
    const fs: LockFs = {
      ...nodeLockFs,
      writeFile: (file, data, mode) => {
        modes.push(mode);
        return nodeLockFs.writeFile(file, data, mode);
      },
    };
    const { rootDir, clock } = await setup();
    const lock = new ServeLock({ rootDir, platform: "linux", clock, processId: OWN_PID, fs });
    await lock.acquire();
    await lock.heartbeat();
    expect(modes).toEqual([0o600, 0o600]);
  });
});

describe("the hidden file that serve.lock is placed from", () => {
  const FORM = new RegExp(`^\\.serve-lock\\.${OWN_PID}\\.\\d+\\.[0-9a-f]+\\.tmp$`);

  /** A file system that records the hidden names written and removed. */
  function watching(written: string[], removed: string[]): LockFs {
    return {
      ...nodeLockFs,
      writeFile: (file, data, mode) => {
        written.push(path.basename(file));
        return nodeLockFs.writeFile(file, data, mode);
      },
      unlink: (file) => {
        removed.push(path.basename(file));
        return nodeLockFs.unlink(file);
      },
    };
  }

  it("is named .serve-lock.<processId>.<seq>.<hex>.tmp and is removed after the lock was placed", async () => {
    const written: string[] = [];
    const removed: string[] = [];
    const { lock, rootDir } = await setup({ fs: watching(written, removed) });
    await lock.acquire();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(FORM);
    expect(removed).toEqual(written);
    expect(await readdir(rootDir)).toEqual([LOCK_FILE]);
  });

  it("is removed too when a lock exists and the start stops", async () => {
    const written: string[] = [];
    const removed: string[] = [];
    const { lock, lockPath, rootDir, clock } = await setup({ fs: watching(written, removed) });
    await writeFile(lockPath, lockText(OTHER_PID, iso(clock, -60000), iso(clock, -3000)));
    await expect(lock.acquire()).rejects.toBeInstanceOf(StartupError);
    expect(written[0]).toMatch(FORM);
    expect(removed).toEqual(written);
    expect(await readdir(rootDir)).toEqual([LOCK_FILE]);
  });

  it("does not overwrite the hidden file of another serve that starts at the same time", async () => {
    const written: string[] = [];
    const removed: string[] = [];
    const first = await setup({ fs: watching(written, removed) });
    const second = new ServeLock({
      rootDir: first.rootDir,
      platform: process.platform,
      clock: first.clock,
      processId: OWN_PID,
      isProcessAlive: aliveAmong(OWN_PID, OTHER_PID),
      fs: watching(written, removed),
    });
    const results = await Promise.allSettled([first.lock.acquire(), second.acquire()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(new Set(written).size).toBe(written.length);
    expect(written.every((name) => FORM.test(name))).toBe(true);
    expect(await readdir(first.rootDir)).toEqual([LOCK_FILE]);
  });
});
