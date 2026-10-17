import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { INVALID_REPLY_REASONS, MAX_FILE_BYTES } from "../src/model.js";

/** The documents are part of the product: these checks keep the promises made to readers true. */
async function document(...parts: string[]): Promise<string> {
  return readFile(path.resolve(...parts), "utf8");
}

describe("docs/storage-format.md", () => {
  let text = "";

  beforeAll(async () => {
    text = await document("docs", "storage-format.md");
  });

  it("names the three files and the reply copy that a request folder holds", () => {
    for (const name of ["request.json", "state.json", "reply.json", "reply.accepted.json"]) {
      expect(text).toContain(`\`${name}\``);
    }
    expect(text).toContain("requests/");
  });

  it("lists the fields of the request file, the state file and the reply file", () => {
    const fields = [
      // request.json
      "id",
      "receivedAt",
      "format",
      "model",
      "replyKind",
      "requiredShape",
      "stream",
      "includeUsage",
      "conversation",
      "originalRequest",
      // state.json
      "state",
      "updatedAt",
      "endedAt",
      "endReason",
      // reply.json
      "kind",
      "body",
      "source",
      "writtenAt",
    ];
    for (const field of fields) {
      expect(text, field).toContain(`\`${field}\``);
    }
  });

  it("says that the format version of request.json is 2 and that of the other two files is 1", () => {
    expect(text).toContain("`formatVersion`");
    expect(text).toMatch(/`formatVersion` of `request\.json` is `2`/);
    expect(text).toMatch(/`state\.json` and `reply\.json` (stay|are) (at )?(version )?`?1`?/);
  });

  it("says that a reader of version 1 must treat a version 2 request file as one it does not understand", () => {
    expect(text).toMatch(/version 1[^\n]*\b(older|earlier)\b|\b(older|earlier)\b[^\n]*version 1/i);
    expect(text).toMatch(/every request/i);
    expect(text).toMatch(/reads? (both )?`?1`? and `?2`?|versions? 1 and 2/i);
  });

  it("describes toolDefinitions and the tool fields of a message", () => {
    expect(text).toContain("`toolDefinitions`");
    for (const value of ["tools", "functions", "both", "none"]) {
      expect(text, value).toContain(`\`${value}\``);
    }
    for (const field of ["tool_call_id", "tool_calls", "function_call"]) {
      expect(text, field).toContain(`\`${field}\``);
    }
    expect(text).toMatch(/as (it was )?received|exactly as (the client )?sent/i);
    expect(text).toContain("(unreadable tool call)");
  });

  it("describes the shape of a reply that calls tools and its reason", () => {
    expect(text).toContain("`tool_calls`");
    expect(text).toContain(INVALID_REPLY_REASONS.badToolCalls("<detail>"));
    expect(text).toMatch(/function.*key/i);
    expect(text).toMatch(/exactly one/i);
  });

  it("names the states a request can end in, invalid_reply included", () => {
    for (const state of [
      "waiting",
      "replied",
      "skipped",
      "cancelled",
      "timed_out",
      "abandoned",
      "invalid_reply",
    ]) {
      expect(text).toContain(`\`${state}\``);
    }
  });

  it("tells how to write reply.json whole before it gets its name, without a plain rename", () => {
    expect(text).toMatch(/name that starts with a dot/i);
    expect(text).toMatch(/hard link/i);
    expect(text).toMatch(/fails if `reply\.json` (already )?exists/i);
    expect(text).toMatch(/not (use )?a (plain )?rename|do not rename|never rename/i);
    expect(text).toMatch(/half-written|partly written|not whole/i);
  });

  it("gives the size limit in bytes", () => {
    expect(text).toContain(String(MAX_FILE_BYTES));
  });

  it("lists the checks in their order, each with its reason", () => {
    const reasons = [
      INVALID_REPLY_REASONS.tooLarge,
      INVALID_REPLY_REASONS.notJson,
      INVALID_REPLY_REASONS.missingField,
      INVALID_REPLY_REASONS.unknownVersion,
      INVALID_REPLY_REASONS.unknownKind,
      INVALID_REPLY_REASONS.bodyMismatch,
      INVALID_REPLY_REASONS.bodyNotJson("<detail>"),
      INVALID_REPLY_REASONS.badToolCalls("<detail>"),
    ];
    let from = 0;
    for (const reason of reasons) {
      const at = text.indexOf(reason, from);
      expect(at, reason).toBeGreaterThanOrEqual(from);
      from = at + reason.length;
    }
  });

  it("names the three phrases of the detail of a body that is not JSON", () => {
    expect(text).toContain("unexpected end of input at line");
    expect(text).toContain("unexpected character at line");
    expect(text).toContain("extra data after the JSON value at line");
  });

  it("says one byte order mark at the start is allowed and a half-written file is invalid", () => {
    expect(text).toMatch(/byte order mark/i);
    expect(text).toMatch(/UTF-8/);
  });

  it("says that an invalid reply.json stays, and what the client and serve show", () => {
    expect(text).toMatch(/`reply\.json` (is )?(left|stays|kept)/i);
    expect(text).toContain("`invalid_reply`");
    expect(text).toContain("502");
    expect(text).toContain("The reply file was invalid: <reason>.");
    expect(text).toContain("invalid_reply  <short id>  <reason>");
  });

  it("says that a file that cannot be read is not an invalid reply", () => {
    expect(text).toMatch(/cannot be read|unreadable/i);
    expect(text).toMatch(/tries again|retr(y|ies)/i);
  });

  it("says that only the reply that arrived first is used", () => {
    expect(text).toMatch(/first reply|arrived first|first to arrive/i);
    expect(text).toMatch(/imbehind answer/);
  });
});

describe("docs/specification.md, replying from standard input", () => {
  it("has a section that tells how it works and links the storage format", async () => {
    const text = await document("docs", "specification.md");
    expect(text).toMatch(/^#### Replying from standard input$/m);
    const section = text.split(/^#### Replying from standard input$/m)[1]?.split(/^#{2,4} /m)[0];
    expect(section).toContain("imbehind answer");
    expect(section).toMatch(/not a terminal|pipe|redirect/i);
    expect(section).toMatch(/first (waiting )?request/i);
    expect(section).toMatch(/waits? (silently|without printing)|nothing is printed/i);
    expect(section).toMatch(/closed|ended|empty/i);
    expect(section).toContain("Sent reply to request");
    expect(section).toContain("storage-format.md");
  });
});

const DOCS_BASE = "https://github.com/two-pack/im-behind-the-curtain/blob/main/docs/";
const READMES = ["README.md", "README.ja.md"];

/** Hiragana, katakana and kanji, written as code point ranges so that this file has none itself. */
const JAPANESE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/u;

describe("the documents in docs/ (FR12.1)", () => {
  const files = ["requirements.md", "specification.md", "contributing.md"];

  it("has a requirements document, a specification and a contributing guide", async () => {
    for (const name of files) {
      const text = await document("docs", name);
      expect(text.length, name).toBeGreaterThan(500);
      expect(text, name).toMatch(/^# /m);
    }
  });

  it("writes them in English only", async () => {
    for (const name of [...files, "storage-format.md"]) {
      expect(JAPANESE.test(await document("docs", name)), name).toBe(false);
    }
  });

  it("keeps the requirement numbers in the requirements document", async () => {
    const text = await document("docs", "requirements.md");
    for (const id of ["FR1.1", "FR4.12", "FR10.9", "FR12.1", "FR14.4", "NFR1", "NFR15"]) {
      expect(text, id).toContain(id);
    }
  });
});

describe("README.md and README.ja.md", () => {
  it("name the Chat Completions endpoint and the model list, and no other API format", async () => {
    for (const name of READMES) {
      const text = await document(name);
      expect(text, name).toContain("/v1/chat/completions");
      expect(text, name).toContain("/v1/models");
      expect(text, name).not.toContain("/v1/messages");
      expect(text, name).not.toContain("/v1/responses");
    }
  });

  it("tell that parts that are not text are refused with unsupported_content", async () => {
    for (const name of READMES) {
      expect(await document(name), name).toContain("unsupported_content");
    }
    expect(await document("README.md")).toMatch(/image, audio, a file/);
    // The Japanese word for "image", written as code points.
    expect(await document("README.ja.md")).toContain(String.fromCodePoint(0x753b, 0x50cf));
  });

  it("tell that tools and tool calls are supported, and no longer say they are refused", async () => {
    for (const name of READMES) {
      const text = await document(name);
      expect(text, name).toContain("tool_calls");
      expect(text, name).toMatch(/`tools`/);
      expect(text, name).toContain("function_call");
      expect(text, name).not.toContain("tool-related requests");
    }
    expect(await document("README.md")).not.toMatch(/\btools?\b[^.\n]*\b(are|is) refused/i);
    // The Japanese words for "tool-related requests", written as code points.
    expect(await document("README.ja.md")).not.toContain(
      String.fromCodePoint(0x9053, 0x5177, 0x306b, 0x95a2, 0x308f, 0x308b, 0x4f9d, 0x983c),
    );
  });

  it("do not say that images are saved", async () => {
    expect(await document("README.md")).not.toMatch(
      /images?\b[^.\n]*\b(is|are|also) (also )?(saved|stored)\b/i,
    );
    // The Japanese words for "images are saved too", written as code points.
    expect(await document("README.ja.md")).not.toContain(
      String.fromCodePoint(0x753b, 0x50cf, 0x3082, 0x4fdd, 0x5b58),
    );
  });

  it("give the install command and the two commands to start, in a few lines", async () => {
    for (const name of READMES) {
      const text = await document(name);
      const install = text.indexOf("npm install --global imbehind");
      const serve = text.indexOf("imbehind serve");
      const answer = text.indexOf("imbehind answer");
      expect(install, `${name} install`).toBeGreaterThanOrEqual(0);
      expect(serve, `${name} serve`).toBeGreaterThan(install);
      expect(answer, `${name} answer`).toBeGreaterThan(serve);
      expect(text, name).not.toMatch(/not (been )?published|npm ci|npm run build/);
      expect(text.split("\n").length, `${name} stays short`).toBeLessThan(80);
    }
  });

  it("link the documents in docs/ with their address on GitHub", async () => {
    for (const name of READMES) {
      const text = await document(name);
      for (const file of [
        "specification.md",
        "storage-format.md",
        "contributing.md",
        "requirements.md",
      ]) {
        expect(text, `${name} ${file}`).toContain(`${DOCS_BASE}${file}`);
      }
    }
  });

  it("have the same sections in the same order", async () => {
    const headings = async (name: string): Promise<string[]> =>
      (await document(name)).split("\n").filter((line) => /^#{1,3} /.test(line));
    const english = await headings("README.md");
    const japanese = await headings("README.ja.md");
    expect(japanese.map((line) => line.split(" ")[0])).toEqual(
      english.map((line) => line.split(" ")[0]),
    );
  });
});

describe("docs/requirements.md and docs/specification.md, tools", () => {
  it("accepts tool-related requests in the requirements instead of refusing them", async () => {
    const text = await document("docs", "requirements.md");
    expect(text).toMatch(/^### FR9 Tools and tool calls \(Must\)$/m);
    expect(text).not.toContain("Refuse tool-related requests");
    expect(text).not.toContain("tool-related requests are refused");
    expect(text).not.toMatch(/Replies that call tools \| A candidate/);
    for (const id of ["FR9.1", "FR9.5", "FR9.9"]) {
      expect(text, id).toContain(id);
    }
    for (const word of ["tool_calls", "function_call", "finish_reason", "formatVersion"]) {
      expect(text, word).toContain(word);
    }
  });

  it("lists in the refusal table only what is still refused", async () => {
    const text = await document("docs", "specification.md");
    const row = text.split("\n").find((line) => line.includes("| 400 | `unsupported_content` |"));
    expect(row).toBeDefined();
    expect(row).toContain("image");
    expect(row).not.toMatch(/tools|functions|tool_calls|function_call/);
    expect(text).not.toContain("Tool calls are not supported");
    expect(text).not.toContain("Empty `tools` and `functions` arrays are accepted.");
  });

  it("tells how to type tool calls, what the stream looks like, and what the screen shows", async () => {
    const text = await document("docs", "specification.md");
    expect(text).toMatch(/^### Tool calls$/m);
    const section = text.split(/^### Tool calls$/m)[1]?.split(/^### /m)[0] ?? "";
    for (const word of [
      "tool_calls",
      "function_call",
      "finish_reason",
      "`function`",
      "(unreadable tool call)",
      "(unnamed)",
      "tool_choice",
      "parallel_tool_calls",
      "index",
      "80",
    ]) {
      expect(section, word).toContain(word);
    }
    expect(section).toMatch(/as text/i);
    expect(section).toMatch(/dropped|left out|not (sent|included)/i);
  });
});

describe("docs/specification.md (FR12.4)", () => {
  it("says that the client wait time has to be longer, with an example that turns retries off", async () => {
    const text = await document("docs", "specification.md");
    expect(text).toMatch(/timeout/i);
    expect(text).toMatch(/at least|longer than|no shorter than/i);
    expect(text).toContain("max_retries=0");
    expect(text).toContain("timeout=1800");
    expect(text).toContain("maxRetries: 0");
  });

  it("names the HTTP endpoints, the error codes and the storage format document", async () => {
    const text = await document("docs", "specification.md");
    for (const word of [
      "POST /v1/chat/completions",
      "GET /v1/models",
      "unsupported_content",
      "invalid_request",
      "request_too_large",
      "skipped_by_human",
      "reply_timeout",
      "invalid_reply",
      "storage_error",
      "storage-format.md",
    ]) {
      expect(text, word).toContain(word);
    }
  });
});

describe("docs/contributing.md", () => {
  let text = "";

  beforeAll(async () => {
    text = await document("docs", "contributing.md");
  });

  it("uses only npm scripts that exist in package.json", async () => {
    const manifest = JSON.parse(await document("package.json")) as {
      scripts: Record<string, string>;
    };
    const used = [...text.matchAll(/npm run ([\w:-]+)/g)].map((match) => match[1] as string);
    expect(used.length).toBeGreaterThan(0);
    for (const name of used) {
      expect(Object.keys(manifest.scripts), name).toContain(name);
    }
  });

  it("gives the commands to install, build, check and test", () => {
    for (const command of ["npm ci", "npm run build", "npm run check", "npm test"]) {
      expect(text, command).toContain(command);
    }
  });

  it("names the workflows that exist and keeps the local commands first", () => {
    expect(text).not.toMatch(/once the workflow is added|does not exist yet/i);
    for (const file of ["ci.yml", "audit.yml", "codeql.yml"]) {
      expect(text, file).toContain(`.github/workflows/${file}`);
    }
    expect(text.indexOf("npm run check")).toBeGreaterThan(-1);
    expect(text.indexOf("npm run check")).toBeLessThan(text.indexOf(".github/workflows/ci.yml"));
  });

  it("asks for Node.js 24 or later, as package.json does", async () => {
    expect(text).toContain("Node.js 24 or later");
    const manifest = JSON.parse(await document("package.json")) as { engines: { node: string } };
    expect(manifest.engines.node).toBe(">=24");
  });

  it("tells how to try one round trip with a single command", () => {
    expect(text).toContain("npm run round-trip");
  });
});

describe("commands and paths in the documents exist", () => {
  async function markdownFiles(): Promise<string[]> {
    const names = (await readdir("docs")).filter((name) => name.endsWith(".md"));
    return [...names.map((name) => path.join("docs", name)), ...READMES];
  }

  it("mentions only npm scripts that exist in package.json", async () => {
    const manifest = JSON.parse(await document("package.json")) as {
      scripts: Record<string, string>;
    };
    for (const file of await markdownFiles()) {
      const used = [...(await document(file)).matchAll(/npm run ([\w:-]+)/g)].map(
        (match) => match[1] as string,
      );
      for (const name of used) {
        expect(Object.keys(manifest.scripts), `${file} ${name}`).toContain(name);
      }
    }
  });

  it("links only to documents in docs/ that exist", async () => {
    const present = new Set(await readdir("docs"));
    for (const file of await markdownFiles()) {
      const text = await document(file);
      const linked = [...text.matchAll(/docs\/([\w-]+\.md)/g)].map((match) => match[1] as string);
      for (const name of linked) {
        expect(present.has(name), `${file} ${name}`).toBe(true);
      }
    }
  });
});

describe("English only (NFR15)", () => {
  async function filesUnder(folder: string): Promise<string[]> {
    const names = await readdir(folder, { recursive: true });
    const found: string[] = [];
    for (const name of names) {
      const full = path.join(folder, name);
      if ((await stat(full)).isFile()) {
        found.push(full);
      }
    }
    return found;
  }

  it("has no Japanese in the source, the tests, the documents, the English README, package.json and LICENSE", async () => {
    const files = [
      ...(await filesUnder("src")),
      ...(await filesUnder("test")),
      ...(await filesUnder("docs")),
      "README.md",
      "package.json",
      "LICENSE",
    ];
    expect(files.length).toBeGreaterThan(30);
    const offenders: string[] = [];
    for (const file of files) {
      if (JAPANESE.test(await readFile(file, "utf8"))) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the repository ignores what it builds and what npm pack makes", () => {
  it("lists node_modules, dist, coverage and the .tgz file of npm pack", async () => {
    const ignored = (await document(".gitignore")).split("\n").map((line) => line.trim());
    for (const entry of ["node_modules/", "dist/", "coverage/", "*.tgz"]) {
      expect(ignored, entry).toContain(entry);
    }
  });
});

describe(".npmrc (supply chain)", () => {
  it("turns off the install scripts of dependencies and waits 7 days for a new release", async () => {
    const lines = (await document(".npmrc")).split("\n").map((line) => line.trim());
    expect(lines).toContain("ignore-scripts=true");
    expect(lines).toContain("min-release-age=7");
  });
});
