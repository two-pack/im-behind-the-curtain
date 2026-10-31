import http from "node:http";
import net, { type AddressInfo } from "node:net";
import type { BrokerEvent, ExchangeBroker, ExchangeOutcome } from "../broker/exchange-broker.js";
import {
  buildCompletion,
  buildModelList,
  buildStreamEvents,
  type ErrorCode,
  errorBody,
  invalidReplyMessage,
  MESSAGES,
  parseChatCompletionsRequest,
  replyTimeoutMessage,
} from "../chat-completions/adapter.js";
import { describeFsError, StartupError } from "../errors.js";
import { shortId } from "../ids.js";
import type { Logger } from "../log.js";
import { type ConversationRequest, MAX_BODY_BYTES, type PartFileData } from "../model.js";

/** What the HTTP server needs from a Node.js server. A test replaces it to make listening fail. */
export interface ListenTarget {
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  off(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  listen(port: number, host: string, callback: () => void): unknown;
  address(): AddressInfo | string | null;
  close(callback: () => void): unknown;
  closeAllConnections(): void;
}

export interface HttpServerOptions {
  host: string;
  port: number;
  /** Makes the server that listens. Only tests set it. */
  createServer?: (listener: http.RequestListener) => ListenTarget;
  broker: ExchangeBroker;
  logger: Logger;
  /** The time in whole seconds since the epoch, for the `created` field. */
  nowSeconds: () => number;
  /**
   * Called with an exception that is not a connection error, and with an error of the HTTP
   * server after it started listening. The caller ends the program.
   */
  onUnexpectedFailure: (error: unknown) => void;
}

/** A failure of one client connection: the client left, the connection was reset, or a write failed. */
class ConnectionError extends Error {
  constructor(cause: unknown) {
    super("connection error", { cause });
    this.name = "ConnectionError";
  }
}

interface Refusal {
  status: number;
  code: ErrorCode;
  message: string;
  allow?: string;
}

const CHAT_PATH = "/v1/chat/completions";
const MODELS_PATH = "/v1/models";
/** The one method each path takes. */
const ROUTES: ReadonlyMap<string, string> = new Map([
  [CHAT_PATH, "POST"],
  [MODELS_PATH, "GET"],
]);

/** The part after the name: nothing, or ":" and one or more digits. */
const PORT_PART = /^(?::\d+)?$/;

/**
 * Splits a Host header into its name and the rest (the port part). The name of `[::1]` is `::1`,
 * and nothing may follow the closing bracket but the port part. Without a bracket the name ends at
 * the first colon, so a bare `::1` has an empty name. Undefined when a bracket is not closed.
 */
function splitHostHeader(header: string): { name: string; rest: string } | undefined {
  if (header.startsWith("[")) {
    const end = header.indexOf("]");
    return end === -1 ? undefined : { name: header.slice(1, end), rest: header.slice(end + 1) };
  }
  const colon = header.indexOf(":");
  return colon === -1
    ? { name: header, rest: "" }
    : { name: header.slice(0, colon), rest: header.slice(colon) };
}

/**
 * Whether a Host header is this machine. The port part must be absent or ":" and
 * digits. The name must be `localhost` in any case, `::1` in brackets, or an IPv4 address of
 * 127.0.0.0/8 written as four decimal numbers: `127.1` and the hex or octal forms are refused.
 * The module of the settings has its own check for the `--host` option, because this module may
 * not import it.
 */
function isLocalHostHeader(header: string): boolean {
  const parts = splitHostHeader(header);
  if (parts === undefined || !PORT_PART.test(parts.rest)) {
    return false;
  }
  if (header.startsWith("[")) {
    return parts.name === "::1";
  }
  const name = parts.name.toLowerCase();
  return name === "localhost" || (net.isIPv4(name) && name.startsWith("127."));
}

function pathOf(target: string | undefined): string {
  const url = target ?? "/";
  const query = url.indexOf("?");
  return query === -1 ? url : url.slice(0, query);
}

/** A request from a browser page is refused. Tools like curl and the SDKs send no Origin. */
function checkOrigin(request: http.IncomingMessage): Refusal | undefined {
  return request.headers.origin === undefined
    ? undefined
    : { status: 400, code: "invalid_request", message: MESSAGES.crossOrigin };
}

/** A Host that is not this machine is refused. A missing Host is accepted. */
function checkHost(request: http.IncomingMessage): Refusal | undefined {
  const header = request.headers.host;
  if (header === undefined || isLocalHostHeader(header)) {
    return undefined;
  }
  return { status: 400, code: "invalid_request", message: MESSAGES.unexpectedHost };
}

function checkRoute(request: http.IncomingMessage): Refusal | undefined {
  const method = ROUTES.get(pathOf(request.url));
  if (method === undefined) {
    return { status: 404, code: "not_found", message: MESSAGES.notFound };
  }
  if (request.method !== method) {
    return {
      status: 405,
      code: "method_not_allowed",
      message: MESSAGES.methodNotAllowed,
      allow: method,
    };
  }
  return undefined;
}

/** The checks made before the body is read, in order. The first one that refuses decides. */
const PREFLIGHT_CHECKS: readonly ((request: http.IncomingMessage) => Refusal | undefined)[] = [
  checkOrigin,
  checkHost,
  checkRoute,
];

function preflight(request: http.IncomingMessage): Refusal | undefined {
  for (const check of PREFLIGHT_CHECKS) {
    const refusal = check(request);
    if (refusal !== undefined) {
      return refusal;
    }
  }
  return undefined;
}

/** The most bytes of request body that are accepted. */
const BODY_LIMIT = MAX_BODY_BYTES;

/**
 * Reads the whole body as text. Gives undefined, and stops reading, as soon as more than
 * `BODY_LIMIT` bytes have arrived. The bytes are counted as they arrive, not as characters.
 */
function readBody(request: http.IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > BODY_LIMIT) {
        chunks.length = 0;
        request.pause();
        resolve(undefined);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", (error) => reject(new ConnectionError(error)));
    request.on("close", () => {
      if (!request.complete) {
        reject(new ConnectionError(new Error("the client closed the connection")));
      }
    });
  });
}

/** The 413 answer. The connection is closed after it, because the rest of the body is not read. */
function respondTooLarge(response: http.ServerResponse): void {
  const body = errorBody("request_too_large", MESSAGES.requestTooLarge);
  respond(response, 413, body, { Connection: "close" });
}

function respond(
  response: http.ServerResponse,
  status: number,
  body: unknown,
  headers: http.OutgoingHttpHeaders = {},
): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  const text = JSON.stringify(body);
  try {
    response.writeHead(status, {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(text),
      ...headers,
    });
    response.end(text);
  } catch (error) {
    throw new ConnectionError(error);
  }
}

/**
 * Sends a whole stream in one write, once the reply is there. Nothing, not even
 * the headers, goes out while the human has not replied, so a failure before this point is
 * still answered with a normal JSON error.
 */
function respondStream(response: http.ServerResponse, events: string[]): void {
  if (response.destroyed || response.writableEnded) {
    return;
  }
  try {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
    });
    response.end(events.join(""));
  } catch (error) {
    throw new ConnectionError(error);
  }
}

/** The sentences for a failure to listen. */
function listenFailure(error: NodeJS.ErrnoException, host: string, port: number): StartupError {
  if (error.code === "EADDRINUSE") {
    return new StartupError(
      `port ${port} is already in use. Choose another port with --port or IMBEHIND_PORT.`,
    );
  }
  if (error.code === "EACCES") {
    return new StartupError(`no permission to listen on port ${port}.`);
  }
  if (error.code === "EADDRNOTAVAIL") {
    const shown = host.includes(":") ? `[${host}]` : host;
    return new StartupError(`cannot listen on ${shown}:${port}: address not available.`);
  }
  return new StartupError(`cannot listen on port ${port}: ${describeFsError(error)}.`);
}

/** The Node.js server of production: `Host` is not required, so a missing one is accepted. */
function createNodeServer(listener: http.RequestListener): ListenTarget {
  return http.createServer({ requireHostHeader: false }, listener);
}

/**
 * The HTTP side of serve. It checks each request, hands the good ones to the broker, and
 * answers when a reply has been accepted. It listens on the address it is given, which
 * the command layer fixes to 127.0.0.1.
 */
export class HttpServer {
  private readonly options: HttpServerOptions;
  private readonly server: ListenTarget;
  private unsubscribe: (() => void) | undefined;

  constructor(options: HttpServerOptions) {
    this.options = options;
    const create = options.createServer ?? createNodeServer;
    this.server = create((request, response) => {
      void this.handle(request, response);
    });
  }

  /** Starts listening and returns the real address. Fails with a StartupError. */
  async listen(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        reject(listenFailure(error, this.options.host, this.options.port));
      };
      this.server.once("error", onError);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", onError);
        this.server.on("error", (error) => this.options.onUnexpectedFailure(error));
        resolve();
      });
    });
    this.unsubscribe = this.options.broker.subscribe((event) => this.logEvent(event));
    const address = this.server.address() as AddressInfo;
    return { host: address.address, port: address.port };
  }

  /**
   * Stops accepting requests and drops the connections that are still waiting, without an
   * answer. Those requests stay `waiting`: the broker stops first, so the closing connections
   * are not taken for clients that left.
   */
  async close(): Promise<void> {
    this.options.broker.shutdown();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private logEvent(event: BrokerEvent): void {
    const id = event.id === undefined ? undefined : shortId(event.id);
    if (event.type === "error") {
      this.options.logger.failure(id, event.reason);
    } else if (event.type === "recovered") {
      this.options.logger.recovered(id);
    } else if (event.type === "invalid_reply") {
      this.options.logger.invalidReply(shortId(event.id), event.reason);
    } else if (id !== undefined) {
      this.logEnding(event.type, id);
    }
  }

  private logEnding(
    type: "replied" | "skipped" | "cancelled" | "timed_out" | "abandoned",
    id: string,
  ): void {
    const { logger } = this.options;
    if (type === "replied") {
      logger.replied(id);
    } else if (type === "skipped") {
      logger.skipped(id);
    } else if (type === "cancelled") {
      logger.cancelled(id);
    } else if (type === "abandoned") {
      logger.abandoned(id);
    } else {
      logger.timedOut(id);
    }
  }

  private async handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    try {
      await this.handleRequest(request, response);
    } catch (error) {
      response.destroy();
      if (!(error instanceof ConnectionError)) {
        this.options.onUnexpectedFailure(error);
      }
    }
  }

  private async handleRequest(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const refusal = preflight(request);
    if (refusal !== undefined) {
      const headers = refusal.allow === undefined ? {} : { Allow: refusal.allow };
      respond(response, refusal.status, errorBody(refusal.code, refusal.message), headers);
      return;
    }
    if (pathOf(request.url) === MODELS_PATH) {
      respond(response, 200, buildModelList());
      return;
    }
    const declaredLength = Number(request.headers["content-length"]);
    const text = declaredLength > BODY_LIMIT ? undefined : await readBody(request);
    if (text === undefined) {
      respondTooLarge(response);
      return;
    }
    const parsed = parseChatCompletionsRequest(text);
    if (!parsed.ok) {
      const { status, code, message } = parsed.rejection;
      respond(response, status, errorBody(code, message));
      return;
    }
    await this.serve(response, parsed.request, parsed.parts);
  }

  private async serve(
    response: http.ServerResponse,
    request: ConversationRequest,
    parts: readonly PartFileData[],
  ): Promise<void> {
    // The close of the response is watched from here on, before the request is stored.
    const connection = this.watchConnection(response);
    try {
      let submitted: Awaited<ReturnType<ExchangeBroker["submit"]>>;
      try {
        submitted = await this.options.broker.submit(request, parts);
      } catch {
        respond(response, 500, errorBody("storage_error", MESSAGES.storage));
        return;
      }
      connection.stored(submitted.id);
      this.options.logger.received(shortId(submitted.id), request.replyKind, request.stream);
      respondTo(response, request, await submitted.outcome, this.options.nowSeconds());
    } finally {
      connection.stop();
    }
  }

  /**
   * Tells the broker when the client of a request goes away. It listens to the
   * close of the response, as long as the response is not finished. The close of the request
   * is no sign of a disconnect: it also comes when the body has been read. A disconnect that
   * comes while the request is being stored is passed on as soon as it is stored.
   */
  private watchConnection(response: http.ServerResponse) {
    let id: string | undefined;
    let gone = response.destroyed;
    const cancel = (requestId: string): void => {
      this.options.broker.cancel(requestId).catch((error: unknown) => {
        this.options.onUnexpectedFailure(error);
      });
    };
    const onClose = (): void => {
      if (response.writableEnded) {
        return;
      }
      gone = true;
      if (id !== undefined) {
        cancel(id);
      }
    };
    response.on("close", onClose);
    return {
      stored: (requestId: string): void => {
        id = requestId;
        if (gone) {
          cancel(requestId);
        }
      },
      stop: (): void => {
        response.off("close", onClose);
      },
    };
  }
}

/** The answer for how a request ended. A cancelled request gets none. */
function respondTo(
  response: http.ServerResponse,
  request: ConversationRequest,
  outcome: ExchangeOutcome,
  nowSeconds: number,
): void {
  if (outcome.kind === "skipped") {
    respond(response, 503, errorBody("skipped_by_human", MESSAGES.skipped));
  } else if (outcome.kind === "invalid_reply") {
    // The stream has not started, so a stream request gets the normal error too.
    respond(response, 502, errorBody("invalid_reply", invalidReplyMessage(outcome.reason)));
  } else if (outcome.kind === "timed_out") {
    respond(response, 504, errorBody("reply_timeout", replyTimeoutMessage(outcome.limitSeconds)));
  } else if (outcome.kind === "replied") {
    const input = {
      requestId: outcome.id,
      model: request.model,
      content: outcome.body,
      nowSeconds,
      reply: outcome.reply,
    };
    if (request.stream) {
      respondStream(response, buildStreamEvents({ ...input, includeUsage: request.includeUsage }));
    } else {
      respond(response, 200, buildCompletion(input));
    }
  }
}
