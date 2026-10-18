import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { makeTempDir } from "./fs.js";

const COMPILER_OPTIONS = { module: "NodeNext", moduleResolution: "NodeNext", target: "ES2023" };

/**
 * Writes a small TypeScript project into a temporary folder and returns the folder. The keys of
 * `files` are paths relative to the folder. The tsconfig.json includes the `include` patterns.
 */
export async function writeProject(
  files: Record<string, string>,
  include: string[] = ["src/**/*.ts"],
): Promise<string> {
  const dir = await makeTempDir();
  await writeFile(
    path.join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: COMPILER_OPTIONS, include }),
  );
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return dir;
}
