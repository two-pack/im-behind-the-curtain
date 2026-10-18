import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeProject } from "./helpers/project.js";

const TOOL = path.resolve("test", "tools", "check-dependencies.ts");

interface Run {
  status: number | null;
  output: string;
}

/** Runs the dependency check in a folder and returns its exit code and everything it printed. */
function check(cwd: string): Run {
  const result = spawnSync(process.execPath, [TOOL], { cwd, encoding: "utf8" });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("the dependency check (npm run deps)", () => {
  it("fails when it finds no module to check in src/", async () => {
    // src/ has no TypeScript file, so the cruiser itself reports no violation and exits with 0.
    const dir = await writeProject(
      { "src/readme.txt": "Not a module.\n", "lib/other.ts": "export const value = 1;\n" },
      ["src/**/*.ts", "lib/**/*.ts"],
    );
    const run = check(dir);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("0 modules cruised");
  });

  it("fails and names the import when an import breaks a rule", async () => {
    const dir = await writeProject({
      "src/ids.ts": 'import { value } from "./clock.js";\nexport const other = value;\n',
      "src/clock.ts": "export const value = 1;\n",
    });
    const run = check(dir);
    expect(run.status).not.toBe(0);
    expect(run.output).toContain("src/ids.ts -> src/clock.ts");
  });

  it("passes on the src/ of this repository and tells how many modules it checked", () => {
    const run = check(process.cwd());
    expect(run.status, run.output).toBe(0);
    expect(run.output).toContain("no dependency violations found");
    const count = Number(/(\d+) modules cruised/.exec(run.output)?.[1] ?? 0);
    expect(count).toBeGreaterThan(0);
  });
});
