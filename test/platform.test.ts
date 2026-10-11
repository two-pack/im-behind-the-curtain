import { EventEmitter } from "node:events";
import { link, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AlreadyExistsError, IoFailure } from "../src/errors.js";
import {
  ctrlZEndsInput,
  currentPlatformInfo,
  defaultStorageDir,
  endOfInputHint,
  linkExclusive,
  missingStorageBaseMessage,
  onFatalError,
  onInterrupt,
} from "../src/platform.js";
import { errno, makeTempDir } from "./helpers/fs.js";

describe("default storage directory", () => {
  it("is under XDG_DATA_HOME or ~/.local/share on Linux", () => {
    expect(
      defaultStorageDir({ platform: "linux", env: { XDG_DATA_HOME: "/x" }, homedir: "/h" }),
    ).toBe("/x/imbehind");
    expect(defaultStorageDir({ platform: "linux", env: {}, homedir: "/h" })).toBe(
      "/h/.local/share/imbehind",
    );
  });

  it("is under Application Support on macOS", () => {
    expect(defaultStorageDir({ platform: "darwin", env: {}, homedir: "/Users/a" })).toBe(
      "/Users/a/Library/Application Support/imbehind",
    );
  });

  it("is under LOCALAPPDATA on Windows, with backslashes", () => {
    expect(
      defaultStorageDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\L" }, homedir: "C:\\u" }),
    ).toBe("C:\\L\\imbehind");
  });

  it("is unknown when the base directory is missing", () => {
    expect(defaultStorageDir({ platform: "linux", env: {}, homedir: undefined })).toBeUndefined();
    expect(defaultStorageDir({ platform: "darwin", env: {}, homedir: undefined })).toBeUndefined();
    expect(defaultStorageDir({ platform: "win32", env: {}, homedir: "C:\\u" })).toBeUndefined();
  });

  it("explains what is missing when the base directory is unknown", () => {
    expect(missingStorageBaseMessage("linux")).toMatch(/home directory/);
    expect(missingStorageBaseMessage("darwin")).toMatch(/home directory/);
    expect(missingStorageBaseMessage("win32")).toMatch(/LOCALAPPDATA/);
  });

  it("reads the real platform of this process", () => {
    const info = currentPlatformInfo();
    expect(info.platform).toBe(process.platform);
    expect(info.env).toBe(process.env);
  });
});

describe("ending input with Ctrl+Z", () => {
  it("is done by this program only on Windows", () => {
    expect(ctrlZEndsInput("win32")).toBe(true);
    expect(ctrlZEndsInput("linux")).toBe(false);
    expect(ctrlZEndsInput("darwin")).toBe(false);
  });
});

describe("end of input hint", () => {
  it("names the key for every operating system", () => {
    expect(endOfInputHint()).toBe("Ctrl+D (Windows: Ctrl+Z, then Enter)");
  });
});

describe("exclusive hard link", () => {
  it("creates a second name for the same bytes", async () => {
    const dir = await makeTempDir();
    const source = path.join(dir, "source");
    const target = path.join(dir, "target");
    await writeFile(source, "hello");
    await linkExclusive(link, source, target);
    expect(await readFile(target, "utf8")).toBe("hello");
  });

  it("fails with AlreadyExistsError when the target exists, and does not replace it", async () => {
    const dir = await makeTempDir();
    const source = path.join(dir, "source");
    const target = path.join(dir, "target");
    await writeFile(source, "new");
    await writeFile(target, "old");
    await expect(linkExclusive(link, source, target)).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(await readFile(target, "utf8")).toBe("old");
  });

  it("fails with an IoFailure for any other cause, with a short reason", async () => {
    const dir = await makeTempDir();
    const missing = linkExclusive(link, path.join(dir, "nothing"), path.join(dir, "target"));
    await expect(missing).rejects.toMatchObject({
      name: "IoFailure",
      reason: "link failed",
      detail: "no such file or directory",
    });
    const refused = linkExclusive(() => Promise.reject(errno("EPERM")), "a", "b");
    await expect(refused).rejects.toBeInstanceOf(IoFailure);
    await expect(refused).rejects.toMatchObject({ detail: "operation not permitted" });
  });
});

describe("interrupt handling", () => {
  it("calls the handler on SIGINT and stops after it is disposed", () => {
    const target = new EventEmitter();
    let calls = 0;
    const dispose = onInterrupt(() => {
      calls += 1;
    }, target);
    target.emit("SIGINT");
    expect(calls).toBe(1);
    dispose();
    expect(target.listenerCount("SIGINT")).toBe(0);
    target.emit("SIGINT");
    expect(calls).toBe(1);
  });
});

describe("fatal error handling", () => {
  it("calls the handler for an uncaught exception and an unhandled rejection until disposed", () => {
    const target = new EventEmitter();
    let calls = 0;
    const dispose = onFatalError(() => {
      calls += 1;
    }, target);
    target.emit("uncaughtException");
    target.emit("unhandledRejection");
    expect(calls).toBe(2);
    dispose();
    expect(target.listenerCount("uncaughtException")).toBe(0);
    expect(target.listenerCount("unhandledRejection")).toBe(0);
  });
});
