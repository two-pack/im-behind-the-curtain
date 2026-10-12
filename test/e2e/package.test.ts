import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { makeTempDir } from "../helpers/fs.js";
import { waitFor } from "../helpers/io.js";
import { type Running, runNode } from "../helpers/program.js";
import { freePort, waitForRequestId } from "../helpers/system.js";

const execFileAsync = promisify(execFile);

/**
 * Files that npm always puts into a package, and the one folder that `files` names. npm adds
 * every README file at the top level and cannot be told to leave one out, so the Japanese
 * README is part of the package too.
 */
const ALLOWED_FILES = new Set(["package.json", "README.md", "README.ja.md", "LICENSE"]);
const ALLOWED_FOLDER = "dist/";

/** Time for the packing, the install and the round trip. Slower than the default on a cold disk. */
const SLOW_MS = 120_000;

interface PackedFile {
  path: string;
}

interface PackResult {
  filename: string;
  files: PackedFile[];
}

interface Packed {
  result: PackResult;
  tarball: string;
}

/** Runs npm. On Windows, npm is a .cmd file, which needs a shell. */
async function npm(args: string[], cwd: string): Promise<string> {
  const windows = process.platform === "win32";
  const quoted = windows ? args.map((arg) => `"${arg}"`) : args;
  const { stdout } = await execFileAsync(windows ? "npm.cmd" : "npm", quoted, {
    cwd,
    shell: windows,
    env: process.env,
  });
  return stdout;
}

/**
 * The environment of a program that a test starts: the parent environment without any
 * IMBEHIND_ variable, plus the values that the test needs. A variable that the developer has set
 * for their own use must not change the result of a test.
 */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("IMBEHIND_")) {
      env[name] = value;
    }
  }
  return { ...env, ...extra };
}

async function readPackageJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.resolve("package.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

/** Folders that live as long as this file runs, unlike the ones that makeTempDir removes after each test. */
const lasting: string[] = [];

async function lastingDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "imbehind-package-"));
  lasting.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(
    lasting.splice(0, lasting.length).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

let packing: Promise<Packed> | undefined;

/** Packs the repository once for all tests in this file. */
function packOnce(): Promise<Packed> {
  packing ??= (async () => {
    const packDir = await lastingDir();
    const output = await npm(
      ["pack", "--json", "--ignore-scripts", "--pack-destination", packDir],
      path.resolve("."),
    );
    const result = (JSON.parse(output) as PackResult[])[0] as PackResult;
    return { result, tarball: path.join(packDir, result.filename) };
  })();
  return packing;
}

describe("the package that is published (FR13.1)", () => {
  let packed: PackResult;

  beforeAll(async () => {
    packed = (await packOnce()).result;
  }, SLOW_MS);

  it("holds only package.json, the READMEs, LICENSE and the files under dist/", () => {
    const names = packed.files.map((file) => file.path);
    expect(names.length).toBeGreaterThan(3);
    const unexpected = names.filter(
      (name) => !ALLOWED_FILES.has(name) && !name.startsWith(ALLOWED_FOLDER),
    );
    expect(unexpected).toEqual([]);
    for (const name of ALLOWED_FILES) {
      expect(names, name).toContain(name);
    }
  });

  it("holds the file that the imbehind command starts", async () => {
    const manifest = await readPackageJson();
    const bin = (manifest.bin as Record<string, string>).imbehind as string;
    expect(bin).toBe("dist/bin.js");
    expect(packed.files.map((file) => file.path)).toContain(bin);
  });

  it("is named after the version and the package", () => {
    expect(packed.filename).toMatch(/^imbehind-\d+\.\d+\.\d+.*\.tgz$/);
  });
});

describe("package.json fields of a published package (FR13.1)", () => {
  it("has the name, the version, the description and the license", async () => {
    const manifest = await readPackageJson();
    expect(manifest.name).toBe("imbehind");
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(typeof manifest.description).toBe("string");
    expect(manifest.license).toBe("MIT");
  });

  it("names the command, the Node.js version and the files to publish", async () => {
    const manifest = await readPackageJson();
    expect(manifest.bin).toEqual({ imbehind: "dist/bin.js" });
    expect((manifest.engines as { node: string }).node).toBe(">=24");
    expect(manifest.files).toContain("dist");
  });

  it("can be published: it is not marked private", async () => {
    const manifest = await readPackageJson();
    expect(manifest.private).toBeUndefined();
  });

  it("has keywords and the places on GitHub", async () => {
    const manifest = await readPackageJson();
    expect(Array.isArray(manifest.keywords)).toBe(true);
    expect((manifest.keywords as string[]).length).toBeGreaterThan(0);
    expect(manifest.repository).toEqual({
      type: "git",
      url: "git+https://github.com/two-pack/im-behind-the-curtain.git",
    });
    expect(manifest.bugs).toEqual({
      url: "https://github.com/two-pack/im-behind-the-curtain/issues",
    });
    expect(manifest.homepage).toBe("https://github.com/two-pack/im-behind-the-curtain#readme");
  });
});

describe("the package installed from a local file", () => {
  let installedBin = "";
  const started: Running[] = [];

  beforeAll(async () => {
    const { tarball } = await packOnce();
    const project = await lastingDir();
    await writeFile(
      path.join(project, "package.json"),
      JSON.stringify({ name: "install-target", version: "1.0.0", private: true }),
    );
    // The package has no run-time dependencies, so nothing is fetched from the network.
    await npm(
      ["install", tarball, "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
      project,
    );
    installedBin = path.join(project, "node_modules", "imbehind", "dist", "bin.js");
  }, SLOW_MS);

  afterEach(async () => {
    for (const program of started.splice(0, started.length)) {
      program.child.kill(process.platform === "win32" ? "SIGKILL" : "SIGINT");
      await program.exit;
    }
  });

  it("prints the storage directory on one line and exits with 0 for `imbehind path`", async () => {
    const dir = await makeTempDir();
    const program = runNode(installedBin, ["path"], childEnv({ IMBEHIND_DIR: dir }));
    expect(await program.exit).toBe(0);
    expect(program.stdout()).toBe(`${dir}\n`);
    expect(program.stderr()).toBe("");
  });

  it("ignores IMBEHIND_ variables that are set in the parent environment", async () => {
    const names = ["IMBEHIND_PORT", "IMBEHIND_DIR", "IMBEHIND_TIMEOUT"];
    const saved = names.map((name) => [name, process.env[name]] as const);
    const stray = await makeTempDir();
    process.env.IMBEHIND_PORT = "1";
    process.env.IMBEHIND_DIR = stray;
    process.env.IMBEHIND_TIMEOUT = "not-a-number";
    try {
      const env = childEnv({});
      for (const name of names) {
        expect(env[name], name).toBeUndefined();
      }
      const program = runNode(installedBin, ["path"], env);
      expect(await program.exit).toBe(0);
      expect(program.stderr()).toBe("");
      expect(program.stdout()).not.toContain(stray);
      expect(program.stdout().trim().split("\n")).toHaveLength(1);
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = value;
        }
      }
    }
  });

  it(
    "serves one request that a typed-in reply answers",
    async () => {
      const dir = await makeTempDir();
      const env = childEnv({ IMBEHIND_DIR: dir, IMBEHIND_PORT: String(await freePort()) });
      const serve = runNode(installedBin, ["serve"], env);
      started.push(serve);
      await waitFor(() => serve.stdout().includes("Listening on"), 15_000);
      const address = /Listening on (http:\/\/\S+)/.exec(serve.stdout())?.[1] as string;

      const client = fetch(`${address}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "whatever", messages: [{ role: "user", content: "Hello" }] }),
      });
      await waitForRequestId(dir);

      const answer = runNode(installedBin, ["answer"], env);
      answer.child.stdin?.end("Hi\n");
      expect(await answer.exit).toBe(0);
      expect(answer.stdout()).toMatch(/^Sent reply to request [0-9a-f]{6}\.\n$/);

      const body = (await (await client).json()) as { choices: { message: { content: string } }[] };
      expect(body.choices[0]?.message.content).toBe("Hi");
    },
    SLOW_MS,
  );
});
