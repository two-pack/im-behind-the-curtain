import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { INVALID_REPLY_REASONS, MAX_FILE_BYTES, MAX_REQUEST_FILE_BYTES } from "../src/model.js";

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

  it("says that the format version of request.json is 3 and that of the other two files is 1", () => {
    expect(text).toContain("`formatVersion`");
    expect(text).toMatch(/`formatVersion` of `request\.json` is `3`/);
    expect(text).toMatch(/`state\.json` and `reply\.json` (stay|are) (at )?(version )?`?1`?/);
  });

  it("says that a reader of versions 1 and 2 must treat a version 3 request file as one it does not understand (AC5.1.5)", () => {
    expect(text).toMatch(
      /versions? 1 and 2[^\n]*\b(older|earlier)\b|\b(older|earlier)\b[^\n]*versions? 1 and 2/i,
    );
    expect(text).toMatch(/version 3[^\n]*(cannot read|does not understand|not understand)/i);
    expect(text).toMatch(/every request/i);
    expect(text).toMatch(/reads? (all of )?`?1`?, `?2`? and `?3`?|versions? 1, 2 and 3/i);
  });

  it("no longer says that request.json is written as version 2 (AC5.1.6)", () => {
    expect(text).not.toMatch(/format version 2 of `request\.json`/);
    expect(text).not.toMatch(/writes version 2/i);
    expect(text).not.toMatch(/`formatVersion` of `request\.json` is `2`/);
    const row = text.split("\n").find((line) => line.startsWith("| `formatVersion` | number | `"));
    expect(row).toContain("`3`");
    expect(row).not.toMatch(/\| `2`\./);
    const intro = text.split("\n")[2] ?? "";
    expect(intro).toMatch(/format version 3 of `request\.json`/);
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

/** The text of the section that starts with `heading`, up to the next heading of the same level or higher. */
function sectionOf(text: string, heading: string): string {
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) {
    return "";
  }
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

describe("docs/storage-format.md, parts that are not text (version 3)", () => {
  let text = "";

  beforeAll(async () => {
    text = await document("docs", "storage-format.md");
  });

  it("lists the saved files in the layout and says who writes them", () => {
    const layout = sectionOf(text, "## Layout");
    expect(layout).toContain("message-<m>-part-<p>.<extension>");
    expect(layout).toMatch(/written by `imbehind serve`/);
  });

  it("describes every field of an attachment, and the four kinds", () => {
    const section = sectionOf(text, "### Attachments");
    expect(section).not.toBe("");
    for (const field of [
      "attachments",
      "at",
      "kind",
      "mediaType",
      "size",
      "file",
      "readable",
      "address",
      "fileId",
      "typeName",
    ]) {
      expect(section, field).toContain(`\`${field}\``);
    }
    for (const kind of ["image", "audio", "file", "other"]) {
      expect(section, kind).toContain(`\`${kind}\``);
    }
    expect(section).toMatch(/Unicode characters/);
    expect(section).toMatch(/empty string/);
  });

  it("has one row for each of the six states of an attachment, and says that others make the file unreadable", () => {
    const section = sectionOf(text, "### Attachments");
    const rows = section
      .split("\n")
      .filter((line) =>
        /^\| (saved|address only|file id only|no data|unreadable|unknown type) \|/.test(line),
      );
    expect(rows).toHaveLength(6);
    expect(section).toMatch(
      /not (in|one of) (this|the) table[^\n]*(cannot|not) (be )?read|does not fit[^\n]*(cannot|not) (be )?read/i,
    );
    expect(section).toMatch(/unknown (keys?|fields?) (is|are) ignored/i);
  });

  it("tells where the saved files are and how they are named", () => {
    const section = sectionOf(text, "### Saved files");
    expect(section).not.toBe("");
    expect(section).toContain("requests/<request id>/");
    expect(section).toContain("message-<m>-part-<p>.<extension>");
    expect(section).toMatch(/count(s|ed)? from 1/);
    expect(section).toContain("`.bin`");
    for (const extension of ["png", "jpg", "gif", "webp", "bmp", "svg", "wav", "mp3", "pdf"]) {
      expect(section, extension).toContain(`\`${extension}\``);
    }
    expect(section).toMatch(/never (use|used)[^\n]*(client|sent)|nothing the client sent/i);
  });

  it("says how a saved file is written: all or nothing, before request.json, with the owner-only mode", () => {
    const section = sectionOf(text, "### Saved files");
    expect(section).toMatch(/before `request\.json`/);
    expect(section).toMatch(/all or nothing|none of them stays/i);
    expect(section).toContain("storage_error");
    expect(section).toContain("`0600`");
    expect(section).toMatch(/never write|must never write/i);
  });

  it("says that the saved files are deleted with the request folder after the retention time", () => {
    const section = sectionOf(text, "### Saved files");
    expect(section).toMatch(/retention/i);
    expect(section).toMatch(/with (the|its) (request )?folder/i);
    expect(section).toMatch(/recorded in `attachments`/);
    expect(section).toMatch(/symbolic link|directory/i);
  });

  it("says that a request.json over the size limit is not cleaned up, with the limit from the code (R-04)", () => {
    const section = sectionOf(text, "### Saved files");
    expect(section).toContain(String(MAX_REQUEST_FILE_BYTES));
    expect(section).toMatch(/larger than[^\n]*MAX_REQUEST_FILE_BYTES|larger than 278746355/i);
    expect(section).toMatch(/kept|not (cleaned|deleted|removed)/i);
    expect(section).toMatch(/indent/i);
  });

  it("names the condition under which the folder of a request.json that is not read is kept", () => {
    const section = sectionOf(text, "### Saved files");
    const bullet =
      section.split("\n").find((line) => line.includes("MAX_REQUEST_FILE_BYTES")) ?? "";
    // Kept only when it also holds a file that has the form of a saved name; otherwise removed.
    expect(bullet).toMatch(/only (when|if)[^\n]*(form of a saved name|saved file name)/i);
    expect(bullet).toMatch(/otherwise[^\n]*(deleted|removed)/i);
    expect(bullet).not.toMatch(/So the folder of such a request is kept, and/);
  });

  it("says that attachments, when present, has at least one item", () => {
    const section = sectionOf(text, "### Attachments");
    expect(section).toMatch(/at least one item/i);
    expect(section).toMatch(/empty (array|list)[^\n]*(cannot|not) (be )?read/i);
  });

  it("is written in English", () => {
    expect(JAPANESE.test(text)).toBe(false);
  });
});

describe("docs/specification.md, parts that are not text", () => {
  let text = "";

  beforeAll(async () => {
    text = await document("docs", "specification.md");
  });

  it("says in the Request section that image_url, input_audio and file parts are accepted for every role (AC3.1.7)", () => {
    const section = sectionOf(text, "### Request");
    expect(section).not.toBe("");
    for (const type of ["image_url", "input_audio", "file"]) {
      expect(section, type).toContain(`\`${type}\``);
    }
    expect(section).toMatch(/accepted|received/i);
    expect(section).toMatch(/every role|any role|all roles/i);
  });

  it("says that parts of an unknown type and parts that cannot be read are accepted, and that nothing is fetched", () => {
    const section = sectionOf(text, "### Request");
    expect(section).toMatch(/any other `type`|unknown `type`|type this version does not know/i);
    expect(section).toMatch(/cannot be read|unreadable/i);
    expect(section).toMatch(/never fetch|does not fetch|not fetch/i);
  });

  it("says that a content that is a string stays text, even when it looks like a part", () => {
    const section = sectionOf(text, "### Request");
    expect(section).toMatch(/string[^\n]*\b(as it is|plain text|text)\b[^\n]*(JSON|base64|image)/i);
  });

  it("no longer calls an array content an array of text parts only (R-05)", () => {
    expect(text).not.toMatch(/array of text parts/i);
    expect(text).not.toMatch(/text parts `\{"type": "text"/);
    expect(sectionOf(text, "### Request")).toMatch(
      /`text` parts?[^\n]*joined without a separator/i,
    );
  });

  it("tells in its own section which parts are saved, kept as an address or a file_id, or unreadable", () => {
    const section = sectionOf(text, "### Parts that are not text");
    expect(section).not.toBe("");
    expect(section).toContain("data:");
    expect(section).toContain(";base64");
    for (const word of [
      "image_url",
      "input_audio",
      "file_data",
      "file_id",
      "audio/wav",
      "audio/mpeg",
    ]) {
      expect(section, word).toContain(word);
    }
    expect(section).toMatch(/standard alphabet|`A`-`Z`|A-Z/);
    expect(section).toContain("storage-format.md");
  });

  it("does not list a row in the refusal table that refuses these three kinds of part (AC3.1.7)", () => {
    const section = sectionOf(text, "### Requests that are refused");
    expect(section).not.toBe("");
    expect(section).not.toContain("unsupported_content");
    const rows = section.split("\n").filter((line) => line.startsWith("|"));
    expect(rows.length).toBeGreaterThan(5);
    for (const row of rows) {
      expect(row).not.toMatch(/image|audio|input_audio|image_url|a file part/i);
    }
    expect(section).toMatch(/not (a reason to )?refus/i);
  });

  it("describes the part lines of `imbehind answer` and the cut at 1000 characters (AC3.1.7)", () => {
    const section = sectionOf(text, "### What `imbehind answer` does");
    expect(section).not.toBe("");
    for (const word of [
      "[image]",
      "[audio]",
      "[file]",
      "saved:",
      "(unreadable)",
      "file_id",
      "1000",
      "characters in this line",
    ]) {
      expect(section, word).toContain(word);
    }
    expect(section).toMatch(/absolute path/i);
    expect(section).toMatch(/in the order (they|the parts) arrived/i);
    expect(section).toMatch(/not (cut|counted)[^\n]*`saved:`|`saved:`[^\n]*(is )?not cut/i);
    expect(section).toMatch(/may change|can change|are for people/i);
  });

  it("lists the number of characters of one line, and the parts, in the Limits table (AC3.1.7)", () => {
    const section = sectionOf(text, "## Limits");
    const rows = section.split("\n").filter((line) => line.startsWith("| "));
    const line = rows.find((row) => /1000/.test(row) && /character/i.test(row));
    expect(line).toBeDefined();
    expect(rows.some((row) => /parts that are not text/i.test(row) && /no limit/i.test(row))).toBe(
      true,
    );
  });

  it("says in Storage and states that the saved parts are files in the request folder that go with it", () => {
    const section = sectionOf(text, "## Storage and states");
    expect(section).toContain("message-<m>-part-<p>");
    expect(section).toMatch(/with (the|its) (request )?folder/i);
    expect(section).toMatch(/retention/i);
  });
});

describe("docs/requirements.md, parts that are not text", () => {
  let text = "";

  /** The line of a requirement, found by its number. */
  const requirement = (id: string): string =>
    text.split("\n").find((line) => line.startsWith(`- **${id}**`)) ?? "";

  beforeAll(async () => {
    text = await document("docs", "requirements.md");
  });

  it("has FR8 as the group that accepts and shows these parts, not the one that refuses them (AC1.1.6)", () => {
    expect(text).toMatch(/^### FR8 Parts that are not text \(Must\)$/m);
    expect(text).not.toContain("Refuse parts that are not text");
    expect(text).not.toMatch(/is refused at once/i);
    expect(text).not.toMatch(/images are not supported/i);
    expect(text).not.toMatch(/unsupported part type/i);
  });

  it("states in FR8 what is accepted, saved, not fetched, shown, and cut", () => {
    const section = sectionOf(text, "### FR8 Parts that are not text (Must)");
    for (const id of ["FR8.1", "FR8.2", "FR8.3", "FR8.4", "FR8.5"]) {
      expect(section, id).toContain(id);
    }
    for (const word of ["image_url", "input_audio", "file", "unreadable", "1000"]) {
      expect(section, word).toContain(word);
    }
    expect(requirement("FR8.1")).toMatch(/accepted/i);
    expect(requirement("FR8.1")).toMatch(/every role|any role|all roles/i);
    expect(requirement("FR8.3")).toMatch(/saved|written/i);
    expect(requirement("FR8.3")).toMatch(/never fetch|does not fetch|not fetch/i);
    expect(requirement("FR8.4")).toMatch(/one line|a line/i);
    expect(requirement("FR8.4")).toMatch(/absolute path/i);
    expect(requirement("FR8.5")).toMatch(/cut/i);
  });

  it("keeps the refusal of parts that are not objects, or have no type, in FR8 or FR1", () => {
    const section = sectionOf(text, "### FR8 Parts that are not text (Must)");
    expect(section).toMatch(/not an object|no string `type`|without a string `type`/i);
    expect(section).toMatch(/refused|client error/i);
  });

  it("mentions the lines of these parts in FR4.2 and FR4.9, and no longer says that only text parts are shown", () => {
    expect(requirement("FR4.2")).toMatch(/part/i);
    expect(requirement("FR4.9")).not.toBe(
      "A `content` that is an array of text parts is shown as the parts joined together.",
    );
    expect(requirement("FR4.9")).not.toMatch(/array of text parts/i);
    expect(requirement("FR4.9")).toMatch(/not text/i);
    expect(requirement("FR4.9")).toMatch(/line/i);
  });

  it("says in FR12.3 that parts that are not text are received and shown, not refused", () => {
    const line = requirement("FR12.3");
    expect(line).not.toMatch(/parts that are not text are refused/i);
    expect(line).not.toMatch(/refus/i);
    expect(line).toMatch(/not text/i);
    expect(line).toMatch(/received|accepted/i);
  });

  it("says in FR14.1 that request.json is version 3 and that it reads versions 1, 2 and 3 (AC5.1.6)", () => {
    const line = requirement("FR14.1");
    expect(line).not.toMatch(/`formatVersion` of `request\.json` is 2/);
    expect(line).not.toMatch(/reads request files of both versions 1 and 2/);
    expect(line).toMatch(/`formatVersion` of `request\.json` is 3/);
    expect(line).toMatch(/versions 1, 2 and 3/);
    expect(line).toMatch(/version 3 request file/);
  });

  it("no longer says in the out-of-scope table that the first release refuses images", () => {
    const section = sectionOf(text, "## Out of scope");
    expect(section).not.toContain("A reply written after the human has seen an image");
    expect(section).not.toMatch(/refuses images/i);
    expect(section).toMatch(/\| [^|\n]*(image|audio|file)[^|\n]* \| Will not be built/i);
  });

  it("keeps the requirement numbers around these changes", () => {
    for (const id of ["FR1.8", "FR4.2", "FR4.9", "FR8.1", "FR12.3", "FR14.1", "FR14.5"]) {
      // The line of the requirement itself, not a mention of it inside another requirement.
      expect(requirement(id), id).toMatch(
        new RegExp(`^- \\*\\*${id.replace(".", "\\.")}\\*\\* \\S`),
      );
    }
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

  it("mention the parts that are not text", async () => {
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

  it("do not say that parts that are not text are refused, and no longer name unsupported_content (AC1.1.6)", async () => {
    for (const name of READMES) {
      expect(await document(name), name).not.toContain("unsupported_content");
    }
    const english = await document("README.md");
    expect(english).not.toMatch(/\b(image|audio|file)s?\b[^.\n]*\b(is|are) refused\b/i);
    expect(english).not.toMatch(/A request that is refused, such as one with an image/i);
    // The Japanese words "refuse" (in three forms), written as code points.
    const japanese = await document("README.ja.md");
    for (const word of [
      String.fromCodePoint(0x65ad, 0x308b),
      String.fromCodePoint(0x65ad, 0x3063, 0x305f),
      String.fromCodePoint(0x65ad, 0x3089),
    ]) {
      expect(japanese, word).not.toContain(word);
    }
  });

  it("say that parts that are not text are received, saved and shown, and that addresses are not fetched (AC1.1.6)", async () => {
    const english = await document("README.md");
    expect(english).toMatch(/\(image, audio, a file\)[^.\n]*\breceived\b/i);
    expect(english).toMatch(/\bsaved\b[^.\n]*\bfile/i);
    expect(english).toMatch(/\bshows?\b[^.\n]*\bline\b/i);
    expect(english).toMatch(/never fetch|not fetch|does not fetch/i);
    // The Japanese words "receive" (uketotte), "save" (hozon) and "not fetch" (torini ikimasen).
    const japanese = await document("README.ja.md");
    expect(japanese).toContain(String.fromCodePoint(0x53d7, 0x3051, 0x53d6, 0x3063, 0x3066));
    expect(japanese).toContain(String.fromCodePoint(0x4fdd, 0x5b58));
    expect(japanese).toContain(
      String.fromCodePoint(0x53d6, 0x308a, 0x306b, 0x3044, 0x304d, 0x307e, 0x305b, 0x3093),
    );
  });

  it("say in the notes that the data of images, audio and files is saved too, and that a request that is not valid is not", async () => {
    const english = await document("README.md");
    const notes = english.split(/^## Notes$/m)[1]?.split(/^## /m)[0] ?? "";
    expect(notes).toMatch(/images?, audio and files?/i);
    expect(notes).toMatch(/not valid|malformed/i);
    expect(notes).toMatch(/not saved/i);
    const japanese = await document("README.ja.md");
    // The Japanese words "a request with a wrong form is not saved", written as code points.
    expect(japanese).toContain(
      String.fromCodePoint(0x4f9d, 0x983c, 0x306f, 0x4fdd, 0x5b58, 0x3057, 0x307e, 0x305b, 0x3093),
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
    expect(text).not.toContain("unsupported_content");
    const row = text.split("\n").find((line) => line.includes("| 400 | `invalid_request` |"));
    expect(row).toBeDefined();
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
