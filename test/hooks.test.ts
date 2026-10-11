import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { makeTempDir } from "./helpers/fs.js";

const ROOT = path.resolve(".");
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";
const HOOK_WRITERS = ["simple-git-hooks", "husky", "lefthook"];
const INSTALL_TIME_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"];

interface PackageJson {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  [key: string]: unknown;
}

async function readPackage(): Promise<PackageJson> {
  return JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as PackageJson;
}

function git(args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", args, { cwd: ROOT, env, encoding: "utf8" }).trim();
}

/** The value of core.hooksPath that git reports for this repository, or "" when it is unset. */
function ownHooksPath(): string {
  try {
    return git(["config", "--get", "core.hooksPath"]);
  } catch {
    return "";
  }
}

describe("the pre-commit check is opt-in (NFR5.4)", () => {
  it("has no script that runs when the dependencies are installed", async () => {
    const { scripts = {} } = await readPackage();
    for (const name of INSTALL_TIME_SCRIPTS) {
      expect(Object.keys(scripts), `script "${name}"`).not.toContain(name);
    }
  });

  it("has no dependency or setting that writes git hooks", async () => {
    const pkg = await readPackage();
    const declared = [
      pkg.dependencies,
      pkg.devDependencies,
      pkg.optionalDependencies,
      pkg.peerDependencies,
    ].flatMap((group) => Object.keys(group ?? {}));
    for (const name of HOOK_WRITERS) {
      expect(declared, `dependency "${name}"`).not.toContain(name);
      expect(Object.keys(pkg), `package.json key "${name}"`).not.toContain(name);
    }
  });

  it("keeps a pre-commit hook in .githooks that runs npm run check", async () => {
    const text = await readFile(path.join(ROOT, ".githooks", "pre-commit"), "utf8");
    expect(text.startsWith("#!/bin/sh\n")).toBe(true);
    expect(text).toMatch(/^npm run check$/m);
  });

  // File modes do not exist on Windows. The mode is checked on Linux and macOS, where the CI
  // also checks the file out with its executable bit.
  it.skipIf(process.platform === "win32")("makes the pre-commit hook executable", async () => {
    const mode = (await stat(path.join(ROOT, ".githooks", "pre-commit"))).mode;
    expect(mode & 0o111).toBe(0o111);
  });

  it("offers npm run hooks:install, which points core.hooksPath at .githooks", async () => {
    const { scripts = {} } = await readPackage();
    expect(scripts["hooks:install"]).toBe("git config core.hooksPath .githooks");
  });

  it("sets core.hooksPath of a throwaway repository and leaves this repository alone", async () => {
    const before = ownHooksPath();
    const sandbox = await makeTempDir();
    git(["init", "--quiet", sandbox]);
    const sandboxGitDir = path.join(sandbox, ".git");
    // GIT_DIR sends `git config` to the throwaway repository, so no setting of this one changes.
    const env = { ...process.env, GIT_DIR: sandboxGitDir };
    execFileSync(NPM, ["run", "--silent", "hooks:install"], {
      cwd: ROOT,
      env,
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    expect(git(["config", "--get", "core.hooksPath"], env)).toBe(".githooks");
    expect(ownHooksPath()).toBe(before);
  });
});
