import http from "node:http";
import type { AddressInfo } from "node:net";
import type { BrokerEvent, ExchangeBroker } from "../broker/exchange-broker.js";
import {
  buildCompletion,
  type ErrorCode,
  errorBody,
  MESSAGES,
  parseChatCompletionsRequest,
} from "../chat-completions/adapter.js";
import { describeFsError, StartupError } from "../errors.js";
import { shortId } from "../ids.js";
import type { Logger } from "../log.js";
import type { ConversationRequest } from "../model.js";

export interface HttpServerOptions {
  host: string;
  port: number;
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
const LOCAL_HOST_NAMES = new Set(["127.0.0.1", "localhost"]);

/** The name part of a Host header: no port, in lower case. */
function hostName(header: string): string {
  const name = header.startsWith("[")
    ? header.slice(0, header.indexOf("]") + 1)
    : header.split(":")[0];
  return (name ?? "").toLowerCase();
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
  if (header === undefined || LOCAL_HOST_NAMES.has(hostName(header))) {
    return undefined;
  }
  return { status: 400, code: "invalid_request", message: MESSAGES.unexpectedHost };
}

function checkRoute(request: http.IncomingMessage): Refusal | undefined {
  if (pathOf(request.url) !== CHAT_PATH) {
    return { status: 404, code: "not_found", message: MESSAGES.notFound };
  }
  if (request.method !== "POST") {
    return {
      status: 405,
      code: "method_not_allowed",
      message: MESSAGES.methodNotAllowed,
      allow: "POST",
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

async function readBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  try {
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
  } catch (error) {
    throw new ConnectionError(error);
  }
  return Buffer.concat(chunks).toString("utf8");
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

function listenFailure(error: NodeJS.ErrnoException, port: number): StartupError {
  if (error.code === "EADDRINUSE") {
    return new StartupError(`port ${port} is already in use.`);
  }
  if (error.code === "EACCES") {
    return new StartupError(`no permission to listen on port ${port}.`);
  }
  return new StartupError(`cannot listen on port ${port}: ${describeFsError(error)}.`);
}

/**
 * The HTTP side of serve. It checks each request, hands the good ones to the broker, and
 * answers when a reply has been accepted. It listens on the address it is given, which
 * the command layer fixes to 127.0.0.1.
 */
export class HttpServer {
  private readonly options: HttpServerOptions;
  private readonly server: http.Server;
  private unsubscribe: (() => void) | undefined;

  constructor(options: HttpServerOptions) {
    this.options = options;
    this.server = http.createServer({ requireHostHeader: false }, (request, response) => {
      void this.handle(request, response);
    });
  }

  /** Starts listening and returns the real address. Fails with a StartupError. */
  async listen(): Promise<{ host: string; port: number }> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        reject(listenFailure(error, this.options.port));
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

  /** Stops accepting requests and drops the connections that are still waiting. */
  async close(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }

  private logEvent(event: BrokerEvent): void {
    const id = event.id === undefined ? undefined : shortId(event.id);
    if (event.type === "replied" && id !== undefined) {
      this.options.logger.replied(id);
    } else if (event.type === "error") {
      this.options.logger.failure(id, event.reason);
    } else if (event.type === "recovered") {
      this.options.logger.recovered(id);
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
    const parsed = parseChatCompletionsRequest(await readBody(request));
    if (!parsed.ok) {
      const { status, code, message } = parsed.rejection;
      respond(response, status, errorBody(code, message));
      return;
    }
    await this.serve(response, parsed.request);
  }

  private async serve(response: http.ServerResponse, request: ConversationRequest): Promise<void> {
    let submitted: Awaited<ReturnType<ExchangeBroker["submit"]>>;
    try {
      submitted = await this.options.broker.submit(request);
    } catch {
      respond(response, 500, errorBody("storage_error", MESSAGES.storage));
      return;
    }
    this.options.logger.received(shortId(submitted.id));
    const outcome = await submitted.outcome;
    respond(
      response,
      200,
      buildCompletion({
        requestId: outcome.id,
        model: request.model,
        content: outcome.body,
        nowSeconds: this.options.nowSeconds(),
      }),
    );
  }
}
