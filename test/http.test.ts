import http from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ExchangeBroker } from "../src/broker/exchange-broker.js";
import { StartupError } from "../src/errors.js";
import { HttpServer } from "../src/http/server.js";
import { Logger, type LoggerOptions } from "../src/log.js";
import { createReplyFile, serializeFile } from "../src/model.js";
import { FakeClock } from "./helpers/fake-clock.js";
import { FakeStore } from "./helpers/fake-store.js";

const started: HttpServer[] = [];

afterEach(async () => {
  await Promise.all(started.splice(0, started.length).map((server) => server.close()));
});

async function startServer(port = 0, makeLogger?: (options: LoggerOptions) => Logger) {
  const store = new FakeStore();
  const clock = new FakeClock();
  const broker = new ExchangeBroker({ store, clock, pollIntervalMs: 500 });
  const out: string[] = [];
  const err: string[] = [];
  const loggerOptions: LoggerOptions = {
    out: { write: (text) => out.push(text) },
    err: { write: (text) => err.push(text) },
    clock,
  };
  const logger = makeLogger === undefined ? new Logger(loggerOptions) : makeLogger(loggerOptions);
  const unexpected: unknown[] = [];
  const server = new HttpServer({
    host: "127.0.0.1",
    port,
    broker,
    logger,
    nowSeconds: () => 1791813940,
    onUnexpectedFailure: (error) => unexpected.push(error),
  });
  started.push(server);
  const address = await server.listen();
  return {
    server,
    store,
    clock,
    broker,
    out,
    err,
    unexpected,
    port: address.port,
    host: address.host,
  };
}

interface Reply {
  status: number;
  headers: http.IncomingHttpHeaders;
  text: string;
  json: () => ReplyBody;
}

/** The fields of a JSON reply that these tests read. Other fields are compared whole. */
interface ReplyBody {
  id: string;
  error: { message: string; type: string; code: string };
  choices: { message: { content: string } }[];
}

function send(
  port: number,
  options: { method?: string; path?: string; headers?: http.OutgoingHttpHeaders; body?: string },
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "POST",
        path: options.path ?? "/v1/chat/completions",
        headers: options.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            json: () => JSON.parse(text) as ReplyBody,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(options.body);
  });
}

function chat(content: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({ model: "whatever", messages: [{ role: "user", content }], ...extra });
}

async function waitFor(condition: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("timed out waiting for the condition");
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function rawHttp10(port: number, requestLine: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.on("data", (chunk) => {
      data += chunk.toString("utf8");
    });
    socket.on("end", () => resolve(data));
    socket.on("error", reject);
    socket.write(`${requestLine}\r\n\r\n`);
  });
}

describe("checks before the body is read", () => {
  it("refuses a request with an Origin header and stores nothing", async () => {
    const { port, store, out } = await startServer();
    const reply = await send(port, {
      headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
      body: chat("Hello"),
    });
    expect(reply.status).toBe(400);
    expect(reply.json()).toEqual({
      error: {
        message: "Cross-origin requests are not accepted.",
        type: "invalid_request_error",
        code: "invalid_request",
      },
    });
    expect(store.entries.size).toBe(0);
    expect(out).toEqual([]);
  });

  it("refuses an Origin header whatever its value", async () => {
    const { port } = await startServer();
    const reply = await send(port, { headers: { Origin: "null" }, body: chat("Hello") });
    expect(reply.status).toBe(400);
    expect(reply.json().error.message).toBe("Cross-origin requests are not accepted.");
  });

  it("refuses a Host that is not a local name and stores nothing", async () => {
    const { port, store } = await startServer();
    for (const host of ["evil.example", "localhost.evil.com", "127.0.0.2:3000", "[::1]:3000"]) {
      const reply = await send(port, { headers: { Host: host }, body: chat("Hello") });
      expect(reply.status).toBe(400);
      expect(reply.json().error).toEqual({
        message: "Unexpected Host header.",
        type: "invalid_request_error",
        code: "invalid_request",
      });
    }
    expect(store.entries.size).toBe(0);
  });

  it("accepts local Host names, ignoring case and the port", async () => {
    const { port } = await startServer();
    for (const host of [
      "localhost",
      "LOCALHOST:3000",
      "127.0.0.1",
      `127.0.0.1:${port}`,
      "LocalHost:1",
    ]) {
      const reply = await send(port, { method: "GET", path: "/nothing", headers: { Host: host } });
      expect(reply.status).toBe(404);
    }
  });

  it("refuses a Host header that is present but empty", async () => {
    const { port } = await startServer();
    const response = await rawHttp10(port, "GET /nothing HTTP/1.0\r\nHost:");
    expect(response.startsWith("HTTP/1.1 400")).toBe(true);
    expect(response).toContain("Unexpected Host header.");
  });

  it("accepts a request that has no Host header", async () => {
    const { port } = await startServer();
    const response = await rawHttp10(port, "GET /nothing HTTP/1.0");
    expect(response.startsWith("HTTP/1.1 404")).toBe(true);
  });
});

describe("paths and methods", () => {
  it("answers 404 for any other path, including GET /v1/models in this version", async () => {
    const { port } = await startServer();
    for (const path of ["/", "/v1/models", "/v1/chat/completions/", "/v1/responses"]) {
      const reply = await send(port, { method: "GET", path });
      expect(reply.status).toBe(404);
      expect(reply.json()).toEqual({
        error: { message: "Not found.", type: "invalid_request_error", code: "not_found" },
      });
    }
    const post = await send(port, { path: "/v1/models", body: "{}" });
    expect(post.status).toBe(404);
  });

  it("answers 405 for another method on the chat completions path", async () => {
    const { port } = await startServer();
    for (const method of ["GET", "PUT", "DELETE", "OPTIONS"]) {
      const reply = await send(port, { method });
      expect(reply.status).toBe(405);
      expect(reply.headers.allow).toBe("POST");
      expect(reply.json().error).toEqual({
        message: "Method not allowed.",
        type: "invalid_request_error",
        code: "method_not_allowed",
      });
    }
  });

  it("ignores the query string", async () => {
    const { port, store } = await startServer();
    // The connection stays open until the server is closed after the test.
    send(port, { path: "/v1/chat/completions?x=1", body: chat("Hello") }).catch(() => "dropped");
    await waitFor(() => store.entries.size === 1);
    expect(store.entries.size).toBe(1);
  });
});

describe("rejected bodies", () => {
  it("returns the 400 error body and stores nothing", async () => {
    const { port, store, out } = await startServer();
    const reply = await send(port, { body: "not json" });
    expect(reply.status).toBe(400);
    expect(reply.headers["content-type"]).toContain("application/json");
    expect(reply.json()).toEqual({
      error: {
        message: "Request body is not valid JSON.",
        type: "invalid_request_error",
        code: "invalid_request",
      },
    });
    expect(store.entries.size).toBe(0);
    expect(out).toEqual([]);
  });

  it("treats a request the same with and without an Authorization header", async () => {
    const { port } = await startServer();
    const without = await send(port, { body: '{"model":"m"}' });
    const withKey = await send(port, {
      headers: { Authorization: "Bearer anything-at-all" },
      body: '{"model":"m"}',
    });
    expect(withKey.status).toBe(without.status);
    expect(withKey.text).toBe(without.text);
  });
});

const BODY_LIMIT = 10485760;
const TOO_LARGE = {
  error: {
    message: "Request body is larger than 10 MB.",
    type: "invalid_request_error",
    code: "request_too_large",
  },
};

interface RawReply {
  status: number;
  text: string;
}

/**
 * Sends a request on a raw connection and waits until the server closes it. `writeBody` may
 * write the body in pieces; write errors are ignored, because the server answers 413 while the
 * body is still being sent. The test fails if the connection stays open.
 */
function rawExchange(
  port: number,
  head: string,
  writeBody: (socket: net.Socket) => void,
): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("the server did not close the connection"));
    }, 3000);
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("error", () => {});
    socket.on("close", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8");
      const split = raw.indexOf("\r\n\r\n");
      resolve({ status: Number(raw.slice(9, 12)), text: split === -1 ? "" : raw.slice(split + 4) });
    });
    socket.write(head);
    writeBody(socket);
  });
}

const POST_HEAD =
  "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n";

/** A chat body of exactly `total` bytes. With `twoByte`, the padding is made of "é" (2 bytes each). */
function chatOfBytes(total: number, twoByte: boolean): string {
  const base = Buffer.byteLength(chat(""));
  const free = total - base;
  const pad = twoByte
    ? "é".repeat(Math.floor(free / 2)) + (free % 2 === 1 ? "a" : "")
    : "a".repeat(free);
  const text = chat(pad);
  expect(Buffer.byteLength(text)).toBe(total);
  return text;
}

/** Writes `text` as HTTP chunks of 1 MiB at most, then the end chunk. */
function writeChunked(socket: net.Socket, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  for (let offset = 0; offset < bytes.length; offset += 1048576) {
    const piece = bytes.subarray(offset, offset + 1048576);
    socket.write(`${piece.length.toString(16)}\r\n`);
    socket.write(piece);
    socket.write("\r\n");
  }
  socket.write("0\r\n\r\n");
}

describe("the size of the body", () => {
  it("refuses a Content-Length above the limit without reading the body, and closes", async () => {
    const { port, store, out } = await startServer();
    const head = `${POST_HEAD}Content-Length: ${BODY_LIMIT + 1}\r\n\r\n`;
    // Only 12 of the declared 10485761 bytes are sent, and the connection stays open. The server
    // must answer from the header alone; waiting for the rest would make rawExchange time out.
    const reply = await rawExchange(port, head, (socket) => socket.write('{"model":"m"'));
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.text)).toEqual(TOO_LARGE);
    expect(store.entries.size).toBe(0);
    expect(out).toEqual([]);
  });

  it("refuses a body without Content-Length once more than the limit has arrived, and closes", async () => {
    const { port, store } = await startServer();
    const head = `${POST_HEAD}Transfer-Encoding: chunked\r\n\r\n`;
    const reply = await rawExchange(port, head, (socket) =>
      writeChunked(socket, "x".repeat(BODY_LIMIT + 1)),
    );
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.text)).toEqual(TOO_LARGE);
    expect(store.entries.size).toBe(0);
  });

  it("counts the bytes that arrive, not the characters, when there is no Content-Length", async () => {
    const { port, store } = await startServer();
    // Two-byte characters ("é"): more bytes than the limit, fewer characters than the limit.
    const text = chatOfBytes(BODY_LIMIT + 1, true);
    expect(Buffer.byteLength(text)).toBe(BODY_LIMIT + 1);
    expect(text.length).toBeLessThan(BODY_LIMIT);
    const head = `${POST_HEAD}Transfer-Encoding: chunked\r\n\r\n`;
    const reply = await rawExchange(port, head, (socket) => writeChunked(socket, text));
    expect(reply.status).toBe(413);
    expect(JSON.parse(reply.text)).toEqual(TOO_LARGE);
    expect(store.entries.size).toBe(0);
  });

  it("accepts a body of exactly the limit and stores it", async () => {
    const context = await startServer();
    const pending = send(context.port, { body: chatOfBytes(BODY_LIMIT, false) });
    await waitFor(() => context.store.entries.size === 1);
    const id = [...context.store.entries.keys()][0] as string;
    await answer(context, id, "ok");
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(reply.json().choices[0]?.message.content).toBe("ok");
  });

  it("accepts exactly the limit when it is made of two-byte characters, and without Content-Length", async () => {
    const context = await startServer();
    const pending = send(context.port, {
      headers: { "Transfer-Encoding": "chunked" },
      body: chatOfBytes(BODY_LIMIT, true),
    });
    await waitFor(() => context.store.entries.size === 1);
    const id = [...context.store.entries.keys()][0] as string;
    await answer(context, id, "ok");
    expect((await pending).status).toBe(200);
  });

  it("answers 413 before it looks at whether the body is JSON", async () => {
    const { port } = await startServer();
    const head = `${POST_HEAD}Content-Length: ${BODY_LIMIT + 1}\r\n\r\n`;
    const reply = await rawExchange(port, head, (socket) => socket.write("not json"));
    expect(JSON.parse(reply.text)).toEqual(TOO_LARGE);
  });
});

describe("a request that gets a reply", () => {
  it("holds the connection until a reply is accepted, then answers 200", async () => {
    const { port, store, broker, out } = await startServer();
    const pending = send(port, {
      headers: { Authorization: "Bearer key" },
      body: chat("Hello", { stream: false, temperature: 0.1 }),
    });
    await waitFor(() => store.entries.size === 1);
    const [id] = [...store.entries.keys()];
    expect(id).toBeDefined();
    const shortId = (id as string).slice(-6);
    expect(out).toEqual([
      expect.stringMatching(
        new RegExp(`^\\d\\d:\\d\\d:\\d\\d received   ${shortId}  chat/completions  text\\n$`),
      ),
    ]);
    store.putFile(
      id as string,
      "reply.json",
      serializeFile(createReplyFile("It returns what a human types.", "2026-10-09T14:05:12.000Z")),
    );
    await broker.pollOnce();
    const reply = await pending;
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toContain("application/json");
    expect(reply.json()).toEqual({
      id: `chatcmpl-${id}`,
      object: "chat.completion",
      created: 1791813940,
      model: "whatever",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "It returns what a human types." },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    expect(out).toHaveLength(2);
    expect(out[1]).toMatch(new RegExp(`^\\d\\d:\\d\\d:\\d\\d replied    ${shortId}\\n$`));
  });

  it("never writes the request or reply text to the log", async () => {
    const { port, store, broker, out, err } = await startServer();
    const pending = send(port, { body: chat("SECRET-QUESTION-777") });
    await waitFor(() => store.entries.size === 1);
    const [id] = [...store.entries.keys()];
    store.putFile(
      id as string,
      "reply.json",
      serializeFile(createReplyFile("SECRET-ANSWER-888", "2026-10-09T14:05:12.000Z")),
    );
    await broker.pollOnce();
    await pending;
    const everything = out.join("") + err.join("");
    expect(everything).not.toContain("SECRET-QUESTION-777");
    expect(everything).not.toContain("SECRET-ANSWER-888");
  });

  it("returns each of ten simultaneous requests its own reply (NFR8.1)", async () => {
    const { port, store, broker } = await startServer();
    const pending = Array.from({ length: 10 }, (_, index) =>
      send(port, { body: chat(`question ${index}`) }),
    );
    await waitFor(() => store.entries.size === 10);
    for (const [id, entry] of store.entries) {
      const request = entry.request;
      const question = typeof request === "object" ? request.conversation[0]?.content : "";
      const number = String(question).replace("question ", "");
      store.putFile(
        id,
        "reply.json",
        serializeFile(createReplyFile(`answer ${number}`, "2026-10-09T14:05:12.000Z")),
      );
    }
    await broker.pollOnce();
    const replies = await Promise.all(pending);
    const contents = replies.map((reply) => reply.json().choices[0]?.message.content);
    expect(contents).toEqual(Array.from({ length: 10 }, (_, index) => `answer ${index}`));
    const ids = replies.map((reply) => reply.json().id);
    expect(new Set(ids).size).toBe(10);
    // Ids are assigned in the order the requests arrive, so storage order is id order.
    const assigned = [...store.entries.keys()];
    expect([...assigned].sort()).toEqual(assigned);
  });
});

/** Sends a request and tells whether any part of the response (even the headers) has arrived. */
function sendWatching(port: number, body: string) {
  let arrived = false;
  const pending = new Promise<Reply>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        method: "POST",
        path: "/v1/chat/completions",
        headers: { "Content-Type": "application/json" },
      },
      (response) => {
        arrived = true;
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text,
            json: () => JSON.parse(text) as ReplyBody,
          });
        });
      },
    );
    request.on("error", reject);
    request.end(body);
  });
  return { pending, hasArrived: () => arrived };
}

/** The events of a stream: the text after "data: " of each block. */
function eventsOf(text: string): string[] {
  expect(text.endsWith("\n\n")).toBe(true);
  return text
    .slice(0, -2)
    .split("\n\n")
    .map((block) => {
      expect(block.startsWith("data: ")).toBe(true);
      return block.slice("data: ".length);
    });
}

describe("streaming", () => {
  async function streamed(extra: Record<string, unknown>, content = "Hi") {
    const context = await startServer();
    const watching = sendWatching(context.port, chat("Hello", { stream: true, ...extra }));
    await waitFor(() => context.store.entries.size === 1);
    const [id] = [...context.store.entries.keys()] as [string];
    // Nothing, not even the headers, is sent while the human has not replied.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(watching.hasArrived()).toBe(false);
    await answer(context, id, content);
    return { reply: await watching.pending, id, context };
  }

  it("sends text/event-stream once the reply arrives: role, content, stop, then [DONE]", async () => {
    const { reply, id } = await streamed({});
    expect(reply.status).toBe(200);
    expect(reply.headers["content-type"]).toContain("text/event-stream");
    const events = eventsOf(reply.text);
    expect(events).toHaveLength(4);
    expect(events[3]).toBe("[DONE]");
    const chunks = events.slice(0, 3).map((event) => JSON.parse(event));
    const common = {
      id: `chatcmpl-${id}`,
      object: "chat.completion.chunk",
      created: 1791813940,
      model: "whatever",
    };
    expect(chunks).toEqual([
      {
        ...common,
        choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
      },
      { ...common, choices: [{ index: 0, delta: { content: "Hi" }, finish_reason: null }] },
      { ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
  });

  it("sends the whole reply in one content chunk and adds a usage chunk when asked", async () => {
    const body = 'line one\nline two {"a": 1}';
    const { reply } = await streamed({ stream_options: { include_usage: true } }, body);
    const events = eventsOf(reply.text);
    expect(events).toHaveLength(5);
    const contents = events
      .slice(0, 4)
      .map((event) => JSON.parse(event).choices[0]?.delta?.content)
      .filter((content) => content !== undefined && content !== "");
    expect(contents).toEqual([body]);
    expect(JSON.parse(events[3] as string)).toMatchObject({
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
    expect(events[4]).toBe("[DONE]");
  });

  it("streams a structured-output request in the same form", async () => {
    const { reply, context, id } = await streamed({
      response_format: {
        type: "json_schema",
        json_schema: { name: "x", schema: { type: "object" } },
      },
    });
    expect(reply.headers["content-type"]).toContain("text/event-stream");
    expect(eventsOf(reply.text)).toHaveLength(4);
    const stored = context.store.entries.get(id)?.request;
    expect(stored).toMatchObject({ replyKind: "json", stream: true });
  });

  it("answers a stream:false or missing stream request with the JSON response", async () => {
    for (const extra of [
      { stream: false },
      {},
      { stream: false, stream_options: { include_usage: true } },
    ]) {
      const context = await startServer();
      const pending = send(context.port, { body: chat("Hello", extra) });
      await waitFor(() => context.store.entries.size === 1);
      const [id] = [...context.store.entries.keys()] as [string];
      await answer(context, id, "Hi");
      const reply = await pending;
      expect(reply.headers["content-type"]).toContain("application/json");
      expect(reply.json().choices[0]?.message.content).toBe("Hi");
    }
  });

  it("answers a failure before the stream starts with the normal JSON error", async () => {
    const { port, store } = await startServer();
    store.fail("createRequest");
    const reply = await send(port, { body: chat("Hello", { stream: true }) });
    expect(reply.status).toBe(500);
    expect(reply.headers["content-type"]).toContain("application/json");
    expect(reply.headers["content-type"]).not.toContain("text/event-stream");
    expect(reply.json().error).toEqual({
      message: "The request could not be stored.",
      type: "server_error",
      code: "storage_error",
    });
    const rejected = await send(port, { body: '{"stream": true' });
    expect(rejected.status).toBe(400);
    expect(rejected.headers["content-type"]).toContain("application/json");
  });
});

describe("the received line shows the reply kind and stream", () => {
  it("adds json and stream to the line, and nothing from the request", async () => {
    const context = await startServer();
    const pendings = [
      send(context.port, { body: chat("SECRET-TEXT", {}) }),
      send(context.port, { body: chat("SECRET-TEXT", { stream: true }) }),
      send(context.port, {
        body: chat("SECRET-TEXT", { response_format: { type: "json_object" } }),
      }),
      send(context.port, {
        body: chat("SECRET-TEXT", { response_format: { type: "json_object" }, stream: true }),
      }),
    ];
    await waitFor(() => context.out.length === 4);
    const details = context.out.map((line) => /[0-9a-f]{6} {2}(.*)\n$/.exec(line)?.[1]);
    expect(details.sort()).toEqual([
      "chat/completions  json",
      "chat/completions  json  stream",
      "chat/completions  text",
      "chat/completions  text  stream",
    ]);
    expect(context.out.join("")).not.toContain("SECRET-TEXT");
    for (const id of context.store.entries.keys()) {
      await answer(context, id, "ok");
    }
    await Promise.all(pendings);
  });
});

describe("storage failure", () => {
  it("answers 500 storage_error, writes one failure line, and keeps nothing", async () => {
    const { port, store, out } = await startServer();
    store.fail("createRequest");
    const reply = await send(port, { body: chat("Hello") });
    expect(reply.status).toBe(500);
    expect(reply.json()).toEqual({
      error: {
        message: "The request could not be stored.",
        type: "server_error",
        code: "storage_error",
      },
    });
    expect(store.entries.size).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatch(/^\d\d:\d\d:\d\d error {6}[0-9a-f]{6} {2}write failed\n$/);
  });
});

describe("listening (NFR9.1)", () => {
  it("listens on the IPv4 loopback address", async () => {
    const { host, port } = await startServer();
    expect(host).toBe("127.0.0.1");
    const reply = await send(port, { method: "GET", path: "/nothing" });
    expect(reply.status).toBe(404);
  });

  it("fails with a startup error when the port is already in use", async () => {
    const first = await startServer();
    const second = new HttpServer({
      host: "127.0.0.1",
      port: first.port,
      broker: first.broker,
      logger: new Logger({
        out: { write: () => {} },
        err: { write: () => {} },
        clock: first.clock,
      }),
      nowSeconds: () => 0,
      onUnexpectedFailure: () => {},
    });
    started.push(second);
    const failure = second.listen();
    await expect(failure).rejects.toBeInstanceOf(StartupError);
    await expect(failure).rejects.toThrow(`port ${first.port} is already in use.`);
  });

  it("stops accepting and drops open connections when closed", async () => {
    const { server, port, store } = await startServer();
    const pending = send(port, { body: chat("Hello") }).then(
      () => "answered",
      () => "dropped",
    );
    await waitFor(() => store.entries.size === 1);
    await server.close();
    expect(await pending).toBe("dropped");
    await expect(send(port, { method: "GET", path: "/nothing" })).rejects.toThrow();
    expect(store.entries.size).toBe(1);
  });
});

/** Opens a raw connection, sends the head of a chat request with a body that is never finished. */
function openUnfinishedRequest(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
          "Content-Type: application/json\r\nContent-Length: 500\r\n\r\n" +
          '{"model":"whatever","mess',
      );
      resolve(socket);
    });
    socket.on("error", () => {});
    socket.on("error", reject);
  });
}

/** Holds one request open and returns what a test needs to answer it later. */
async function holdOneRequest(
  context: Awaited<ReturnType<typeof startServer>>,
  content: string,
): Promise<{ pending: Promise<Reply>; id: string }> {
  const pending = send(context.port, { body: chat(content) });
  const before = context.store.entries.size;
  await waitFor(() => context.store.entries.size === before + 1);
  const id = [...context.store.entries.keys()].pop() as string;
  return { pending, id };
}

async function answer(
  context: Awaited<ReturnType<typeof startServer>>,
  id: string,
  body: string,
): Promise<void> {
  context.store.putFile(
    id,
    "reply.json",
    serializeFile(createReplyFile(body, "2026-10-09T14:05:12.000Z")),
  );
  await context.broker.pollOnce();
}

describe("connection errors close only that connection", () => {
  it("survives a client that disconnects in the middle of the body", async () => {
    const context = await startServer();
    const first = await holdOneRequest(context, "first");
    const socket = await openUnfinishedRequest(context.port);
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(context.unexpected).toEqual([]);
    const second = await holdOneRequest(context, "second");
    await answer(context, first.id, "one");
    await answer(context, second.id, "two");
    expect((await first.pending).json().choices[0]?.message.content).toBe("one");
    expect((await second.pending).json().choices[0]?.message.content).toBe("two");
  });

  it("survives a connection that is reset in the middle of the body", async () => {
    const context = await startServer();
    const first = await holdOneRequest(context, "first");
    const socket = await openUnfinishedRequest(context.port);
    socket.resetAndDestroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(context.unexpected).toEqual([]);
    await answer(context, first.id, "still here");
    expect((await first.pending).json().choices[0]?.message.content).toBe("still here");
  });

  it("survives writing a reply to a connection that is already gone", async () => {
    const context = await startServer();
    const gone = await new Promise<{ id: string }>((resolve, reject) => {
      const socket = net.connect(context.port, "127.0.0.1", () => {
        const body = chat("gone");
        socket.write(
          "POST /v1/chat/completions HTTP/1.1\r\nHost: 127.0.0.1\r\n" +
            `Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
        );
        waitFor(() => context.store.entries.size === 1).then(() => {
          socket.destroy();
          resolve({ id: [...context.store.entries.keys()][0] as string });
        }, reject);
      });
      socket.on("error", () => {});
    });
    const other = await holdOneRequest(context, "other");
    await answer(context, gone.id, "to nobody");
    await answer(context, other.id, "to somebody");
    expect((await other.pending).json().choices[0]?.message.content).toBe("to somebody");
    expect(context.unexpected).toEqual([]);
  });
});

describe("unexpected failures are reported once and never answered with details", () => {
  it("reports an exception raised while handling a request and drops that connection", async () => {
    class BrokenLogger extends Logger {
      override received(): void {
        throw new Error("SECRET-DETAIL at /private/path");
      }
    }
    const context = await startServer(0, (options) => new BrokenLogger(options));
    const outcome = await send(context.port, { body: chat("Hello") }).then(
      () => "answered",
      () => "dropped",
    );
    expect(outcome).toBe("dropped");
    expect(context.unexpected).toHaveLength(1);
    expect((context.unexpected[0] as Error).message).toContain("SECRET-DETAIL");
    expect(context.out.join("") + context.err.join("")).not.toContain("SECRET-DETAIL");
  });

  it("reports an error of the HTTP server after it started listening", async () => {
    const context = await startServer();
    const failure = Object.assign(new Error("boom"), { code: "EIO" });
    const inner = (context.server as unknown as { server: http.Server }).server;
    expect(() => inner.emit("error", failure)).not.toThrow();
    expect(context.unexpected).toEqual([failure]);
  });
});
