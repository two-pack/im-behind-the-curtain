/**
 * Starts the built program, sends one request, answers it from standard input and checks that
 * the client got the reply. Run it with `npm run round-trip` after `npm run build`. Give the path
 * of another `bin.js` as an argument to test an installed package instead.
 *
 * It needs nothing but Node.js: the storage directory is a temporary folder and the port is a
 * free one, so it works on every operating system and does not disturb a running imbehind.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

/** The program to test: the path given as the first argument, or the built one. */
const BIN = path.resolve(process.argv[2] ?? path.join("dist", "bin.js"));
const LIMIT_MS = 60_000;
const REPLY = "Hi";

/** The environment of the person, without the settings of imbehind, so that they cannot change the result. */
function environment(dir: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith("IMBEHIND_")) {
      env[name] = value;
    }
  }
  env.IMBEHIND_DIR = dir;
  return env;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits until the server answers the model list, or fails when it ends or takes too long. */
async function waitForServer(baseUrl: string, serve: ChildProcess, until: number): Promise<void> {
  while (Date.now() < until) {
    if (serve.exitCode !== null) {
      throw new Error(`serve ended early with exit code ${serve.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/v1/models`);
      if (response.ok) {
        return;
      }
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error("serve did not start in time");
}

/** Runs `imbehind answer` with the reply on standard input and returns its exit code. */
function answer(
  env: NodeJS.ProcessEnv,
  reply: string,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(process.execPath, [BIN, "answer"], {
    env,
    stdio: ["pipe", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  child.stdin?.end(`${reply}\n`);
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, stderr })));
}

interface Choice {
  message?: { content?: string | null; tool_calls?: unknown };
  finish_reason?: string;
}

/** Sends one request, answers it from standard input and returns the first choice of the response. */
async function exchange(
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  until: number,
  request: Record<string, unknown>,
  reply: string,
): Promise<Choice | undefined> {
  const pending = fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "whatever", ...request }),
    signal: AbortSignal.timeout(Math.max(1, until - Date.now())),
  });
  const sent = await answer(env, reply);
  if (sent.code !== 0) {
    throw new Error(`answer ended with exit code ${sent.code}: ${sent.stderr.trim()}`);
  }
  const body = (await (await pending).json()) as { choices?: Choice[] };
  return body.choices?.[0];
}

async function roundTrip(dir: string): Promise<void> {
  const until = Date.now() + LIMIT_MS;
  const env = environment(dir);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serve = spawn(process.execPath, [BIN, "serve", "--port", String(port)], {
    env,
    stdio: "ignore",
  });
  try {
    await waitForServer(baseUrl, serve, until);
    const messages = [{ role: "user", content: "Hello" }];
    const text = await exchange(env, baseUrl, until, { messages }, REPLY);
    if (text?.message?.content !== REPLY) {
      throw new Error(
        `the client got ${JSON.stringify(text?.message?.content)} instead of ${JSON.stringify(REPLY)}`,
      );
    }
    // A request with tools, answered with tool calls typed as the reply.
    const tools = [{ type: "function", function: { name: "get_weather" } }];
    const calls = [
      {
        id: "call_1",
        type: "function",
        function: { name: "get_weather", arguments: "{}" },
      },
    ];
    const called = await exchange(env, baseUrl, until, { messages, tools }, JSON.stringify(calls));
    if (
      called?.finish_reason !== "tool_calls" ||
      JSON.stringify(called.message?.tool_calls) !== JSON.stringify(calls)
    ) {
      throw new Error(`the client got ${JSON.stringify(called)} instead of the tool calls`);
    }
  } finally {
    serve.kill();
  }
}

const dir = await mkdtemp(path.join(tmpdir(), "imbehind-round-trip-"));
try {
  await roundTrip(dir);
  console.log("Round trip passed.");
} catch (error) {
  console.error(`Round trip failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
}
