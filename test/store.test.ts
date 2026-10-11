import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AlreadyExistsError, IoFailure, StartupError } from "../src/errors.js";
import {
  type ConversationRequest,
  createReplyFile,
  createRequestFile,
  createStateFile,
  serializeFile,
} from "../src/model.js";
import { ExchangeStore, nodeFs, type StoreFs } from "../src/store/exchange-store.js";
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
      formatVersion: 1,
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
    await store.acceptReply(ID);
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
    await store.acceptReply(ID);
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
    await store.acceptReply(ID);
    await store.removeReply(ID);
    await store.placeReply(ID, "late reply");
    await expect(store.acceptReply(ID)).rejects.toBeInstanceOf(AlreadyExistsError);
    expect(await readFile(path.join(requests, ID, "reply.accepted.json"), "utf8")).toBe(replyText);
  });

  it("removes reply.json without an error when it is already gone", async () => {
    const { store } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    await store.removeReply(ID);
    await store.removeReply(ID);
  });

  it("reports a missing reply.json as link failed", async () => {
    const { store } = await newStore();
    await store.createRequest(sampleRequest(), sampleState());
    await expect(store.acceptReply(ID)).rejects.toMatchObject({ reason: "link failed" });
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
