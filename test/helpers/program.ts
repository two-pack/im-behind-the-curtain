import { type ChildProcess, spawn } from "node:child_process";

/** A program that the test started as a separate process. */
export interface Running {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  /** The exit code, once the process has ended and its output is complete. */
  exit: Promise<number | null>;
}

/** Starts `node <script> <args>` and collects its output. */
export function runNode(script: string, args: string[], env: NodeJS.ProcessEnv): Running {
  const child = spawn(process.execPath, [script, ...args], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exit = new Promise<number | null>((resolve) => child.on("close", (code) => resolve(code)));
  return { child, stdout: () => stdout, stderr: () => stderr, exit };
}
