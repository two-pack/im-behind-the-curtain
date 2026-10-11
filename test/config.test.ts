import { describe, expect, it } from "vitest";
import { DEFAULT_HOST, DEFAULT_PORT, loadSettings, POLL_INTERVAL_MS } from "../src/config.js";
import { StartupError } from "../src/errors.js";

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
