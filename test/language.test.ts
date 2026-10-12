import type { Dirent } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Repository text is English (NFR15.1). The character ranges are given as code points, and
 * the sample texts are built from code points, so that this file contains no Japanese text.
 * Ranges: hiragana and katakana (3040-30FF), kanji (3400-4DBF and 4E00-9FFF), and
 * half-width katakana (FF66-FF9F).
 */
const RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x3040, 0x30ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xff66, 0xff9f],
];
const JAPANESE = new RegExp(
  `[${RANGES.map(([from, to]) => `\\u{${from.toString(16)}}-\\u{${to.toString(16)}}`).join("")}]`,
  "u",
);

/**
 * Folders that are checked, and the top-level files that are checked. The list names the files
 * that are part of the published repository, so a file that is not listed (README.ja.md, the
 * Japanese README, among them) is not checked.
 */
const CHECKED_DIRS = ["src", "test", "docs", ".github"];
const CHECKED_ROOT_FILES = new Set([
  "README.md",
  "LICENSE",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "tsconfig.build.json",
  "vitest.config.ts",
  "biome.json",
  "knip.json",
  ".dependency-cruiser.cjs",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
]);

/** The names from a list of top-level entries that are checked, in the order they were given. */
function selectCheckedRootFiles(names: string[]): string[] {
  return names.filter((name) => CHECKED_ROOT_FILES.has(name));
}

async function filesUnder(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await filesUnder(full)));
    } else {
      found.push(full);
    }
  }
  return found;
}

/** The top-level files of the repository, such as package.json, README.md and LICENSE. */
async function rootFiles(): Promise<string[]> {
  const entries = await readdir(".", { withFileTypes: true });
  const present = entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
  return selectCheckedRootFiles(present).map((name) => path.resolve(name));
}

async function linesWithJapanese(file: string): Promise<string[]> {
  const text = await readFile(file, "utf8");
  return text
    .split("\n")
    .map((line, index) => ({ line, number: index + 1 }))
    .filter(({ line }) => JAPANESE.test(line))
    .map(({ number }) => `${path.relative(".", file)}:${number}`);
}

describe("repository text is English (NFR15.1)", () => {
  it("recognizes Japanese characters and lets English through", () => {
    const kanji = String.fromCodePoint(0x65e5, 0x672c, 0x8a9e);
    const hiragana = String.fromCodePoint(0x3072, 0x3089, 0x304c, 0x306a);
    const katakana = String.fromCodePoint(0x30ab, 0x30bf, 0x30ab, 0x30ca);
    const halfWidth = String.fromCodePoint(0xff76, 0xff80, 0xff76, 0xff85);
    const accented = String.fromCodePoint(0xe9, 0x2014);
    expect(JAPANESE.test(kanji)).toBe(true);
    expect(JAPANESE.test(hiragana)).toBe(true);
    expect(JAPANESE.test(katakana)).toBe(true);
    expect(JAPANESE.test(halfWidth)).toBe(true);
    expect(JAPANESE.test(`Plain English text, with punctuation: ${accented} ok.`)).toBe(false);
  });

  it("checks only the top-level files that are named in the list of checked files", () => {
    const entries = [
      "README.md",
      "README.ja.md",
      "package.json",
      "notes.txt",
      ".hidden",
      "LICENSE",
    ];
    expect(selectCheckedRootFiles(entries)).toEqual(["README.md", "package.json", "LICENSE"]);
  });

  it("checks the source, tests, docs, workflows and top-level files", async () => {
    const files = [
      ...(await Promise.all(CHECKED_DIRS.map((dir) => filesUnder(path.resolve(dir))))).flat(),
      ...(await rootFiles()),
    ];
    const names = files.map((file) => path.relative(".", file).split(path.sep).join("/"));
    expect(names).toContain("src/cli.ts");
    expect(names).toContain("test/language.test.ts");
    expect(names).toContain("package.json");
    expect(names).toContain("README.md");
    expect(names).toContain("LICENSE");
    expect(names).not.toContain("README.ja.md");
  });

  it("has no Japanese text in any checked file", async () => {
    const files = [
      ...(await Promise.all(CHECKED_DIRS.map((dir) => filesUnder(path.resolve(dir))))).flat(),
      ...(await rootFiles()),
    ];
    const offenders = (await Promise.all(files.map(linesWithJapanese))).flat();
    expect(offenders).toEqual([]);
  });
});
