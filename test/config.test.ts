import { describe, expect, it } from "vitest";
import {
  createSettings,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_WAIT_LIMIT_SECONDS,
  loadSettings,
  POLL_INTERVAL_MS,
  resolveWaitLimit,
} from "../src/config.js";
import { InvalidOptionError, StartupError } from "../src/errors.js";

describe("default settings", () => {
  it("fixes the address to 127.0.0.1 port 3000 and polls every 500 milliseconds", () => {
    const settings = loadSettings({ platform: "linux", env: {}, homedir: "/home/alice" });
    expect(DEFAULT_HOST).toBe("127.0.0.1");
    expect(DEFAULT_PORT).toBe(3000);
    expect(POLL_INTERVAL_MS).toBe(500);
    expect(settings.host).toBe("127.0.0.1");
    expect(settings.port).toBe(3000);
    expect(settings.pollIntervalMs).toBe(500);
  });
});

describe("default storage directory", () => {
  it("uses XDG_DATA_HOME on Linux when it is set", () => {
    const settings = loadSettings({
      platform: "linux",
      env: { XDG_DATA_HOME: "/data/xdg" },
      homedir: "/home/alice",
    });
    expect(settings.storageDir).toBe("/data/xdg/imbehind");
  });

  it("falls back to ~/.local/share on Linux when XDG_DATA_HOME is unset or empty", () => {
    const unset = loadSettings({ platform: "linux", env: {}, homedir: "/home/alice" });
    const empty = loadSettings({
      platform: "linux",
      env: { XDG_DATA_HOME: "" },
      homedir: "/home/alice",
    });
    expect(unset.storageDir).toBe("/home/alice/.local/share/imbehind");
    expect(empty.storageDir).toBe("/home/alice/.local/share/imbehind");
  });

  it("uses Application Support on macOS", () => {
    const settings = loadSettings({ platform: "darwin", env: {}, homedir: "/Users/alice" });
    expect(settings.storageDir).toBe("/Users/alice/Library/Application Support/imbehind");
  });

  it("uses LOCALAPPDATA on Windows", () => {
    const settings = loadSettings({
      platform: "win32",
      env: { LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local" },
      homedir: "C:\\Users\\alice",
    });
    expect(settings.storageDir).toBe("C:\\Users\\alice\\AppData\\Local\\imbehind");
  });
});

describe("unknown home", () => {
  it("fails with a startup error when the home directory is unknown on Linux and macOS", () => {
    expect(() => loadSettings({ platform: "linux", env: {}, homedir: undefined })).toThrow(
      StartupError,
    );
    expect(() => loadSettings({ platform: "darwin", env: {}, homedir: undefined })).toThrow(
      StartupError,
    );
  });

  it("fails with a startup error when LOCALAPPDATA is unknown on Windows", () => {
    expect(() => loadSettings({ platform: "win32", env: {}, homedir: "C:\\Users\\a" })).toThrow(
      StartupError,
    );
  });

  it("explains the problem in English", () => {
    try {
      loadSettings({ platform: "linux", env: {}, homedir: undefined });
      expect.unreachable("loadSettings should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(StartupError);
      expect((error as StartupError).message).toMatch(/home directory/);
    }
  });
});

describe("the wait limit", () => {
  it("is 1800 seconds when nothing is given", () => {
    expect(DEFAULT_WAIT_LIMIT_SECONDS).toBe(1800);
    expect(resolveWaitLimit(undefined, {})).toBe(1800);
    expect(createSettings("/data").waitLimitSeconds).toBe(1800);
    expect(
      loadSettings({ platform: "linux", env: {}, homedir: "/home/alice" }).waitLimitSeconds,
    ).toBe(1800);
  });

  it("prefers the option over the environment variable over the default", () => {
    expect(resolveWaitLimit("5", { IMBEHIND_TIMEOUT: "9" })).toBe(5);
    expect(resolveWaitLimit(undefined, { IMBEHIND_TIMEOUT: "9" })).toBe(9);
    expect(resolveWaitLimit("5", {})).toBe(5);
  });

  it("treats an empty environment variable as not set", () => {
    expect(resolveWaitLimit(undefined, { IMBEHIND_TIMEOUT: "" })).toBe(1800);
  });

  it("accepts 0 as no limit and 2147483 as the largest value", () => {
    expect(resolveWaitLimit("0", {})).toBe(0);
    expect(resolveWaitLimit("2147483", {})).toBe(2147483);
    expect(resolveWaitLimit("007", {})).toBe(7);
  });

  it("rejects anything that is not digits only, naming the option and the value", () => {
    for (const bad of ["abc", "-1", "+5", "1.5", "1e3", " 5", "5 ", "", "2147484", "0x10"]) {
      expect(() => resolveWaitLimit(bad, {})).toThrow(InvalidOptionError);
      expect(() => resolveWaitLimit(bad, {})).toThrow(
        `--timeout must be a whole number of seconds from 0 to 2147483 (got "${bad}").`,
      );
    }
  });

  it("names the environment variable when the bad value came from it", () => {
    expect(() => resolveWaitLimit(undefined, { IMBEHIND_TIMEOUT: "abc" })).toThrow(
      'IMBEHIND_TIMEOUT must be a whole number of seconds from 0 to 2147483 (got "abc").',
    );
  });

  it("checks the option even when the environment variable is fine", () => {
    expect(() => resolveWaitLimit("abc", { IMBEHIND_TIMEOUT: "9" })).toThrow(InvalidOptionError);
  });

  it("is a startup error, so it is shown as an Error line", () => {
    expect(new InvalidOptionError("x")).toBeInstanceOf(StartupError);
  });
});
