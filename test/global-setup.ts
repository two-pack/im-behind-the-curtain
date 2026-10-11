import { execFileSync } from "node:child_process";
import path from "node:path";

/**
 * Builds dist/ once before the tests run, so the tests that start the real program
 * (test/e2e/process.test.ts) work with any vitest command and need no separate build step.
 */
export default function setup(): void {
  const tsc = path.resolve("node_modules", "typescript", "bin", "tsc");
  execFileSync(process.execPath, [tsc, "-p", "tsconfig.build.json"], { stdio: "inherit" });
}
