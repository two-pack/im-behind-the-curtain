import { readFile } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * The CI workflows run the commands of the contributing guide and nothing else (FR12.5, FR12.6).
 * The workflow files are small and written in a plain style, so these checks read their text.
 */
const GUIDE = "docs/contributing.md";
const CI = ".github/workflows/ci.yml";
const AUDIT = ".github/workflows/audit.yml";
const CODEQL = ".github/workflows/codeql.yml";
const PUBLISH = ".github/workflows/publish.yml";
const DEPENDABOT = ".github/dependabot.yml";

async function text(file: string): Promise<string> {
  return readFile(file, "utf8");
}

/** The commands after `run:` in a workflow, one per line. */
function runCommands(workflow: string): string[] {
  return [...workflow.matchAll(/^\s*(?:-\s+)?run:\s*(.+?)\s*$/gm)].map((match) => match[1] ?? "");
}

/** The commands in the shell code blocks of the guide, without the comment after them. */
function guideCommands(guide: string): string[] {
  const commands: string[] = [];
  for (const block of guide.matchAll(/```sh\n([\s\S]*?)```/g)) {
    for (const line of (block[1] ?? "").split("\n")) {
      const command = line.replace(/\s+#.*$/, "").trim();
      if (command !== "") {
        commands.push(command);
      }
    }
  }
  return commands;
}

describe("the workflows run only the commands of the contributing guide (FR12.6)", () => {
  let guide = "";
  const workflows: Record<string, string> = {};

  beforeAll(async () => {
    guide = await text(GUIDE);
    for (const file of [CI, AUDIT, CODEQL]) {
      workflows[file] = await text(file);
    }
  });

  it("has every run command of the workflows in the guide", () => {
    const known = new Set(guideCommands(guide));
    const used = [CI, AUDIT, CODEQL].flatMap((file) => runCommands(workflows[file] ?? ""));
    expect(used.length).toBeGreaterThan(0);
    for (const command of used) {
      expect(known.has(command), command).toBe(true);
    }
  });

  it("runs the check, the audit and the round trip", () => {
    const ci = runCommands(workflows[CI] ?? "");
    expect(ci).toContain("npm ci");
    expect(ci).toContain("npm run check");
    expect(ci).toContain("npm run build");
    expect(ci).toContain("npm run round-trip");
    expect(runCommands(workflows[AUDIT] ?? "")).toContain("npm run audit");
  });
});

describe(".github/workflows/ci.yml (FR12.5, NFR1.1)", () => {
  let ci = "";

  beforeAll(async () => {
    ci = await text(CI);
  });

  it("runs on pull requests and on pushes to main", () => {
    expect(ci).toMatch(/^on:\n\s+pull_request:/m);
    expect(ci).toMatch(/push:\n\s+branches: \[main\]/);
  });

  it("checks on Linux, macOS and Windows", () => {
    expect(ci).toContain("ubuntu-latest");
    expect(ci).toContain("macos-latest");
    expect(ci).toContain("windows-latest");
  });

  it("uses the latest long-term support release of Node.js", () => {
    expect(ci).toContain("node-version: lts/*");
    expect(ci).not.toMatch(/node-version: \d/);
  });

  it("does the round trip in one job on Linux", () => {
    const job = ci.slice(ci.indexOf("round-trip:"));
    expect(job).toContain("runs-on: ubuntu-latest");
    expect(job).toContain("run: npm run round-trip");
  });

  it("gives the jobs only the read permission", () => {
    expect(ci).toMatch(/^permissions:\n\s+contents: read/m);
  });
});

describe(".github/workflows/audit.yml (NFR5.3)", () => {
  it("runs on pull requests, on pushes to main and once a week", async () => {
    const audit = await text(AUDIT);
    expect(audit).toMatch(/pull_request:/);
    expect(audit).toMatch(/push:\n\s+branches: \[main\]/);
    expect(audit).toMatch(/schedule:\n\s+- cron: ".+"/);
  });
});

describe(".github/workflows/codeql.yml (NFR5.5)", () => {
  it("analyzes JavaScript and TypeScript on pull requests, on pushes to main and once a week", async () => {
    const codeql = await text(CODEQL);
    expect(codeql).toContain("languages: javascript-typescript");
    expect(codeql).toMatch(/pull_request:/);
    expect(codeql).toMatch(/schedule:\n\s+- cron: ".+"/);
    expect(codeql).toContain("security-events: write");
  });
});

describe("the actions used by the workflows", () => {
  it("are pinned to a commit and say which release it is", async () => {
    const used: string[] = [];
    for (const file of [CI, AUDIT, CODEQL, PUBLISH]) {
      const workflow = await text(file);
      used.push(
        ...[...workflow.matchAll(/^\s*(?:-\s+)?uses:\s*(.+?)\s*$/gm)].map((m) => m[1] ?? ""),
      );
    }
    expect(used.length).toBeGreaterThan(0);
    for (const line of used) {
      expect(line, line).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
    }
  });
});

describe(".github/dependabot.yml", () => {
  it("checks the npm dependencies and the actions once a week", async () => {
    const config = await text(DEPENDABOT);
    expect(config).toContain('package-ecosystem: "npm"');
    expect(config).toContain('package-ecosystem: "github-actions"');
    expect([...config.matchAll(/interval: "weekly"/g)]).toHaveLength(2);
  });

  it("waits 7 days before it proposes a new release", async () => {
    const config = await text(DEPENDABOT);
    expect([...config.matchAll(/cooldown:\n\s+default-days: 7/g)]).toHaveLength(2);
  });
});

describe(".github/workflows/publish.yml (FR13.2)", () => {
  let publish = "";

  beforeAll(async () => {
    publish = await text(PUBLISH);
  });

  it("starts only when a person starts it", () => {
    const triggers = publish.slice(publish.indexOf("\non:\n"), publish.indexOf("\npermissions:"));
    expect(triggers).toMatch(/^\s+workflow_dispatch:\s*$/m);
    for (const other of [
      "push:",
      "pull_request",
      "schedule:",
      "release:",
      "tags:",
      "workflow_run",
    ]) {
      expect(triggers, other).not.toContain(other);
    }
  });

  it("runs only on main, and waits for the approval of the environment", () => {
    expect(publish).toContain("if: github.ref == 'refs/heads/main'");
    expect(publish).toContain("environment: npm-publish");
  });

  it("gives the write permissions to the publishing job only", () => {
    expect(publish).toMatch(/^permissions:\n\s+contents: read/m);
    expect([...publish.matchAll(/id-token: write/g)]).toHaveLength(1);
    expect([...publish.matchAll(/contents: write/g)]).toHaveLength(1);
    expect(publish.indexOf("id-token: write")).toBeLessThan(publish.indexOf("verify:"));
  });

  it("checks and builds, publishes with provenance, and only then tags and makes the release", () => {
    const at = (needle: string): number => publish.indexOf(needle);
    const order = [
      at("run: npm ci"),
      at("run: npm run check"),
      at("run: npm run build"),
      at("npm publish --provenance --access public"),
      at("gh release create"),
    ];
    for (const position of order) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(publish).toContain('--target "$GITHUB_SHA"');
  });

  it("installs the published version and makes one round trip", () => {
    const verify = publish.slice(publish.indexOf("verify:"));
    expect(verify).toContain("needs: publish");
    expect(verify).toContain("--min-release-age=0");
    expect(verify).toContain("test/tools/round-trip.ts");
  });
});
