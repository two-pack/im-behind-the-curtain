import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Puts a `serve.lock` in the storage directory as a running serve would: the process of the test
 * (which is alive) and a heartbeat of this moment. `imbehind answer` needs it to start. The
 * directory and its requests/ folder, which a running serve has made, are made when missing.
 */
export async function placeRunningLock(rootDir: string, now: Date = new Date()): Promise<void> {
  await mkdir(path.join(rootDir, "requests"), { recursive: true });
  await writeFile(
    path.join(rootDir, "serve.lock"),
    `${JSON.stringify(
      {
        formatVersion: 1,
        processId: process.pid,
        startedAt: now.toISOString(),
        heartbeatAt: now.toISOString(),
      },
      null,
      2,
    )}\n`,
  );
}
