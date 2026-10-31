import { spawnSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { writeProject } from "./helpers/project.js";

const CONFIG = path.resolve(".dependency-cruiser.cjs");
const CRUISER = path.resolve("node_modules", "dependency-cruiser", "bin", "dependency-cruiser.mjs");

interface Violation {
  rule: { name: string };
  from: string;
  to: string;
}

/** Writes a small src/ tree into a temporary folder and cruises it with the project's rules. */
async function cruise(files: Record<string, string>): Promise<Violation[]> {
  const dir = await writeProject(
    Object.fromEntries(Object.entries(files).map(([name, content]) => [`src/${name}`, content])),
  );
  const result = spawnSync(
    process.execPath,
    [CRUISER, "src", "--config", CONFIG, "--output-type", "json"],
    { cwd: dir, encoding: "utf8" },
  );
  const report = JSON.parse(result.stdout) as { summary: { violations: Violation[] } };
  return report.summary.violations;
}

const LEAF = "export const value = 1;\n";

describe("the dependency rules (logical-components: the leaf modules)", () => {
  it("lets a leaf module import another leaf module", async () => {
    const violations = await cruise({
      "errors.ts": LEAF,
      "ids.ts": 'import { value } from "./errors.js";\nexport const other = value;\n',
      "model.ts": 'import { other } from "./ids.js";\nexport const third = other;\n',
    });
    expect(violations).toEqual([]);
  });

  it("reports a cycle between leaf modules", async () => {
    const violations = await cruise({
      "errors.ts": 'import { b } from "./ids.js";\nexport const a = b;\n',
      "ids.ts": 'import { a } from "./errors.js";\nexport const b = a;\n',
    });
    expect(violations.map((violation) => violation.rule.name)).toContain("no-circular");
  });

  it("reports a leaf module that imports a module that is not a leaf", async () => {
    const violations = await cruise({
      "ids.ts": 'import { value } from "./clock.js";\nexport const other = value;\n',
      "clock.ts": LEAF,
    });
    expect(violations.map((violation) => `${violation.from} -> ${violation.to}`)).toEqual([
      "src/ids.ts -> src/clock.ts",
    ]);
  });

  it("still reports an import against the direction of the design", async () => {
    const violations = await cruise({
      "errors.ts": LEAF,
      "log.ts": 'import { value } from "./broker/exchange-broker.js";\nexport const x = value;\n',
      "broker/exchange-broker.ts": 'import { value } from "../errors.js";\nexport { value };\n',
    });
    expect(violations.map((violation) => `${violation.from} -> ${violation.to}`)).toEqual([
      "src/log.ts -> src/broker/exchange-broker.ts",
    ]);
  });

  it("treats tool-calls as a leaf module that the adapter side and the answer side may use", async () => {
    const violations = await cruise({
      "model.ts": LEAF,
      "tool-calls.ts": 'import { value } from "./model.js";\nexport const calls = value;\n',
      "broker/reply-check.ts":
        'import { calls } from "../tool-calls.js";\nexport const check = calls;\n',
      "http/server.ts": 'import { calls } from "../tool-calls.js";\nexport const serve = calls;\n',
    });
    expect(violations).toEqual([]);
  });

  it("treats media-parts as a leaf module that the adapter, the store and the view may use", async () => {
    const violations = await cruise({
      "model.ts": LEAF,
      "media-parts.ts": 'import { value } from "./model.js";\nexport const parts = value;\n',
      "chat-completions/adapter.ts":
        'import { parts } from "../media-parts.js";\nexport const parse = parts;\n',
      "store/exchange-store.ts":
        'import { parts } from "../media-parts.js";\nexport const store = parts;\n',
      "answer/conversation-view.ts":
        'import { parts } from "../media-parts.js";\nexport const view = parts;\n',
    });
    expect(violations).toEqual([]);
  });

  it("reports a media-parts module that imports a module that is not a leaf", async () => {
    const violations = await cruise({
      "clock.ts": LEAF,
      "media-parts.ts": 'import { value } from "./clock.js";\nexport const parts = value;\n',
    });
    expect(violations.map((violation) => `${violation.from} -> ${violation.to}`)).toEqual([
      "src/media-parts.ts -> src/clock.ts",
    ]);
  });

  it("reports a tool-calls module that imports a module that is not a leaf", async () => {
    const violations = await cruise({
      "clock.ts": LEAF,
      "tool-calls.ts": 'import { value } from "./clock.js";\nexport const calls = value;\n',
    });
    expect(violations.map((violation) => `${violation.from} -> ${violation.to}`)).toEqual([
      "src/tool-calls.ts -> src/clock.ts",
    ]);
  });

  it("still allows an import the design allows", async () => {
    const violations = await cruise({
      "errors.ts": LEAF,
      "clock.ts": LEAF,
      "log.ts":
        'import { value } from "./clock.js";\nimport { value as v2 } from "./errors.js";\nexport const x = [value, v2];\n',
    });
    expect(violations).toEqual([]);
  });
});
