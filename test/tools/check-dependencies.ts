/**
 * Checks the dependency rules of src/ with dependency-cruiser. Run it with `npm run deps`; it is
 * part of `npm run check`. It checks the src/ folder of the current directory with the rules of
 * this repository.
 *
 * The cruiser alone passes when it finds no module at all, for example when it cannot read
 * TypeScript. This check also fails then, so that a broken cruiser cannot pass silently.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CRUISER = path.join(
  ROOT,
  "node_modules",
  "dependency-cruiser",
  "bin",
  "dependency-cruiser.mjs",
);
const CONFIG = path.join(ROOT, ".dependency-cruiser.cjs");
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

interface Violation {
  rule: { name: string };
  from: string;
  to: string;
}

interface Summary {
  violations: Violation[];
  totalCruised: number;
  totalDependenciesCruised: number;
}

/** Runs the cruiser on src/ and returns its summary, or throws when it gives no report. */
function cruise(): Summary {
  const result = spawnSync(
    process.execPath,
    [CRUISER, "src", "--config", CONFIG, "--output-type", "json"],
    { encoding: "utf8", maxBuffer: MAX_OUTPUT_BYTES },
  );
  if (result.error !== undefined) {
    throw new Error(`could not run dependency-cruiser: ${result.error.message}`);
  }
  try {
    return (JSON.parse(result.stdout) as { summary: Summary }).summary;
  } catch {
    const detail = result.stderr.trim() || `exit code ${result.status}`;
    throw new Error(`dependency-cruiser gave no report: ${detail}`);
  }
}

/** Returns the reasons why the check fails, or an empty list when it passes. */
function problems(summary: Summary): string[] {
  const found = summary.violations.map(
    (violation) => `${violation.rule.name}: ${violation.from} -> ${violation.to}`,
  );
  if (summary.totalCruised === 0) {
    found.push(
      "0 modules cruised: dependency-cruiser found no module in src/, so nothing was checked.",
    );
  }
  return found;
}

try {
  const summary = cruise();
  const found = problems(summary);
  if (found.length > 0) {
    console.error("Dependency check failed:");
    for (const line of found) {
      console.error(`  ${line}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Dependency check passed: no dependency violations found ` +
        `(${summary.totalCruised} modules cruised, ` +
        `${summary.totalDependenciesCruised} dependencies).`,
    );
  }
} catch (error) {
  console.error(
    `Dependency check failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
}
