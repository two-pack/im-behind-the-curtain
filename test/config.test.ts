import { describe, expect, it } from "vitest";
import {
  createSettings,
  DEFAULT_HOST,
  DEFAULT_PORT,
  DEFAULT_RETENTION_SECONDS,
  DEFAULT_SWEEP_INTERVAL_SECONDS,
  DEFAULT_WAIT_LIMIT_SECONDS,
  loadSettings,
  type NameLookup,
  POLL_INTERVAL_MS,
  parseCommandLine,
  type RawOptions,
  resolveServeSettings,
  resolveStorageDir,
  resolveWaitLimit,
} from "../src/config.js";
import { InvalidOptionError, StartupError } from "../src/errors.js";
import type { PlatformInfo } from "../src/platform.js";

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

const INFO: PlatformInfo = { platform: "linux", env: {}, homedir: "/home/alice", cwd: "/work" };
const LOOPBACK_ONLY: NameLookup = async () => ["127.0.0.1"];

function infoWith(env: Record<string, string>, base: PlatformInfo = INFO): PlatformInfo {
  return { ...base, env };
}

async function resolveWith(
  options: RawOptions,
  env: Record<string, string> = {},
  lookup: NameLookup = LOOPBACK_ONLY,
) {
  return resolveServeSettings(options, infoWith(env), lookup);
}

async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(InvalidOptionError);
    return (error as Error).message;
  }
  return expect.unreachable("the call should have thrown");
}

describe("the six settings and their defaults", () => {
  it("uses the documented default of every setting", async () => {
    const settings = await resolveWith({});
    expect(settings).toEqual({
      host: "127.0.0.1",
      port: 3000,
      storageDir: "/home/alice/.local/share/imbehind",
      pollIntervalMs: 500,
      waitLimitSeconds: 1800,
      retentionSeconds: 86400,
      sweepIntervalSeconds: 600,
    });
    expect(DEFAULT_RETENTION_SECONDS).toBe(86400);
    expect(DEFAULT_SWEEP_INTERVAL_SECONDS).toBe(600);
  });

  it("takes the option first, then the environment variable, then the default", async () => {
    const env = {
      IMBEHIND_HOST: "127.0.0.3",
      IMBEHIND_PORT: "3200",
      IMBEHIND_DIR: "/env/dir",
      IMBEHIND_TIMEOUT: "60",
      IMBEHIND_RETENTION: "120",
      IMBEHIND_SWEEP_INTERVAL: "30",
    };
    const fromEnv = await resolveWith({}, env);
    expect(fromEnv).toMatchObject({
      host: "127.0.0.3",
      port: 3200,
      storageDir: "/env/dir",
      waitLimitSeconds: 60,
      retentionSeconds: 120,
      sweepIntervalSeconds: 30,
    });
    const fromOptions = await resolveWith(
      {
        host: "127.0.0.2",
        port: "3100",
        dir: "/opt/dir",
        timeout: "10",
        retention: "20",
        "sweep-interval": "5",
      },
      env,
    );
    expect(fromOptions).toMatchObject({
      host: "127.0.0.2",
      port: 3100,
      storageDir: "/opt/dir",
      waitLimitSeconds: 10,
      retentionSeconds: 20,
      sweepIntervalSeconds: 5,
    });
  });

  it("treats an empty environment variable as not set", async () => {
    const settings = await resolveWith(
      {},
      {
        IMBEHIND_HOST: "",
        IMBEHIND_PORT: "",
        IMBEHIND_DIR: "",
        IMBEHIND_TIMEOUT: "",
        IMBEHIND_RETENTION: "",
        IMBEHIND_SWEEP_INTERVAL: "",
      },
    );
    expect(settings.port).toBe(3000);
    expect(settings.retentionSeconds).toBe(86400);
    expect(settings.storageDir).toBe("/home/alice/.local/share/imbehind");
  });

  it("checks the option even when the environment variable is fine", async () => {
    expect(await messageOf(resolveWith({ port: "abc" }, { IMBEHIND_PORT: "3100" }))).toBe(
      '--port must be a number from 1 to 65535 (got "abc").',
    );
  });
});

describe("the command line", () => {
  it("reads --port 3100 and --port=3100 the same way, for every command", () => {
    expect(parseCommandLine(["serve", "--port", "3100"])).toEqual({
      name: "serve",
      options: { port: "3100" },
    });
    expect(parseCommandLine(["serve", "--port=3100"])).toEqual({
      name: "serve",
      options: { port: "3100" },
    });
    expect(parseCommandLine(["answer", "--dir", "/d"])).toEqual({
      name: "answer",
      options: { dir: "/d" },
    });
    expect(parseCommandLine(["path", "--dir=/d"])).toEqual({
      name: "path",
      options: { dir: "/d" },
    });
  });

  it("reads all six options of serve, and keeps an empty value for the check to refuse", () => {
    const parsed = parseCommandLine([
      "serve",
      "--host=::1",
      "--port",
      "1",
      "--dir",
      "",
      "--timeout=0",
      "--retention",
      "9",
      "--sweep-interval=2",
    ]);
    expect(parsed).toEqual({
      name: "serve",
      options: {
        host: "::1",
        port: "1",
        dir: "",
        timeout: "0",
        retention: "9",
        "sweep-interval": "2",
      },
    });
  });

  it("refuses a bad way of writing as a usage error, with the usage sentence", () => {
    const bad = [
      [],
      ["nope"],
      ["serve", "--bogus"],
      ["serve", "5"],
      ["serve", "--port"],
      ["serve", "--port", "1", "--port", "2"],
      ["serve", "--port", "1", "--port=2"],
      ["answer", "extra"],
      ["answer", "--port", "5"],
      ["answer", "--timeout=5"],
      ["path", "--host", "127.0.0.1"],
      ["path", "--retention=5"],
      ["serve", "-p", "5"],
    ];
    for (const argv of bad) {
      expect(() => parseCommandLine(argv), argv.join(" ")).toThrow(InvalidOptionError);
      expect(() => parseCommandLine(argv)).toThrow("usage: imbehind serve | answer | path");
    }
  });
});

describe("port", () => {
  it("accepts 1 and 65535, with leading zeros", async () => {
    expect((await resolveWith({ port: "1" })).port).toBe(1);
    expect((await resolveWith({ port: "65535" })).port).toBe(65535);
    expect((await resolveWith({ port: "03100" })).port).toBe(3100);
  });

  it("refuses everything else with the fixed sentence", async () => {
    for (const bad of ["abc", "0", "65536", "-1", "+5", "1.5", "1e3", " 80", "80 ", "", "0x50"]) {
      expect(await messageOf(resolveWith({ port: bad }))).toBe(
        `--port must be a number from 1 to 65535 (got "${bad}").`,
      );
    }
  });

  it("names the environment variable when the bad value came from it, and cuts long values", async () => {
    expect(await messageOf(resolveWith({}, { IMBEHIND_PORT: "x" }))).toBe(
      'IMBEHIND_PORT must be a number from 1 to 65535 (got "x").',
    );
    const long = "9".repeat(80);
    expect(await messageOf(resolveWith({ port: long }))).toBe(
      `--port must be a number from 1 to 65535 (got "${"9".repeat(64)}").`,
    );
  });
});

describe("timeout, retention and sweep-interval", () => {
  it("accepts the ends of the ranges", async () => {
    const low = await resolveWith({ timeout: "0", retention: "0", "sweep-interval": "1" });
    expect(low).toMatchObject({
      waitLimitSeconds: 0,
      retentionSeconds: 0,
      sweepIntervalSeconds: 1,
    });
    const high = await resolveWith({
      timeout: "2147483",
      retention: "315360000",
      "sweep-interval": "2147483",
    });
    expect(high).toMatchObject({
      waitLimitSeconds: 2147483,
      retentionSeconds: 315360000,
      sweepIntervalSeconds: 2147483,
    });
  });

  it("refuses values that are not digits only or are out of range, naming the range", async () => {
    const cases: Array<[string, string, string]> = [
      ["timeout", "0 to 2147483", "2147484"],
      ["retention", "0 to 315360000", "315360001"],
      ["sweep-interval", "1 to 2147483", "0"],
    ];
    for (const [name, range, outOfRange] of cases) {
      for (const bad of ["x", "-1", "+1", "1.5", "1e3", " 5", "", outOfRange]) {
        expect(await messageOf(resolveWith({ [name]: bad } as RawOptions))).toBe(
          `--${name} must be a whole number of seconds from ${range} (got "${bad}").`,
        );
      }
    }
  });

  it("names the environment variable of each setting", async () => {
    expect(await messageOf(resolveWith({}, { IMBEHIND_RETENTION: "x" }))).toBe(
      'IMBEHIND_RETENTION must be a whole number of seconds from 0 to 315360000 (got "x").',
    );
    expect(await messageOf(resolveWith({}, { IMBEHIND_SWEEP_INTERVAL: "0" }))).toBe(
      'IMBEHIND_SWEEP_INTERVAL must be a whole number of seconds from 1 to 2147483 (got "0").',
    );
    expect(await messageOf(resolveWith({}, { IMBEHIND_TIMEOUT: "-5" }))).toBe(
      'IMBEHIND_TIMEOUT must be a whole number of seconds from 0 to 2147483 (got "-5").',
    );
  });
});

describe("retention against timeout", () => {
  it("refuses a retention shorter than the timeout, with both values in seconds", async () => {
    expect(await messageOf(resolveWith({ retention: "600", timeout: "1800" }))).toBe(
      "--retention (600 seconds) must not be shorter than --timeout (1800 seconds).",
    );
  });

  it("uses the values that are really used, whatever their source", async () => {
    expect(await messageOf(resolveWith({}, { IMBEHIND_RETENTION: "600" }))).toBe(
      "--retention (600 seconds) must not be shorter than --timeout (1800 seconds).",
    );
    expect(await messageOf(resolveWith({ timeout: "100000" }))).toBe(
      "--retention (86400 seconds) must not be shorter than --timeout (100000 seconds).",
    );
  });

  it("accepts equal values, and does not check when either is 0", async () => {
    expect((await resolveWith({ retention: "60", timeout: "60" })).retentionSeconds).toBe(60);
    expect((await resolveWith({ retention: "5", timeout: "0" })).waitLimitSeconds).toBe(0);
    expect((await resolveWith({ retention: "0", timeout: "1800" })).retentionSeconds).toBe(0);
  });
});

describe("the order of the checks and the first failure only", () => {
  it("reports host before port, port before timeout, and so on", async () => {
    const hostFirst = await messageOf(resolveWith({ host: "0.0.0.0", port: "x", timeout: "x" }));
    expect(hostFirst).toMatch(/^0\.0\.0\.0 is not a local address/);
    expect(await messageOf(resolveWith({ port: "x", timeout: "x", retention: "x" }))).toMatch(
      /^--port /,
    );
    expect(await messageOf(resolveWith({ timeout: "x", retention: "x" }))).toMatch(/^--timeout /);
    expect(await messageOf(resolveWith({ retention: "x", "sweep-interval": "x" }))).toMatch(
      /^--retention /,
    );
    expect(await messageOf(resolveWith({ "sweep-interval": "x", dir: "" }))).toMatch(
      /^--sweep-interval /,
    );
  });

  it("checks the directory before the retention and timeout combination", async () => {
    expect(await messageOf(resolveWith({ dir: "", retention: "1", timeout: "9" }))).toBe(
      "--dir must not be empty.",
    );
  });

  it("gives one message only", async () => {
    const message = await messageOf(resolveWith({ port: "x", timeout: "x", retention: "x" }));
    expect(message.split("\n")).toHaveLength(1);
  });
});

describe("host", () => {
  it("accepts loopback addresses as they are", async () => {
    const never: NameLookup = () => Promise.reject(new Error("must not be called"));
    for (const host of ["127.0.0.1", "127.0.0.2", "127.255.255.254", "::1"]) {
      expect((await resolveServeSettings({ host }, INFO, never)).host).toBe(host);
    }
  });

  it("takes the brackets off [::1]", async () => {
    expect((await resolveWith({ host: "[::1]" })).host).toBe("::1");
  });

  it("accepts localhost in any case when every address it names is loopback, and uses the first", async () => {
    const lookup: NameLookup = async () => ["::1", "127.0.0.1"];
    expect((await resolveWith({ host: "localhost" }, {}, lookup)).host).toBe("::1");
    expect((await resolveWith({ host: "LocalHost" }, {}, LOOPBACK_ONLY)).host).toBe("127.0.0.1");
  });

  it("asks the lookup for the name that was given", async () => {
    const asked: string[] = [];
    await resolveWith({ host: "LOCALHOST" }, {}, async (name) => {
      asked.push(name);
      return ["127.0.0.1"];
    });
    expect(asked).toEqual(["localhost"]);
  });

  it("refuses localhost when any address is not local, when nothing is found, and when the lookup fails", async () => {
    const mixed: NameLookup = async () => ["127.0.0.1", "192.168.0.5"];
    const empty: NameLookup = async () => [];
    const broken: NameLookup = () => Promise.reject(new Error("no dns"));
    for (const lookup of [mixed, empty, broken]) {
      expect(await messageOf(resolveWith({ host: "localhost" }, {}, lookup))).toBe(
        "localhost is not a local address. imbehind only listens on this machine (127.0.0.0/8, ::1, localhost).",
      );
    }
  });

  it("refuses every other value, with the fixed sentence", async () => {
    for (const host of [
      "0.0.0.0",
      "192.168.0.5",
      "example.com",
      "",
      "::",
      "128.0.0.1",
      "[::2]",
      // An IPv4 address is accepted only as four decimal numbers.
      "127.1",
      "127.0.1",
      "0x7f.0.0.1",
      "0x7f000001",
      "0177.0.0.1",
      "2130706433",
      "127.0.0.256",
      "127.00.0.1",
    ]) {
      expect(await messageOf(resolveWith({ host }))).toBe(
        `${host} is not a local address. imbehind only listens on this machine (127.0.0.0/8, ::1, localhost).`,
      );
    }
  });

  it("cuts a long value to 64 characters", async () => {
    expect(await messageOf(resolveWith({ host: "h".repeat(80) }))).toMatch(
      new RegExp(`^${"h".repeat(64)} is not a local address\\.`),
    );
  });
});

describe("the storage directory", () => {
  it("puts the option before IMBEHIND_DIR before the default", () => {
    expect(resolveStorageDir("/a", infoWith({ IMBEHIND_DIR: "/b" }))).toBe("/a");
    expect(resolveStorageDir(undefined, infoWith({ IMBEHIND_DIR: "/b" }))).toBe("/b");
    expect(resolveStorageDir(undefined, INFO)).toBe("/home/alice/.local/share/imbehind");
  });

  it("makes a relative path absolute from the working directory, and cleans it up", () => {
    expect(resolveStorageDir("data/../store", INFO)).toBe("/work/store");
    expect(resolveStorageDir(undefined, infoWith({ IMBEHIND_DIR: "rel" }))).toBe("/work/rel");
  });

  it("uses the path rules of the platform in the information, not of the machine", () => {
    const windows: PlatformInfo = {
      platform: "win32",
      env: {},
      homedir: "C:\\Users\\alice",
      cwd: "C:\\work",
    };
    expect(resolveStorageDir("data", windows)).toBe("C:\\work\\data");
    expect(resolveStorageDir("D:\\x\\y", windows)).toBe("D:\\x\\y");
  });

  it("refuses an empty --dir with exit code 2, but treats an empty IMBEHIND_DIR as not set", () => {
    expect(() => resolveStorageDir("", INFO)).toThrow(InvalidOptionError);
    expect(() => resolveStorageDir("", INFO)).toThrow("--dir must not be empty.");
    expect(resolveStorageDir(undefined, infoWith({ IMBEHIND_DIR: "" }))).toBe(
      "/home/alice/.local/share/imbehind",
    );
  });

  it("still fails with exit code 1 when no default can be found", () => {
    const lost: PlatformInfo = { platform: "linux", env: {}, homedir: undefined };
    expect(() => resolveStorageDir(undefined, lost)).toThrow(StartupError);
    expect(() => resolveStorageDir(undefined, lost)).not.toThrow(InvalidOptionError);
    expect(resolveStorageDir("/given", lost)).toBe("/given");
  });
});
