import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve("src");

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith(".ts")) {
      found.push(full);
    }
  }
  return found;
}

const PLATFORM_FILE = path.join(SRC, "platform.ts");
const OS_CALL = /process\s*\.\s*platform|\bos\s*\.\s*platform|\bplatform\s*\(/;
const OS_IMPORT = /from\s+["'](?:node:)?os["']/;

describe("operating system differences stay in one module (NFR1.2)", () => {
  it("finds the source files", async () => {
    const files = await sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(10);
    expect(files).toContain(PLATFORM_FILE);
  });

  it("uses process.platform and os.platform only in src/platform.ts", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      if (file !== PLATFORM_FILE && OS_CALL.test(await readFile(file, "utf8"))) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("imports the os module only in src/platform.ts", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      if (file !== PLATFORM_FILE && OS_IMPORT.test(await readFile(file, "utf8"))) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("really reads process.platform in src/platform.ts, so the search above is not empty", async () => {
    expect(OS_CALL.test(await readFile(PLATFORM_FILE, "utf8"))).toBe(true);
    expect(OS_CALL.test("const x = process.platform;")).toBe(true);
    expect(OS_CALL.test("const x = os.platform();")).toBe(true);
    expect(OS_CALL.test("const x = info.platform;")).toBe(false);
  });
});
