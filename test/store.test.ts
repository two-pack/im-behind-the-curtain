import {
  chmod,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ExchangeBroker } from "../src/broker/exchange-broker.js";
import { AlreadyExistsError, IoFailure, StartupError } from "../src/errors.js";
import {
  type ConversationRequest,
  createReplyFile,
  createRequestFile,
  createStateFile,
  MAX_FILE_BYTES,
  serializeFile,
} from "../src/model.js";
import { ExchangeStore, isOwnTempName, nodeFs, type StoreFs } from "../src/store/exchange-store.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { errno, makeTempDir } from "./helpers/fs.js";

const ID = "20261009T140512123Z-a1b2c3";
const OTHER_ID = "20261009T140513000Z-d4e5f6";
const NOW = "2026-10-09T14:05:12.123Z";

const conversation: ConversationRequest = {
  format: "chat.completions",
  model: "m",
  replyKind: "text",
  requiredShape: null,
  stream: false,
  includeUsage: false,
  conversation: [{ role: "user", content: "Hello" }],
  originalRequest: { model: "m" },
};

function sampleRequest(id = ID) {
  return createRequestFile(id, NOW, conversation);
}

function sampleState(id = ID) {
  return createStateFile(id, "waiting", NOW, null);
}

async function newStore(overrides: Partial<StoreFs> = {}) {
  const root = await makeTempDir();
  const store = new ExchangeStore({ rootDir: root, fs: { ...nodeFs, ...overrides } });
  await store.prepare();
  return { root, store, requests: path.join(root, "requests") };
}

/** A path below `base`, always written with forward slashes. */
function relative(base: string, target: string): string {
  return path.relative(base, target).split(path.sep).join("/");
}

async function names(dir: string): Promise<string[]> {
  return (await readdir(dir)).sort();
}

/** Accepts the bytes that reply.json holds now, as the broker does with the bytes it verified. */
async function acceptFromDisk(store: ExchangeStore, id: string): Promise<void> {
  const bytes = await readFile(path.join(store.rootDir, "requests", id, "reply.json"));
  await store.acceptReply(id, bytes);
}

describe("preparing the storage directory", () => {
  it("creates the storage directory and requests/ when they are missing", async () => {
    const parent = await makeTempDir();
    const root = path.join(parent, "a", "imbehind");
    const store = new ExchangeStore({ rootDir: root });
    await store.prepare();
    expect((await stat(path.join(root, "requests"))).isDirectory()).toBe(true);
    await store.prepare();
    expect(await names(root)).toEqual(["requests"]);
  });

  it("fails with a startup error that names the directory and the reason", async () => {
    const parent = await makeTempDir();
    const blocker = path.join(parent, "file");
    await writeFile(blocker, "x");
    const store = new ExchangeStore({ rootDir: path.join(blocker, "imbehind") });
    await expect(store.prepare()).rejects.toBeInstanceOf(StartupError);
    await expect(store.prepare()).rejects.toThrow(/cannot create .*imbehind.*not a directory/);
  });

  it("fails with a startup error when the directory cannot make hard links", async () => {
    const root = await makeTempDir();
    const store = new ExchangeStore({
      rootDir: root,
      fs: { ...nodeFs, link: () => Promise.reject(errno("EPERM")) },
    });
    const failure = store.prepare();
    await expect(failure).rejects.toBeInstanceOf(StartupError);
    await expect(failure).rejects.toThrow(/hard links.*operation not permitted/);
    await expect(failure).rejects.toThrow(root);
  });

  it("leaves no temporary file behind after the hard link check", async () => {
    const { root } = await newStore();
    expect(await names(root)).toEqual(["requests"]);
  });
});

describe("creating a request", () => {
  it("writes request.json and state.json into a hidden directory, then renames it", async () => {
    const calls: string[] = [];
    const root = await makeTempDir();
    const requests = path.join(root, "requests");
    const store = new ExchangeStore({
      rootDir: root,
      fs: {
        ...nodeFs,
        writeFile: (file, data) => {
          calls.push(`write ${relative(requests, file)}`);
          return nodeFs.writeFile(file, data);
        },
        rename: (from, to) => {
          calls.push(`rename ${relative(requests, from)} ${relative(requests, to)}`);
          return nodeFs.rename(from, to);
        },
      },
    });
    await store.prepare();
    calls.length = 0;
    await store.createRequest(sampleRequest(), sampleState());
    expect(calls).toEqual([
      `write .${ID}/request.json`,
      `write .${ID}/state.json`,
      `rename .${ID} ${ID}`,
    ]);
    expect(await names(path.join(requests, ID))).toEqual(["request.json", "state.json"]);
    expect(await names(requests)).toEqual([ID]);
  });

  it("stores readable files that read back as the same request and state", async () => {
    const { store } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    const request = await store.readRequest(ID);
    const state = await store.readState(ID);
    expect(request.kind === "ok" && request.value.id).toBe(ID);
    expect(request.kind === "ok" && request.value.conversation[0]?.content).toBe("Hello");
    expect(state.kind === "ok" && state.value.state).toBe("waiting");
  });

  it("does not keep a hidden directory or a half request when a write fails", async () => {
    const { store, requests } = await newStore({
      writeFile: (file, data) =>
        file.endsWith("state.json")
          ? Promise.reject(errno("ENOSPC"))
          : nodeFs.writeFile(file, data),
    });
    await expect(store.createRequest(sampleRequest(), sampleState())).rejects.toMatchObject({
      name: "IoFailure",
      reason: "write failed",
      detail: "no space left on device",
    });
    expect(await names(requests)).toEqual([]);
  });

  it("does not keep a hidden directory when the final rename fails", async () => {
    const { store, requests } = await newStore({
      rename: () => Promise.reject(errno("EBUSY")),
    });
    await expect(store.createRequest(sampleRequest(), sampleState())).rejects.toMatchObject({
      reason: "rename failed",
    });
    expect(await names(requests)).toEqual([]);
  });

  it("fails with an IoFailure when the hidden directory cannot be made", async () => {
    const { root } = await newStore();
    const store = new ExchangeStore({
      rootDir: root,
      fs: { ...nodeFs, mkdir: () => Promise.reject(errno("EACCES")) },
    });
    await expect(store.createRequest(sampleRequest(), sampleState())).rejects.toMatchObject({
      reason: "write failed",
      detail: "permission denied",
    });
  });
});

const PART_A = "message-1-part-1.png";
const PART_B = "message-1-part-2.bin";

function attachment(file: string, at = 0, size = 3) {
  return {
    at,
    kind: "image" as const,
    mediaType: "image/png",
    size,
    file,
    readable: true,
    address: null,
    fileId: null,
    typeName: null,
  };
}

/** A request whose first message has the saved parts `files`, and the matching part data. */
function requestWithParts(files: string[], id = ID) {
  const withParts: ConversationRequest = {
    ...conversation,
    conversation: [
      {
        role: "user",
        content: "",
        attachments: files.map((file) => attachment(file)),
      },
    ],
  };
  const parts = files.map((file, index) => ({
    file,
    bytes: new Uint8Array([index, 2, 3]),
  }));
  return { request: createRequestFile(id, NOW, withParts), parts };
}

describe("creating a request with saved parts", () => {
  it("writes the parts before request.json and state.json, all in the hidden directory", async () => {
    const calls: string[] = [];
    const root = await makeTempDir();
    const requests = path.join(root, "requests");
    const store = new ExchangeStore({
      rootDir: root,
      fs: {
        ...nodeFs,
        writeFile: (file, data, mode) => {
          calls.push(`text ${relative(requests, file)}`);
          return nodeFs.writeFile(file, data, mode);
        },
        writeBytes: (file, bytes, mode) => {
          calls.push(`bytes ${relative(requests, file)}`);
          return nodeFs.writeBytes(file, bytes, mode);
        },
        rename: (from, to) => {
          calls.push(`rename ${relative(requests, from)} ${relative(requests, to)}`);
          return nodeFs.rename(from, to);
        },
      },
    });
    await store.prepare();
    calls.length = 0;
    const { request, parts } = requestWithParts([PART_A, PART_B]);
    await store.createRequest(request, sampleState(), parts);
    expect(calls).toEqual([
      `bytes .${ID}/${PART_A}`,
      `bytes .${ID}/${PART_B}`,
      `text .${ID}/request.json`,
      `text .${ID}/state.json`,
      `rename .${ID} ${ID}`,
    ]);
    const dir = path.join(requests, ID);
    expect(await names(dir)).toEqual([PART_A, PART_B, "request.json", "state.json"]);
    expect([...(await readFile(path.join(dir, PART_B)))]).toEqual([1, 2, 3]);
  });

  it("writes a part of zero bytes as an empty file", async () => {
    const { store, requests } = await newStore();
    const { request } = requestWithParts([PART_A]);
    await store.createRequest(request, sampleState(), [{ file: PART_A, bytes: new Uint8Array(0) }]);
    expect((await stat(path.join(requests, ID, PART_A))).size).toBe(0);
  });

  it("keeps the recorded attachments when the request is read back", async () => {
    const { store } = await newStore();
    const { request, parts } = requestWithParts([PART_A]);
    await store.createRequest(request, sampleState(), parts);
    const read = await store.readRequest(ID);
    expect(read.kind === "ok" && read.value.conversation[0]?.attachments).toEqual([
      attachment(PART_A),
    ]);
  });

  it("leaves nothing when writing a part fails, whichever part it is", async () => {
    for (const failing of [PART_A, PART_B]) {
      const { store, requests } = await newStore({
        writeBytes: (file, bytes, mode) =>
          file.endsWith(failing)
            ? Promise.reject(errno("ENOSPC"))
            : nodeFs.writeBytes(file, bytes, mode),
      });
      const { request, parts } = requestWithParts([PART_A, PART_B]);
      await expect(store.createRequest(request, sampleState(), parts)).rejects.toMatchObject({
        name: "IoFailure",
        reason: "write failed",
        detail: "no space left on device",
      });
      expect(await names(requests)).toEqual([]);
    }
  });

  it("leaves nothing when request.json fails after the parts were written", async () => {
    const { store, requests } = await newStore({
      writeFile: (file, data, mode) =>
        file.endsWith("request.json")
          ? Promise.reject(errno("EIO"))
          : nodeFs.writeFile(file, data, mode),
    });
    const { request, parts } = requestWithParts([PART_A]);
    await expect(store.createRequest(request, sampleState(), parts)).rejects.toMatchObject({
      reason: "write failed",
    });
    expect(await names(requests)).toEqual([]);
  });

  it("writes nothing when a part has a name that is not of the form it makes", async () => {
    let written = 0;
    const { store, requests } = await newStore({
      writeBytes: (file, bytes, mode) => {
        written += 1;
        return nodeFs.writeBytes(file, bytes, mode);
      },
    });
    const bad = ["../message-1-part-1.png", "request.json", "message-1-part-1.PNG", "a/b.png", ""];
    for (const file of bad) {
      const { request } = requestWithParts([PART_A]);
      const parts = [
        { file: PART_A, bytes: new Uint8Array(1) },
        { file, bytes: new Uint8Array(1) },
      ];
      await expect(store.createRequest(request, sampleState(), parts)).rejects.toMatchObject({
        name: "IoFailure",
        reason: "write failed",
      });
    }
    expect(written).toBe(0);
    expect(await names(requests)).toEqual([]);
  });

  it("fails when two parts have the same name", async () => {
    const { store, requests } = await newStore();
    const { request } = requestWithParts([PART_A]);
    const part = { file: PART_A, bytes: new Uint8Array(1) };
    await expect(store.createRequest(request, sampleState(), [part, part])).rejects.toMatchObject({
      reason: "write failed",
    });
    expect(await names(requests)).toEqual([]);
  });

  it("fails like a write failure when the path is too long for the system", async () => {
    const { store, requests } = await newStore({
      writeBytes: () => Promise.reject(errno("ENAMETOOLONG")),
    });
    const { request, parts } = requestWithParts([PART_A]);
    await expect(store.createRequest(request, sampleState(), parts)).rejects.toMatchObject({
      reason: "write failed",
    });
    expect(await names(requests)).toEqual([]);
  });

  it("writes nothing when request.json records a file that is not among the parts", async () => {
    let written = 0;
    const { store, requests } = await newStore({
      writeBytes: (file, bytes, mode) => {
        written += 1;
        return nodeFs.writeBytes(file, bytes, mode);
      },
    });
    const { request, parts } = requestWithParts([PART_A, PART_B]);
    for (const given of [[], parts.slice(0, 1), parts.slice(1)]) {
      await expect(store.createRequest(request, sampleState(), given)).rejects.toMatchObject({
        name: "IoFailure",
        reason: "write failed",
      });
    }
    expect(written).toBe(0);
    expect(await names(requests)).toEqual([]);
  });

  it("takes no parts as an empty list", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState(), []);
    expect(await names(path.join(requests, ID))).toEqual(["request.json", "state.json"]);
  });
});

describe.skipIf(process.platform === "win32")("the mode of saved parts", () => {
  it("writes a saved part so that only the owner can read and write it", async () => {
    const root = await makeTempDir();
    const store = new ExchangeStore({ rootDir: root, platform: "linux" });
    await store.prepare();
    const { request, parts } = requestWithParts([PART_A]);
    await store.createRequest(request, sampleState(), parts);
    expect(await modeOf(path.join(root, "requests", ID, PART_A))).toBe(0o600);
  });

  it("passes the mode 0600 to writeBytes on Linux and no mode on Windows", async () => {
    const modes: Record<string, number | undefined> = {};
    for (const platform of ["linux", "darwin", "win32"] as const) {
      const root = await makeTempDir();
      const store = new ExchangeStore({
        rootDir: root,
        platform,
        fs: {
          ...nodeFs,
          writeBytes: (file, bytes, mode) => {
            modes[platform] = mode;
            return nodeFs.writeBytes(file, bytes);
          },
        },
      });
      await store.prepare();
      const { request, parts } = requestWithParts([PART_A]);
      await store.createRequest(request, sampleState(), parts);
    }
    expect(modes).toEqual({ linux: 0o600, darwin: 0o600, win32: undefined });
  });
});

describe("listing requests", () => {
  it("lists only directory names that are valid ids, in order", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(OTHER_ID), sampleState(OTHER_ID));
    await store.createRequest(sampleRequest(ID), sampleState(ID));
    await mkdir(path.join(requests, `.${"20261009T140514000Z-000000"}`));
    await mkdir(path.join(requests, "stray"));
    await writeFile(path.join(requests, ".hidden.tmp"), "x");
    expect(await store.listIds()).toEqual([ID, OTHER_ID]);
  });

  it("reads a directory without state.json as missing and never deletes it", async () => {
    const { store, requests } = await newStore();
    await mkdir(path.join(requests, ID));
    await writeFile(path.join(requests, ID, "request.json"), "{}");
    expect(await store.readState(ID)).toEqual({ kind: "missing" });
    expect(await names(path.join(requests, ID))).toEqual(["request.json"]);
    expect(await store.listIds()).toEqual([ID]);
  });

  it("finds the largest id", async () => {
    const { store } = await newStore();
    expect(await store.maxId()).toBeUndefined();
    await store.createRequest(sampleRequest(ID), sampleState(ID));
    await store.createRequest(sampleRequest(OTHER_ID), sampleState(OTHER_ID));
    expect(await store.maxId()).toBe(OTHER_ID);
  });

  it("reports a failed directory read as an IoFailure", async () => {
    const { store } = await newStore({ readdir: () => Promise.reject(errno("EACCES")) });
    await expect(store.listIds()).rejects.toMatchObject({
      name: "IoFailure",
      reason: "read failed",
    });
  });

  it("lists the file names inside one request directory", async () => {
    const { store } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    expect([...(await store.listFiles(ID))].sort()).toEqual(["request.json", "state.json"]);
    expect((await store.listFiles(OTHER_ID)).size).toBe(0);
  });

  it("tells where request.json of a request is", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    const file = store.requestFilePath(ID);
    expect(file).toBe(path.join(requests, ID, "request.json"));
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ id: ID });
  });
});

describe("reading files", () => {
  it("reads garbage as unreadable and a missing file as missing", async () => {
    const { store, requests } = await newStore();
    await mkdir(path.join(requests, ID));
    await writeFile(path.join(requests, ID, "request.json"), "{not json");
    await writeFile(path.join(requests, ID, "state.json"), "[]");
    expect(await store.readRequest(ID)).toEqual({ kind: "unreadable" });
    expect(await store.readState(ID)).toEqual({ kind: "unreadable" });
    expect(await store.readRequest(OTHER_ID)).toEqual({ kind: "missing" });
  });

  it("reads JSON without the required fields as unreadable and leaves the files in place", async () => {
    const { store, requests } = await newStore();
    await mkdir(path.join(requests, ID));
    const files = ["request.json", "state.json", "reply.accepted.json"];
    for (const name of files) {
      await writeFile(path.join(requests, ID, name), "{}");
    }
    expect(await store.readRequest(ID)).toEqual({ kind: "unreadable" });
    expect(await store.readState(ID)).toEqual({ kind: "unreadable" });
    expect(await store.readReply(ID, "reply.accepted.json")).toEqual({
      bytes: "{}",
      parsed: { kind: "unreadable" },
    });
    expect([...(await store.listFiles(ID))].sort()).toEqual(files.sort());
  });

  it("reads a broken reply.accepted.json as unreadable and keeps its bytes", async () => {
    const { store, requests } = await newStore();
    await mkdir(path.join(requests, ID));
    await writeFile(path.join(requests, ID, "reply.accepted.json"), "{not json");
    expect(await store.readReply(ID, "reply.accepted.json")).toEqual({
      bytes: "{not json",
      parsed: { kind: "unreadable" },
    });
    expect(await store.readReply(ID, "reply.json")).toBeUndefined();
  });

  it("reports a failed read as an IoFailure, not as missing", async () => {
    const { store } = await newStore({ readFile: () => Promise.reject(errno("EACCES")) });
    await expect(store.readState(ID)).rejects.toMatchObject({
      name: "IoFailure",
      reason: "read failed",
    });
  });
});

describe("writing state", () => {
  it("replaces state.json by renaming a finished hidden file", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    await store.writeState(createStateFile(ID, "replied", NOW, NOW));
    const state = await store.readState(ID);
    expect(state.kind === "ok" && state.value.state).toBe("replied");
    expect(await names(path.join(requests, ID))).toEqual(["request.json", "state.json"]);
  });

  it("keeps the old state.json and leaves no hidden file when the write fails", async () => {
    let failing = false;
    const { store, requests } = await newStore({
      writeFile: (file, data) =>
        failing ? Promise.reject(errno("ENOSPC")) : nodeFs.writeFile(file, data),
    });
    await store.createRequest(sampleRequest(), sampleState());
    failing = true;
    await expect(store.writeState(createStateFile(ID, "replied", NOW, NOW))).rejects.toMatchObject({
      reason: "write failed",
    });
    const state = await store.readState(ID);
    expect(state.kind === "ok" && state.value.state).toBe("waiting");
    expect(await names(path.join(requests, ID))).toEqual(["request.json", "state.json"]);
  });

  it("reports a failed rename as rename failed and removes the hidden file", async () => {
    let failing = false;
    const { store, requests } = await newStore({
      rename: (from, to) => (failing ? Promise.reject(errno("EBUSY")) : nodeFs.rename(from, to)),
    });
    await store.createRequest(sampleRequest(), sampleState());
    failing = true;
    await expect(store.writeState(createStateFile(ID, "replied", NOW, NOW))).rejects.toMatchObject({
      reason: "rename failed",
    });
    expect(await names(path.join(requests, ID))).toEqual(["request.json", "state.json"]);
  });
});

describe("ending a request", () => {
  it("writes each new state with its end time and end reason in one write, and reads it back", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    const endings = [
      ["skipped", "skipped by the human"],
      ["cancelled", "client disconnected"],
      ["timed_out", "wait limit of 1 seconds reached"],
    ] as const;
    for (const [state, reason] of endings) {
      await store.writeState(createStateFile(ID, state, NOW, NOW, reason));
      const read = await store.readState(ID);
      expect(read.kind === "ok" && read.value).toMatchObject({
        state,
        updatedAt: NOW,
        endedAt: NOW,
        endReason: reason,
      });
    }
    expect(await names(path.join(requests, ID))).toEqual(["request.json", "state.json"]);
  });

  it("places a skip reply with an empty body, accepts it, and reads it back as skip", async () => {
    const { store } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    const bytes = serializeFile(createReplyFile("", NOW, "skip"));
    await store.placeReply(ID, bytes);
    await acceptFromDisk(store, ID);
    const read = await store.readReply(ID, "reply.accepted.json");
    expect(read?.bytes).toBe(bytes);
    expect(read?.parsed.kind === "ok" && read.parsed.value.kind).toBe("skip");
    expect(read?.parsed.kind === "ok" && read.parsed.value.body).toBe("");
  });
});

describe("json requests and replies", () => {
  const shape = { type: "object", properties: { passed: { type: "boolean" } } };
  const jsonRequest = createRequestFile(ID, NOW, {
    ...conversation,
    replyKind: "json",
    requiredShape: shape,
    stream: true,
    includeUsage: true,
  });

  it("writes replyKind, requiredShape, stream and includeUsage as real values", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(jsonRequest, sampleState());
    const onDisk = JSON.parse(await readFile(path.join(requests, ID, "request.json"), "utf8"));
    expect(onDisk).toMatchObject({
      formatVersion: 3,
      toolDefinitions: "none",
      replyKind: "json",
      requiredShape: shape,
      stream: true,
      includeUsage: true,
    });
    const read = await store.readRequest(ID);
    expect(read.kind === "ok" && read.value.replyKind).toBe("json");
    expect(read.kind === "ok" && read.value.requiredShape).toEqual(shape);
  });

  it("reads a request of an unknown reply kind as unsupported, not unreadable", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    const file = path.join(requests, ID, "request.json");
    const onDisk = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify({ ...onDisk, replyKind: "image" }));
    expect((await store.readRequest(ID)).kind).toBe("unsupported");
  });

  it("places a json reply, accepts it like a text reply, and reads it back as written", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(jsonRequest, sampleState());
    const body = '{"passed":   true}';
    const bytes = serializeFile(createReplyFile(body, NOW, "json"));
    await store.placeReply(ID, bytes);
    await acceptFromDisk(store, ID);
    await store.removeReply(ID);
    expect(await names(path.join(requests, ID))).toEqual([
      "reply.accepted.json",
      "request.json",
      "state.json",
    ]);
    const read = await store.readReply(ID, "reply.accepted.json");
    expect(read?.bytes).toBe(bytes);
    expect(read?.parsed.kind === "ok" && read.parsed.value.kind).toBe("json");
    expect(read?.parsed.kind === "ok" && read.parsed.value.body).toBe(body);
  });
});

describe("placing a reply", () => {
  const replyText = serializeFile(createReplyFile("Hi", NOW));

  it("places reply.json with the given bytes and leaves no hidden file", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    await store.placeReply(ID, replyText);
    expect(await readFile(path.join(requests, ID, "reply.json"), "utf8")).toBe(replyText);
    expect(await names(path.join(requests, ID))).toEqual([
      "reply.json",
      "request.json",
      "state.json",
    ]);
  });

  it("fails with AlreadyExistsError when reply.json exists and does not replace it", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    await store.placeReply(ID, replyText);
    await expect(store.placeReply(ID, "second")).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(await readFile(path.join(requests, ID, "reply.json"), "utf8")).toBe(replyText);
    expect(await names(path.join(requests, ID))).toEqual([
      "reply.json",
      "request.json",
      "state.json",
    ]);
  });

  it("lets only one of two simultaneous replies succeed", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    const results = await Promise.allSettled([
      store.placeReply(ID, "first"),
      store.placeReply(ID, "second"),
    ]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(succeeded).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AlreadyExistsError);
    expect(["first", "second"]).toContain(
      await readFile(path.join(requests, ID, "reply.json"), "utf8"),
    );
  });

  it("never lets hidden file names collide, even with the same random value", async () => {
    const root = await makeTempDir();
    const store = new ExchangeStore({ rootDir: root, randomHex: () => "aaaaaaaa" });
    await store.prepare();
    await store.createRequest(sampleRequest(), sampleState());
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, (_, index) => store.placeReply(ID, `reply ${index}`)),
    );
    const failures = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(failures).toHaveLength(19);
    expect(failures.every((f) => f.reason instanceof AlreadyExistsError)).toBe(true);
  });

  it("reports a failed write as write failed and keeps no hidden file", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    const failing = new ExchangeStore({
      rootDir: path.dirname(requests),
      fs: { ...nodeFs, writeFile: () => Promise.reject(errno("ENOSPC")) },
    });
    await expect(failing.placeReply(ID, replyText)).rejects.toMatchObject({
      reason: "write failed",
      detail: "no space left on device",
    });
    expect(await names(path.join(requests, ID))).toEqual(["request.json", "state.json"]);
  });

  it("reports a failed hard link as link failed and keeps no hidden file", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    const failing = new ExchangeStore({
      rootDir: path.dirname(requests),
      fs: { ...nodeFs, link: () => Promise.reject(errno("EIO")) },
    });
    const failure = failing.placeReply(ID, replyText);
    await expect(failure).rejects.toBeInstanceOf(IoFailure);
    await expect(failure).rejects.toMatchObject({ reason: "link failed" });
    expect(await names(path.join(requests, ID))).toEqual(["request.json", "state.json"]);
  });
});

describe("accepting a reply", () => {
  const replyText = serializeFile(createReplyFile("Hi", NOW));

  it("links reply.accepted.json to reply.json, then removes reply.json", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    await store.placeReply(ID, replyText);
    await acceptFromDisk(store, ID);
    expect((await store.listFiles(ID)).has("reply.json")).toBe(true);
    expect(await readFile(path.join(requests, ID, "reply.accepted.json"), "utf8")).toBe(replyText);
    await store.removeReply(ID);
    expect(await names(path.join(requests, ID))).toEqual([
      "reply.accepted.json",
      "request.json",
      "state.json",
    ]);
  });

  it("never replaces an existing reply.accepted.json", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    await store.placeReply(ID, replyText);
    await acceptFromDisk(store, ID);
    await store.removeReply(ID);
    await store.placeReply(ID, "late reply");
    await expect(acceptFromDisk(store, ID)).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(await readFile(path.join(requests, ID, "reply.accepted.json"), "utf8")).toBe(replyText);
  });

  it("removes reply.json without an error when it is already gone", async () => {
    const { store } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    await store.removeReply(ID);
    await store.removeReply(ID);
  });

  it("reports a failed removal as an IoFailure", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    await store.placeReply(ID, replyText);
    const failing = new ExchangeStore({
      rootDir: path.dirname(requests),
      fs: { ...nodeFs, unlink: () => Promise.reject(errno("EBUSY")) },
    });
    await expect(failing.removeReply(ID)).rejects.toMatchObject({ name: "IoFailure" });
  });

  it("reads a reply file with its exact bytes", async () => {
    const { store } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    expect(await store.readReply(ID, "reply.json")).toBeUndefined();
    await store.placeReply(ID, replyText);
    const read = await store.readReply(ID, "reply.json");
    expect(read?.bytes).toBe(replyText);
    expect(read?.parsed.kind === "ok" && read.parsed.value.body).toBe("Hi");
  });
});

async function modeOf(target: string): Promise<number> {
  return (await stat(target)).mode & 0o777;
}

describe.skipIf(process.platform === "win32")("permissions on Linux and macOS", () => {
  it("creates the storage directory, every missing parent and requests/ with mode 0700", async () => {
    const parent = await makeTempDir();
    const root = path.join(parent, "a", "b", "imbehind");
    await new ExchangeStore({ rootDir: root, platform: "linux" }).prepare();
    expect(await modeOf(path.join(parent, "a"))).toBe(0o700);
    expect(await modeOf(path.join(parent, "a", "b"))).toBe(0o700);
    expect(await modeOf(root)).toBe(0o700);
    expect(await modeOf(path.join(root, "requests"))).toBe(0o700);
  });

  it("does not change the mode of a directory that already exists", async () => {
    const root = await makeTempDir();
    await chmod(root, 0o755);
    await mkdir(path.join(root, "requests"), { mode: 0o750 });
    await chmod(path.join(root, "requests"), 0o750);
    await new ExchangeStore({ rootDir: root, platform: "linux" }).prepare();
    expect(await modeOf(root)).toBe(0o755);
    expect(await modeOf(path.join(root, "requests"))).toBe(0o750);
  });

  it("creates a request directory with 0700 and its files with 0600", async () => {
    const root = await makeTempDir();
    const store = new ExchangeStore({ rootDir: root, platform: "linux" });
    await store.prepare();
    await store.createRequest(sampleRequest(), sampleState());
    const dir = path.join(root, "requests", ID);
    expect(await modeOf(dir)).toBe(0o700);
    expect(await modeOf(path.join(dir, "request.json"))).toBe(0o600);
    expect(await modeOf(path.join(dir, "state.json"))).toBe(0o600);
  });

  it("keeps 0600 on a rewritten state.json and on reply.json and reply.accepted.json", async () => {
    const root = await makeTempDir();
    const store = new ExchangeStore({ rootDir: root, platform: "linux" });
    await store.prepare();
    await store.createRequest(sampleRequest(), sampleState());
    await store.writeState(createStateFile(ID, "replied", NOW, NOW));
    await store.placeReply(ID, serializeFile(createReplyFile("Hi", NOW)));
    await acceptFromDisk(store, ID);
    const dir = path.join(root, "requests", ID);
    for (const name of ["state.json", "reply.json", "reply.accepted.json"]) {
      expect(await modeOf(path.join(dir, name)), name).toBe(0o600);
    }
  });

  it("gives every file it writes the mode 0600, hidden files included", async () => {
    const written: Array<[string, number | undefined]> = [];
    const root = await makeTempDir();
    const store = new ExchangeStore({
      rootDir: root,
      platform: "linux",
      fs: {
        ...nodeFs,
        writeFile: (file, data, mode) => {
          written.push([path.basename(file), mode]);
          return nodeFs.writeFile(file, data, mode);
        },
      },
    });
    await store.prepare();
    await store.createRequest(sampleRequest(), sampleState());
    await store.writeState(createStateFile(ID, "replied", NOW, NOW));
    await store.placeReply(ID, serializeFile(createReplyFile("Hi", NOW)));
    expect(written.length).toBeGreaterThanOrEqual(5);
    for (const [name, mode] of written) {
      expect(mode, name).toBe(0o600);
    }
    expect(written.some(([name]) => name.startsWith("."))).toBe(true);
  });

  it("does not change the mode of a reply.json that the user placed", async () => {
    const root = await makeTempDir();
    const store = new ExchangeStore({ rootDir: root, platform: "linux" });
    await store.prepare();
    await store.createRequest(sampleRequest(), sampleState());
    const reply = path.join(root, "requests", ID, "reply.json");
    await writeFile(reply, serializeFile(createReplyFile("Hand written", NOW)));
    await chmod(reply, 0o644);
    await acceptFromDisk(store, ID);
    expect(await modeOf(reply)).toBe(0o644);
    expect(await store.readReply(ID, "reply.json")).toBeDefined();
    expect(await modeOf(reply)).toBe(0o644);
  });
});

describe("no modes on Windows", () => {
  it("passes no mode to directories or files when the platform is win32", async () => {
    const modes: Array<number | undefined> = [];
    const root = await makeTempDir();
    const store = new ExchangeStore({
      rootDir: path.join(root, "imbehind"),
      platform: "win32",
      fs: {
        ...nodeFs,
        mkdir: (dir, options) => {
          modes.push(options.mode);
          return nodeFs.mkdir(dir, options);
        },
        writeFile: (file, data, mode) => {
          modes.push(mode);
          return nodeFs.writeFile(file, data, mode);
        },
      },
    });
    await store.prepare();
    await store.createRequest(sampleRequest(), sampleState());
    await store.writeState(createStateFile(ID, "replied", NOW, NOW));
    expect(modes.length).toBeGreaterThanOrEqual(5);
    expect(modes.every((mode) => mode === undefined)).toBe(true);
  });
});

describe("files that the server did not make", () => {
  it("does not list, read or remove hidden entries, unknown names and request folders without state.json", async () => {
    const { root, store, requests } = await newStore();
    await writeFile(path.join(root, "notes.txt"), "mine");
    await writeFile(path.join(requests, ".half.tmp"), "x");
    await mkdir(path.join(requests, ".hidden-dir"));
    await writeFile(path.join(requests, "readme.txt"), "mine");
    await mkdir(path.join(requests, "not-an-id"));
    await store.prepare();
    expect(await store.listIds()).toEqual([]);
    expect(await names(requests)).toEqual([".half.tmp", ".hidden-dir", "not-an-id", "readme.txt"]);
    expect(await names(root)).toEqual(["notes.txt", "requests"]);
  });
});

describe("removing a request", () => {
  const FOUR = ["reply.accepted.json", "reply.json", "request.json", "state.json"];

  async function withFourFiles(overrides: Partial<StoreFs> = {}) {
    const t = await newStore(overrides);
    await t.store.createRequest(sampleRequest(), sampleState());
    await t.store.placeReply(ID, serializeFile(createReplyFile("Hi", NOW)));
    await acceptFromDisk(t.store, ID);
    return { ...t, dir: path.join(t.requests, ID) };
  }

  it("removes the four known files and then the folder", async () => {
    const { store, dir, requests } = await withFourFiles();
    expect(await names(dir)).toEqual(FOUR);
    expect(await store.removeRequest(ID)).toBe("removed");
    expect(await names(requests)).toEqual([]);
  });

  it("removes state.json last, so a stop in between leaves a request that can be swept again", async () => {
    const order: string[] = [];
    const { store } = await withFourFiles({
      unlink: (file) => {
        order.push(path.basename(file));
        return nodeFs.unlink(file);
      },
    });
    await store.removeRequest(ID);
    expect(order[order.length - 1]).toBe("state.json");
    expect([...order].sort()).toEqual(FOUR);
  });

  it("removes a leftover own temp file with the four known files, and state.json still goes last", async () => {
    const order: string[] = [];
    const { store, dir, requests } = await withFourFiles({
      unlink: (file) => {
        order.push(path.basename(file));
        return nodeFs.unlink(file);
      },
    });
    await writeFile(path.join(dir, LEFTOVER), "left over");
    expect(await store.removeRequest(ID)).toBe("removed");
    expect(await names(requests)).toEqual([]);
    expect(order).toContain(LEFTOVER);
    expect(order[order.length - 1]).toBe("state.json");
  });

  it("keeps everything when an own temp file is next to a file that is not known", async () => {
    const { store, dir } = await withFourFiles();
    await writeFile(path.join(dir, LEFTOVER), "left over");
    await writeFile(path.join(dir, "notes.txt"), "mine");
    expect(await store.removeRequest(ID)).toBe("kept");
    expect(await names(dir)).toEqual([...FOUR, LEFTOVER, "notes.txt"].sort());
  });

  it("removes a leftover temp file of each kind the store writes: state, reply and reply.accepted", async () => {
    for (const kind of ["state", "reply", "reply.accepted"]) {
      const { store, dir, requests } = await withFourFiles();
      await writeFile(path.join(dir, `.${kind}.31337.12.0a1b2c3d.tmp`), "left over");
      expect(await store.removeRequest(ID)).toBe("removed");
      expect(await names(requests)).toEqual([]);
    }
  });

  it("keeps everything when a dot file is not exactly of the temporary form", async () => {
    const strangers = [
      ".reply.accepted.tmp",
      ".reply.accepted.123.4.tmp",
      ".reply.accepted.x.4.0a1b2c3d.tmp",
      ".reply.accepted.123.y.0a1b2c3d.tmp",
      ".reply.accepted.123.4.0A1B2C3D.tmp",
      ".reply.accepted.123.4.xyz.tmp",
      ".reply.accepted.123.4.0a1b2c3d.tmp.bak",
      "x.reply.accepted.123.4.0a1b2c3d.tmp",
      "..reply.accepted.123.4.0a1b2c3d.tmp",
      ".link-check.123.4.0a1b2c3d.tmp",
      ".serve-lock.123.4.0a1b2c3d.tmp",
      ".other.123.4.0a1b2c3d.tmp",
    ];
    for (const stranger of strangers) {
      const { store, dir } = await withFourFiles();
      await writeFile(path.join(dir, stranger), "mine");
      expect(await store.removeRequest(ID)).toBe("kept");
      expect(await names(dir)).toEqual([...FOUR, stranger].sort());
    }
  });

  it("keeps everything when the folder holds any other file", async () => {
    for (const stranger of ["notes.txt", ".half.tmp", "reply.json.bak"]) {
      const { store, dir } = await withFourFiles();
      await writeFile(path.join(dir, stranger), "mine");
      expect(await store.removeRequest(ID)).toBe("kept");
      expect(await names(dir)).toEqual([...FOUR, stranger].sort());
    }
  });

  describe.skipIf(process.platform === "win32")("entries that are not regular files", () => {
    const LINK_TARGET_NAME = "target.txt";

    async function replaceWith(
      dir: string,
      name: string,
      make: (full: string, outside: string) => Promise<void>,
    ): Promise<string> {
      const outside = path.join(await makeTempDir(), LINK_TARGET_NAME);
      await writeFile(outside, "mine");
      await rm(path.join(dir, name), { force: true });
      await make(path.join(dir, name), outside);
      return outside;
    }

    const TEMP_FORM = ".state.31337.1.0a1b2c3d.tmp";
    const NAMES = ["reply.json", "request.json", TEMP_FORM];

    for (const name of NAMES) {
      it(`keeps everything when ${name} is a directory`, async () => {
        const { store, dir } = await withFourFiles();
        await replaceWith(dir, name, (full) => mkdir(full));
        const before = await names(dir);
        expect(await store.removeRequest(ID)).toBe("kept");
        expect(await names(dir)).toEqual(before);
        expect(await names(dir)).toContain("state.json");
      });

      it(`keeps everything, and does not follow it, when ${name} is a symbolic link`, async () => {
        const { store, dir } = await withFourFiles();
        const outside = await replaceWith(dir, name, (full, target) => symlink(target, full));
        const before = await names(dir);
        expect(await store.removeRequest(ID)).toBe("kept");
        expect(await names(dir)).toEqual(before);
        expect(await readFile(outside, "utf8")).toBe("mine");
      });
    }

    it("keeps everything when a symbolic link has no target", async () => {
      const { store, dir } = await withFourFiles();
      await symlink(path.join(dir, "nowhere"), path.join(dir, ".state.31337.1.0a1b2c3d.tmp"));
      expect(await store.removeRequest(ID)).toBe("kept");
      expect(await names(dir)).toEqual([...FOUR, ".state.31337.1.0a1b2c3d.tmp"].sort());
    });
  });

  it("keeps state.json when another file shows up while the others are being removed", async () => {
    let listings = 0;
    const { store, dir } = await withFourFiles({
      readdir: async (target) => {
        const found = await nodeFs.readdir(target);
        listings += 1;
        return listings === 2 && target.endsWith(ID) ? [...found, "late.txt"] : found;
      },
    });
    expect(await store.removeRequest(ID)).toBe("kept");
    expect(await names(dir)).toContain("state.json");
  });

  it("fails with an IoFailure of the reason delete failed when a file cannot be removed", async () => {
    const { store, dir } = await withFourFiles({
      unlink: () => Promise.reject(errno("EBUSY")),
    });
    const failure = store.removeRequest(ID);
    await expect(failure).rejects.toBeInstanceOf(IoFailure);
    await expect(failure).rejects.toMatchObject({
      reason: "delete failed",
      detail: "resource busy or locked",
    });
    expect(await names(dir)).toEqual(FOUR);
  });

  it("fails with delete failed when the folder cannot be removed", async () => {
    const { store } = await withFourFiles({ rmdir: () => Promise.reject(errno("EPERM")) });
    await expect(store.removeRequest(ID)).rejects.toMatchObject({ reason: "delete failed" });
  });

  it("treats a folder that is already gone as removed", async () => {
    const { store } = await newStore();
    expect(await store.removeRequest(ID)).toBe("removed");
  });
});

describe("removing a request that has saved parts", () => {
  async function withParts(overrides: Partial<StoreFs> = {}, files = [PART_A, PART_B]) {
    const t = await newStore(overrides);
    const { request, parts } = requestWithParts(files);
    await t.store.createRequest(request, sampleState(), parts);
    return { ...t, dir: path.join(t.requests, ID) };
  }

  it("removes the saved parts, then request.json, then state.json, then the folder", async () => {
    const order: string[] = [];
    const { store, requests } = await withParts({
      unlink: (file) => {
        order.push(path.basename(file));
        return nodeFs.unlink(file);
      },
    });
    expect(await store.removeRequest(ID)).toBe("removed");
    expect(order).toEqual([PART_A, PART_B, "request.json", "state.json"]);
    expect(await names(requests)).toEqual([]);
  });

  it("removes the saved parts before the reply files and hidden leftovers", async () => {
    const order: string[] = [];
    const { store, dir } = await withParts({
      unlink: (file) => {
        order.push(path.basename(file));
        return nodeFs.unlink(file);
      },
    });
    await writeFile(path.join(dir, "reply.json"), "{}");
    await writeFile(path.join(dir, LEFTOVER), "x");
    expect(await store.removeRequest(ID)).toBe("removed");
    expect(order.slice(0, 2)).toEqual([PART_A, PART_B]);
    expect(order.slice(-2)).toEqual(["request.json", "state.json"]);
  });

  it("is not troubled by a recorded part that is already gone", async () => {
    const { store, dir, requests } = await withParts();
    await rm(path.join(dir, PART_B));
    expect(await store.removeRequest(ID)).toBe("removed");
    expect(await names(requests)).toEqual([]);
  });

  it("keeps everything when the folder holds a file that is not recorded, even with a name of the same form", async () => {
    for (const stranger of ["message-9-part-9.png", "message-1-part-1.png.bak", "notes.txt"]) {
      const { store, dir } = await withParts();
      await writeFile(path.join(dir, stranger), "mine");
      expect(await store.removeRequest(ID)).toBe("kept");
      expect(await names(dir)).toEqual(
        [PART_A, PART_B, "request.json", stranger, "state.json"].sort(),
      );
    }
  });

  it("never removes a name that is recorded but does not have the form of a saved name", async () => {
    const { store, dir } = await withParts({}, [PART_A]);
    const text = await readFile(path.join(dir, "request.json"), "utf8");
    await writeFile(path.join(dir, "request.json"), text.replaceAll(PART_A, "notes.txt"));
    await writeFile(path.join(dir, "notes.txt"), "mine");
    expect(await store.removeRequest(ID)).toBe("kept");
    expect(await readFile(path.join(dir, "notes.txt"), "utf8")).toBe("mine");
  });

  describe.skipIf(process.platform === "win32")(
    "a recorded name that is not a regular file",
    () => {
      it("keeps everything when it is a directory", async () => {
        const { store, dir } = await withParts({}, [PART_A]);
        await rm(path.join(dir, PART_A));
        await mkdir(path.join(dir, PART_A));
        expect(await store.removeRequest(ID)).toBe("kept");
        expect(await names(dir)).toEqual([PART_A, "request.json", "state.json"]);
      });

      it("keeps everything and does not follow it when it is a symbolic link", async () => {
        const { store, dir } = await withParts({}, [PART_A]);
        const outside = path.join(await makeTempDir(), "outside.txt");
        await writeFile(outside, "mine");
        await rm(path.join(dir, PART_A));
        await symlink(outside, path.join(dir, PART_A));
        expect(await store.removeRequest(ID)).toBe("kept");
        expect(await readFile(outside, "utf8")).toBe("mine");
        expect(await names(dir)).toEqual([PART_A, "request.json", "state.json"]);
      });
    },
  );

  it("keeps the folder when request.json cannot be read and a file has the form of a saved name", async () => {
    const { store, dir } = await withParts();
    await writeFile(path.join(dir, "request.json"), "{not json");
    expect(await store.removeRequest(ID)).toBe("kept");
    expect(await names(dir)).toEqual([PART_A, PART_B, "request.json", "state.json"]);
  });

  it("keeps the folder when request.json is missing and a file has the form of a saved name", async () => {
    const { store, dir } = await withParts();
    await rm(path.join(dir, "request.json"));
    expect(await store.removeRequest(ID)).toBe("kept");
    expect(await names(dir)).toEqual([PART_A, PART_B, "state.json"]);
  });

  it("keeps the folder when request.json has attachments that break the rules", async () => {
    const { store, dir } = await withParts({}, [PART_A]);
    const text = await readFile(path.join(dir, "request.json"), "utf8");
    await writeFile(path.join(dir, "request.json"), text.replace('"at": 0', '"at": 5'));
    expect(await store.removeRequest(ID)).toBe("kept");
    expect(await names(dir)).toEqual([PART_A, "request.json", "state.json"]);
  });

  it("still removes by name alone a request without saved parts whose request.json cannot be read", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    await writeFile(path.join(requests, ID, "request.json"), "{not json");
    expect(await store.removeRequest(ID)).toBe("removed");
    expect(await names(requests)).toEqual([]);
  });

  it("treats a request.json that cannot be read from the disk as unreadable, not as an error", async () => {
    const { store, requests } = await newStore({ readFile: () => Promise.reject(errno("EIO")) });
    await store.createRequest(sampleRequest(), sampleState());
    expect(await store.removeRequest(ID)).toBe("removed");
    expect(await names(requests)).toEqual([]);
  });

  it("removes a request of an older version, which records no parts", async () => {
    const { store, dir, requests } = await newStore().then(async (t) => {
      await t.store.createRequest(sampleRequest(), sampleState());
      return { ...t, dir: path.join(t.requests, ID) };
    });
    const old = JSON.parse(await readFile(path.join(dir, "request.json"), "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(path.join(dir, "request.json"), JSON.stringify({ ...old, formatVersion: 2 }));
    expect(await store.removeRequest(ID)).toBe("removed");
    expect(await names(requests)).toEqual([]);
  });

  it("leaves the folder, with request.json, when a saved part cannot be removed", async () => {
    const { store, dir } = await withParts({
      unlink: (file) =>
        file.endsWith(PART_B) ? Promise.reject(errno("EBUSY")) : nodeFs.unlink(file),
    });
    await expect(store.removeRequest(ID)).rejects.toMatchObject({
      reason: "delete failed",
      detail: "resource busy or locked",
    });
    expect(await names(dir)).toEqual([PART_B, "request.json", "state.json"]);
  });

  it("treats a request.json over the size limit as unreadable, without reading it", async () => {
    let reads = 0;
    const { store, dir } = await withParts({
      readFile: (file) => {
        reads += 1;
        return nodeFs.readFile(file);
      },
      readBytes: (file, limit) => {
        reads += 1;
        return nodeFs.readBytes(file, limit);
      },
    });
    const text = await readFile(path.join(dir, "request.json"), "utf8");
    await writeFile(path.join(dir, "request.json"), text + " ".repeat(MAX_FILE_BYTES));
    reads = 0;
    expect(await store.removeRequest(ID)).toBe("kept");
    expect(reads).toBe(0);
    expect(await names(dir)).toEqual([PART_A, PART_B, "request.json", "state.json"]);
  });

  it("still reads a request.json of exactly the size limit", async () => {
    const { store, dir, requests } = await withParts();
    const text = await readFile(path.join(dir, "request.json"), "utf8");
    const padded = text + " ".repeat(MAX_FILE_BYTES - Buffer.byteLength(text));
    await writeFile(path.join(dir, "request.json"), padded);
    expect(await store.removeRequest(ID)).toBe("removed");
    expect(await names(requests)).toEqual([]);
  });

  it("can remove the request in a later try after a failure", async () => {
    let broken = true;
    const { store, requests } = await withParts({
      unlink: (file) =>
        broken && file.endsWith(PART_B) ? Promise.reject(errno("EBUSY")) : nodeFs.unlink(file),
    });
    await expect(store.removeRequest(ID)).rejects.toBeInstanceOf(IoFailure);
    broken = false;
    expect(await store.removeRequest(ID)).toBe("removed");
    expect(await names(requests)).toEqual([]);
  });
});

/** What a stopped accept leaves: a hidden copy in the temporary form. */
const LEFTOVER = ".reply.accepted.31337.12.0a1b2c3d.tmp";

/** Stands for the name of the hidden copy that an accept made, wherever one is compared. */
const ACCEPT_TMP = "<accept-tmp>";

/** Whether a name is one of an accept's hidden copies, as the writer builds it. */
function isAcceptTemp(name: string): boolean {
  return /^\.reply\.accepted\.\d+\.\d+\.[0-9a-f]+\.tmp$/.test(name);
}

/** The names with every hidden copy of an accept written as ACCEPT_TMP, sorted. */
function normalized(list: readonly string[]): string[] {
  return list.map((name) => (isAcceptTemp(name) ? ACCEPT_TMP : name)).sort();
}

describe("accepting a reply through a hidden copy", () => {
  const replyText = serializeFile(createReplyFile("Hi", NOW));

  /** A store on Linux rules whose request already holds the reply.json of the user. */
  async function withUserReply(overrides: Partial<StoreFs> = {}) {
    const root = await makeTempDir();
    const store = new ExchangeStore({
      rootDir: root,
      platform: "linux",
      fs: { ...nodeFs, ...overrides },
    });
    await store.prepare();
    await store.createRequest(sampleRequest(), sampleState());
    const dir = path.join(root, "requests", ID);
    await writeFile(path.join(dir, "reply.json"), replyText);
    return { root, store, dir };
  }

  describe.skipIf(process.platform === "win32")("modes", () => {
    it("makes reply.accepted.json 0600 from a reply.json of mode 0644, and leaves reply.json alone", async () => {
      const { store, dir } = await withUserReply();
      await chmod(path.join(dir, "reply.json"), 0o644);
      await acceptFromDisk(store, ID);
      expect(await modeOf(path.join(dir, "reply.accepted.json"))).toBe(0o600);
      expect(await modeOf(path.join(dir, "reply.json"))).toBe(0o644);
      expect(await readFile(path.join(dir, "reply.json"), "utf8")).toBe(replyText);
      expect(await readFile(path.join(dir, "reply.accepted.json"), "utf8")).toBe(replyText);
    });

    it("does not link reply.json itself: the two files are different files", async () => {
      const { store, dir } = await withUserReply();
      await acceptFromDisk(store, ID);
      const accepted = await stat(path.join(dir, "reply.accepted.json"));
      const original = await stat(path.join(dir, "reply.json"));
      expect(accepted.ino).not.toBe(original.ino);
      expect(accepted.nlink).toBe(1);
    });

    it("makes the hidden copy 0600 and leaves a leftover of another accept with a wider mode alone", async () => {
      const { store, dir } = await withUserReply();
      await writeFile(path.join(dir, LEFTOVER), "other");
      await chmod(path.join(dir, LEFTOVER), 0o666);
      await acceptFromDisk(store, ID);
      expect(await modeOf(path.join(dir, "reply.accepted.json"))).toBe(0o600);
      expect(await modeOf(path.join(dir, LEFTOVER))).toBe(0o666);
    });
  });

  it("writes the hidden copy, links it, removes it, in that order, and reads nothing", async () => {
    const steps: string[] = [];
    const { store, dir } = await withUserReply({
      readFile: (file) => {
        steps.push(`read ${path.basename(file)}`);
        return nodeFs.readFile(file);
      },
      writeFile: (file, data, mode) => {
        steps.push(`write ${path.basename(file)} ${mode?.toString(8)}`);
        return nodeFs.writeFile(file, data, mode);
      },
      link: (existing, target) => {
        steps.push(`link ${path.basename(existing)} ${path.basename(target)}`);
        return nodeFs.link(existing, target);
      },
      rm: (target, options) => {
        steps.push(`rm ${path.basename(target)}`);
        return nodeFs.rm(target, options);
      },
      unlink: (file) => {
        steps.push(`unlink ${path.basename(file)}`);
        return nodeFs.unlink(file);
      },
    });
    steps.length = 0;
    await acceptFromDisk(store, ID);
    await store.removeReply(ID);
    expect(steps.map((step) => step.replace(/\.reply\.accepted\.[^ ]+\.tmp/g, ACCEPT_TMP))).toEqual(
      [
        `write ${ACCEPT_TMP} 600`,
        `link ${ACCEPT_TMP} reply.accepted.json`,
        `rm ${ACCEPT_TMP}`,
        "unlink reply.json",
      ],
    );
    const named = steps
      .filter((step) => step.includes(".reply.accepted."))
      .map((step) => step.split(" "));
    expect(new Set(named.flatMap((parts) => parts.filter(isAcceptTemp))).size).toBe(1);
    expect(await names(dir)).toEqual(["reply.accepted.json", "request.json", "state.json"]);
  });

  it("does not remove or touch a hidden copy it did not make, whatever the outcome", async () => {
    const removed: string[] = [];
    const watch: Partial<StoreFs> = {
      rm: (target, options) => {
        removed.push(path.basename(target));
        return nodeFs.rm(target, options);
      },
      unlink: (file) => {
        removed.push(path.basename(file));
        return nodeFs.unlink(file);
      },
    };
    const { store, dir } = await withUserReply(watch);
    await writeFile(path.join(dir, LEFTOVER), "left by a stopped serve");
    await acceptFromDisk(store, ID);
    await expect(acceptFromDisk(store, ID)).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(await readFile(path.join(dir, "reply.accepted.json"), "utf8")).toBe(replyText);
    expect(await readFile(path.join(dir, LEFTOVER), "utf8")).toBe("left by a stopped serve");
    expect(removed.filter((name) => name === LEFTOVER)).toEqual([]);
    // One removal for each accept, and each is the accept's own copy.
    expect(removed.filter(isAcceptTemp)).toHaveLength(2);
    expect(await names(dir)).toEqual(
      [LEFTOVER, "reply.accepted.json", "reply.json", "request.json", "state.json"].sort(),
    );
  });

  it("uses a new name for every accept, of the form .reply.accepted.<pid>.<seq>.<hex>.tmp", async () => {
    const written: string[] = [];
    const { store } = await withUserReply({
      writeFile: (file, data, mode) => {
        written.push(path.basename(file));
        return nodeFs.writeFile(file, data, mode);
      },
    });
    written.length = 0;
    await acceptFromDisk(store, ID);
    for (let i = 0; i < 4; i += 1) {
      await expect(acceptFromDisk(store, ID)).rejects.toBeInstanceOf(AlreadyExistsError);
    }
    expect(written).toHaveLength(5);
    expect(written.every(isAcceptTemp)).toBe(true);
    expect(new Set(written).size).toBe(5);
    expect(written[0]).toMatch(
      new RegExp(`^\\.reply\\.accepted\\.${process.pid}\\.\\d+\\.[0-9a-f]{8}\\.tmp$`),
    );
  });

  it("gives two accepts different names even with the same random part, because of the counter", async () => {
    const written: string[] = [];
    const root = await makeTempDir();
    const store = new ExchangeStore({
      rootDir: root,
      randomHex: () => "aaaaaaaa",
      fs: {
        ...nodeFs,
        writeFile: (file, data, mode) => {
          written.push(path.basename(file));
          return nodeFs.writeFile(file, data, mode);
        },
      },
    });
    await store.prepare();
    await store.createRequest(sampleRequest(), sampleState());
    await writeFile(path.join(root, "requests", ID, "reply.json"), replyText);
    written.length = 0;
    await acceptFromDisk(store, ID);
    await expect(acceptFromDisk(store, ID)).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(written).toHaveLength(2);
    expect(written[0]).not.toBe(written[1]);
  });

  it("accepts every name the writer can produce as a name that a delete may remove", async () => {
    const written: string[] = [];
    const { store, dir } = await withUserReply({
      writeFile: (file, data, mode) => {
        written.push(path.basename(file));
        return nodeFs.writeFile(file, data, mode);
      },
    });
    written.length = 0;
    await store.writeState(sampleState());
    await store.placeReply(ID, replyText).catch(() => undefined);
    await acceptFromDisk(store, ID);
    expect(written.length).toBeGreaterThanOrEqual(3);
    for (const name of written) {
      expect(isOwnTempName(name)).toBe(true);
    }
    // And a folder that holds such a name next to the known files is deleted.
    for (const name of written) {
      await writeFile(path.join(dir, name), "left over");
    }
    await writeFile(path.join(dir, "reply.accepted.json"), replyText);
    expect(await store.removeRequest(ID)).toBe("removed");
  });

  it("lets two accepts of one request run together: reply.accepted.json is never empty or partial", async () => {
    const root = await makeTempDir();
    const text = serializeFile(createReplyFile("x".repeat(20000), NOW));
    const observed: string[] = [];
    const inFlight = { stop: false };
    // Both accepts write in pieces. The second one starts writing only after the first one has
    // written two pieces, so a file that both write to would be cut off under the first one.
    const progress = { pieces: 0 };
    const slowFs = (isSecond: boolean): StoreFs => ({
      ...nodeFs,
      writeFile: async (file, data, mode) => {
        for (let turns = 0; isSecond && progress.pieces < 2 && turns < 1000; turns += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        const handle = await open(file, "w", mode);
        try {
          for (let at = 0; at < data.length; at += 5000) {
            await handle.write(data.slice(at, at + 5000));
            progress.pieces += isSecond ? 0 : 1;
            await new Promise((resolve) => setImmediate(resolve));
          }
        } finally {
          await handle.close();
        }
      },
    });
    const first = new ExchangeStore({ rootDir: root, fs: slowFs(false) });
    const second = new ExchangeStore({ rootDir: root, fs: slowFs(true) });
    await first.prepare();
    const observer = (async () => {
      while (!inFlight.stop) {
        for (const id of [ID, OTHER_ID]) {
          try {
            observed.push(
              await readFile(path.join(root, "requests", id, "reply.accepted.json"), "utf8"),
            );
          } catch {
            // Not there yet.
          }
        }
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    for (const id of [ID, OTHER_ID]) {
      await first.createRequest(sampleRequest(id), sampleState(id));
      await writeFile(path.join(root, "requests", id, "reply.json"), text);
      progress.pieces = 0;
      const results = await Promise.allSettled([
        acceptFromDisk(first, id),
        acceptFromDisk(second, id),
      ]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(
        results.filter((r) => r.status === "rejected" && r.reason instanceof AlreadyExistsError),
      ).toHaveLength(1);
      expect(await readFile(path.join(root, "requests", id, "reply.accepted.json"), "utf8")).toBe(
        text,
      );
      expect(
        (await names(path.join(root, "requests", id))).filter((n) => n.startsWith(".")),
      ).toEqual([]);
    }
    inFlight.stop = true;
    await observer;
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((seen) => seen === text)).toBe(true);
  });

  it("removes the hidden copy when reply.accepted.json already exists, and keeps the old one", async () => {
    const { store, dir } = await withUserReply();
    await writeFile(path.join(dir, "reply.accepted.json"), "first");
    await expect(acceptFromDisk(store, ID)).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(await names(dir)).toEqual([
      "reply.accepted.json",
      "reply.json",
      "request.json",
      "state.json",
    ]);
    expect(await readFile(path.join(dir, "reply.accepted.json"), "utf8")).toBe("first");
  });

  it("removes the hidden copy when the link fails for another reason, and changes nothing else", async () => {
    const { store, dir } = await withUserReply({
      link: (existing, target) =>
        path.basename(target) === "reply.accepted.json"
          ? Promise.reject(errno("EPERM"))
          : nodeFs.link(existing, target),
    });
    const failure = acceptFromDisk(store, ID);
    await expect(failure).rejects.toBeInstanceOf(IoFailure);
    await expect(failure).rejects.toMatchObject({ reason: "link failed" });
    expect(await names(dir)).toEqual(["reply.json", "request.json", "state.json"]);
    expect(await readFile(path.join(dir, "reply.json"), "utf8")).toBe(replyText);
  });

  it("removes the hidden copy when writing it fails, and reports write failed", async () => {
    const { store, dir } = await withUserReply({
      writeFile: async (file, data, mode) => {
        if (isAcceptTemp(path.basename(file))) {
          await nodeFs.writeFile(file, data.slice(0, 3), mode);
          throw errno("ENOSPC");
        }
        return nodeFs.writeFile(file, data, mode);
      },
    });
    await expect(acceptFromDisk(store, ID)).rejects.toMatchObject({ reason: "write failed" });
    expect(await names(dir)).toEqual(["reply.json", "request.json", "state.json"]);
  });
});

describe("a stop between the steps of accepting a reply", () => {
  const replyText = serializeFile(createReplyFile("Hi", NOW));

  /** A store whose operations fail the way a stop between two steps leaves the files. */
  /**
   * Operations that leave the hidden copy in place once the link was tried, as a stop right after
   * the link would. `link` replaces the link itself when given.
   */
  function keepsHiddenCopyAfterLink(link?: () => Promise<void>): Partial<StoreFs> {
    let linkTried = false;
    return {
      link: (existing, target) => {
        linkTried = true;
        return link ? link() : nodeFs.link(existing, target);
      },
      rm: (target, options) =>
        linkTried && isAcceptTemp(path.basename(target))
          ? Promise.reject(errno("EIO"))
          : nodeFs.rm(target, options),
    };
  }

  const stops: Array<[string, () => Partial<StoreFs>, string[]]> = [
    [
      "after the hidden copy was written, before the link",
      () => keepsHiddenCopyAfterLink(() => Promise.reject(errno("EIO"))),
      ["reply.json", "request.json", "state.json", ACCEPT_TMP],
    ],
    [
      "after the link, before the hidden copy was removed",
      () => ({
        ...keepsHiddenCopyAfterLink(),
        unlink: () => Promise.reject(errno("EIO")),
      }),
      ["reply.accepted.json", "reply.json", "request.json", "state.json", ACCEPT_TMP],
    ],
    [
      "after the hidden copy was removed, before reply.json was removed",
      () => ({ unlink: () => Promise.reject(errno("EIO")) }),
      ["reply.accepted.json", "reply.json", "request.json", "state.json"],
    ],
    [
      "after reply.json was removed, before state.json was written",
      () => ({ rename: () => Promise.reject(errno("EIO")) }),
      ["reply.accepted.json", "request.json", "state.json"],
    ],
  ];

  for (const [when, failing, expected] of stops) {
    it(`finishes the request on the next poll of a new serve: ${when}`, async () => {
      const root = await makeTempDir();
      const dir = path.join(root, "requests", ID);
      const first = new ExchangeStore({ rootDir: root, fs: { ...nodeFs } });
      await first.prepare();
      await first.createRequest(sampleRequest(), sampleState());
      await writeFile(path.join(dir, "reply.json"), replyText);

      // The first serve is stopped by failures of the file operations after the one that counts.
      const crashing = new ExchangeStore({ rootDir: root, fs: { ...nodeFs, ...failing() } });
      const crashed = new ExchangeBroker({
        store: crashing,
        clock: new FakeClock(),
        pollIntervalMs: 500,
      });
      await crashed.pollOnce();
      expect(normalized(await names(dir))).toEqual(normalized(expected));
      const waiting = await first.readState(ID);
      expect(waiting.kind === "ok" && waiting.value.state).toBe("waiting");

      const next = new ExchangeBroker({
        store: new ExchangeStore({ rootDir: root }),
        clock: new FakeClock(),
        pollIntervalMs: 500,
      });
      await next.pollOnce();
      const state = await first.readState(ID);
      expect(state.kind === "ok" && state.value.state).toBe("replied");
      expect(await readFile(path.join(dir, "reply.accepted.json"), "utf8")).toBe(replyText);
      expect(await names(dir)).not.toContain("reply.json");
    });
  }

  it("tries again on the next poll when the link fails for a reason other than 'exists'", async () => {
    const root = await makeTempDir();
    let failures = 1;
    const store = new ExchangeStore({
      rootDir: root,
      fs: {
        ...nodeFs,
        link: (existing, target) => {
          if (path.basename(target) === "reply.accepted.json" && failures-- > 0) {
            return Promise.reject(errno("EIO"));
          }
          return nodeFs.link(existing, target);
        },
      },
    });
    await store.prepare();
    await store.createRequest(sampleRequest(), sampleState());
    const dir = path.join(root, "requests", ID);
    await writeFile(path.join(dir, "reply.json"), replyText);
    const broker = new ExchangeBroker({ store, clock: new FakeClock(), pollIntervalMs: 500 });
    await broker.pollOnce();
    expect((await store.readState(ID)).kind === "ok").toBe(true);
    const waiting = await store.readState(ID);
    expect(waiting.kind === "ok" && waiting.value.state).toBe("waiting");
    expect(await names(dir)).toEqual(["reply.json", "request.json", "state.json"]);
    await broker.pollOnce();
    const replied = await store.readState(ID);
    expect(replied.kind === "ok" && replied.value.state).toBe("replied");
  });
});

describe("reading reply.json for the check", () => {
  const limit = MAX_FILE_BYTES;

  async function withReplyFile(
    content: string | Uint8Array | undefined,
    overrides: Partial<StoreFs> = {},
  ) {
    const made = await newStore(overrides);
    await made.store.createRequest(sampleRequest(), sampleState());
    const file = path.join(made.requests, ID, "reply.json");
    if (content !== undefined) {
      await writeFile(file, content);
    }
    return { ...made, file };
  }

  it("gives nothing when there is no reply.json", async () => {
    const { store } = await withReplyFile(undefined);
    expect(await store.readReplyFile(ID)).toBeUndefined();
  });

  it("gives nothing when the request folder is gone", async () => {
    const { store } = await newStore();
    expect(await store.readReplyFile(ID)).toBeUndefined();
  });

  it("gives the bytes exactly as they are, bytes that are not UTF-8 included", async () => {
    const raw = Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d]);
    const { store } = await withReplyFile(raw);
    const read = await store.readReplyFile(ID);
    expect(read?.kind).toBe("bytes");
    expect(read?.kind === "bytes" && Array.from(read.bytes)).toEqual(Array.from(raw));
  });

  it("reads a file of exactly the limit and calls one byte more too large", async () => {
    const exact = await withReplyFile(Buffer.alloc(limit, 0x61));
    const read = await exact.store.readReplyFile(ID);
    expect(read?.kind === "bytes" && read.bytes.length).toBe(limit);
    const over = await withReplyFile(Buffer.alloc(limit + 1, 0x61));
    expect(await over.store.readReplyFile(ID)).toEqual({ kind: "too-large" });
  });

  it("decides from the size alone and does not open a file that is too large", async () => {
    const reads: number[] = [];
    const { store } = await withReplyFile(Buffer.alloc(limit + 1, 0x61), {
      readBytes: (file, max) => {
        reads.push(max);
        return nodeFs.readBytes(file, max);
      },
    });
    expect(await store.readReplyFile(ID)).toEqual({ kind: "too-large" });
    expect(reads).toEqual([]);
  });

  it("never reads past one byte more than the limit when the file grew after the size check", async () => {
    const reads: number[] = [];
    const lengths: number[] = [];
    const { store } = await withReplyFile(Buffer.alloc(limit + 4096, 0x61), {
      statFile: async () => ({ size: 10, isFile: true }),
      readBytes: async (file, max) => {
        reads.push(max);
        const bytes = await nodeFs.readBytes(file, max);
        lengths.push(bytes.length);
        return bytes;
      },
    });
    expect(await store.readReplyFile(ID)).toEqual({ kind: "too-large" });
    expect(reads).toEqual([limit + 1]);
    expect(lengths).toEqual([limit + 1]);
  });

  it("reads a bounded number of bytes with the real file operation", async () => {
    const { file } = await withReplyFile(Buffer.alloc(5000, 0x62));
    expect((await nodeFs.readBytes(file, 1234)).length).toBe(1234);
    expect((await nodeFs.readBytes(file, 9999)).length).toBe(5000);
    expect(await nodeFs.statFile(file)).toEqual({ size: 5000, isFile: true });
  });

  it("calls a directory named reply.json unreadable, not a wrong reply", async () => {
    const { store, requests } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    await mkdir(path.join(requests, ID, "reply.json"));
    await expect(store.readReplyFile(ID)).rejects.toMatchObject({
      name: "IoFailure",
      reason: "unreadable",
    });
  });

  it("calls a failed size check and a failed read unreadable", async () => {
    const noStat = await withReplyFile("{}", { statFile: () => Promise.reject(errno("EACCES")) });
    await expect(noStat.store.readReplyFile(ID)).rejects.toMatchObject({ reason: "unreadable" });
    const noRead = await withReplyFile("{}", { readBytes: () => Promise.reject(errno("EIO")) });
    await expect(noRead.store.readReplyFile(ID)).rejects.toMatchObject({ reason: "unreadable" });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "calls a file without read permission unreadable",
    async () => {
      const { store, file } = await withReplyFile("{}");
      await chmod(file, 0o000);
      await expect(store.readReplyFile(ID)).rejects.toMatchObject({ reason: "unreadable" });
      await chmod(file, 0o600);
      expect((await store.readReplyFile(ID))?.kind).toBe("bytes");
    },
  );

  it("treats a file that is gone after the size check as no reply", async () => {
    const { store } = await withReplyFile("{}", {
      readBytes: () => Promise.reject(errno("ENOENT")),
    });
    expect(await store.readReplyFile(ID)).toBeUndefined();
  });

  it("treats a file that is gone at the size check as no reply", async () => {
    const { store } = await withReplyFile("{}", {
      statFile: () => Promise.reject(errno("ENOENT")),
    });
    expect(await store.readReplyFile(ID)).toBeUndefined();
  });
});

describe("accepting the verified bytes", () => {
  async function withReply(content: string | Uint8Array) {
    const made = await newStore();
    await made.store.createRequest(sampleRequest(), sampleState());
    await writeFile(path.join(made.requests, ID, "reply.json"), content);
    return made;
  }

  it("writes the given bytes to reply.accepted.json and does not read reply.json again", async () => {
    const reads: string[] = [];
    const root = await makeTempDir();
    const store = new ExchangeStore({
      rootDir: root,
      fs: {
        ...nodeFs,
        readFile: (file) => {
          reads.push(path.basename(file));
          return nodeFs.readFile(file);
        },
        readBytes: (file, max) => {
          reads.push(path.basename(file));
          return nodeFs.readBytes(file, max);
        },
      },
    });
    await store.prepare();
    await store.createRequest(sampleRequest(), sampleState());
    const dir = path.join(root, "requests", ID);
    const verified = serializeFile(createReplyFile("verified", NOW));
    await writeFile(path.join(dir, "reply.json"), serializeFile(createReplyFile("rewritten", NOW)));
    reads.length = 0;
    await store.acceptReply(ID, Buffer.from(verified, "utf8"));
    expect(reads).toEqual([]);
    expect(await readFile(path.join(dir, "reply.accepted.json"), "utf8")).toBe(verified);
    expect((await store.readReply(ID, "reply.json"))?.parsed).toMatchObject({
      kind: "ok",
      value: { body: "rewritten" },
    });
  });

  it("writes a leading byte order mark as it is and still reads the accepted file", async () => {
    const { store, requests } = await withReply("{}");
    const withBom = Buffer.from(`﻿${serializeFile(createReplyFile("Hi", NOW))}`, "utf8");
    await store.acceptReply(ID, withBom);
    const onDisk = await readFile(path.join(requests, ID, "reply.accepted.json"));
    expect(Array.from(onDisk)).toEqual(Array.from(withBom));
    const read = await store.readReply(ID, "reply.accepted.json");
    expect(read?.parsed.kind === "ok" && read.parsed.value.body).toBe("Hi");
  });

  it("still never replaces an existing reply.accepted.json", async () => {
    const { store, requests } = await withReply("{}");
    await store.acceptReply(ID, Buffer.from("first", "utf8"));
    await expect(store.acceptReply(ID, Buffer.from("second", "utf8"))).rejects.toBeInstanceOf(
      AlreadyExistsError,
    );
    expect(await readFile(path.join(requests, ID, "reply.accepted.json"), "utf8")).toBe("first");
  });
});

describe("request folders that are not real directories", () => {
  it.skipIf(process.platform === "win32")(
    "does not list a symbolic link that is named like a request id",
    async () => {
      const { store, requests } = await newStore();
      await store.createRequest(sampleRequest(), sampleState());
      const elsewhere = await makeTempDir();
      await writeFile(path.join(elsewhere, "state.json"), "{}");
      await symlink(elsewhere, path.join(requests, OTHER_ID));
      expect(await store.listIds()).toEqual([ID]);
      expect(await store.maxId()).toBe(ID);
    },
  );
});
