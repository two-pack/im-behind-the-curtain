import { describe, expect, it } from "vitest";
import { runNode } from "../helpers/program.js";

const SCRIPT = "test/tools/round-trip.ts";

describe("npm run round-trip: one request through the built program (FR12.5)", () => {
  it("starts serve, sends one request, answers it and ends with exit code 0", async () => {
    const program = runNode(SCRIPT, [], process.env);
    expect(await program.exit).toBe(0);
    expect(program.stdout().trim().split("\n").pop()).toBe("Round trip passed.");
    expect(program.stderr()).toBe("");
  }, 90_000);

  it("ignores IMBEHIND_ variables of the person who runs it", async () => {
    const env = { ...process.env, IMBEHIND_PORT: "1", IMBEHIND_DIR: "/nonexistent/place" };
    const program = runNode(SCRIPT, [], env);
    expect(await program.exit).toBe(0);
    expect(program.stdout()).toContain("Round trip passed.");
  }, 90_000);
});
