import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

const created: string[] = [];

/** Makes a fresh temporary directory that is removed after each test. */
export async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "imbehind-test-"));
  created.push(dir);
  return dir;
}

afterEach(async () => {
  const dirs = created.splice(0, created.length);
  await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** An error shaped like a Node.js file system error. */
export function errno(code: string): Error {
  return Object.assign(new Error(`${code}: injected failure`), { code });
}
