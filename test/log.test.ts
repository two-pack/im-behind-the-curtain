import { describe, expect, it } from "vitest";
import { IO_REASONS } from "../src/errors.js";
import { Logger, Screen } from "../src/log.js";
import { FakeClock } from "./helpers/fake-clock.js";

function setup() {
  const out: string[] = [];
  const err: string[] = [];
  const clock = new FakeClock(new Date(2026, 9, 9, 14, 5, 12).getTime());
  const logger = new Logger({
    out: { write: (text) => out.push(text) },
    err: { write: (text) => err.push(text) },
    clock,
  });
  return { out, err, clock, logger };
}

describe("serve log lines (NFR10.4)", () => {
  it("writes the listening line with the address and the storage directory", () => {
    const { out, logger } = setup();
    logger.listening("127.0.0.1", 3000, "/home/alice/.local/share/imbehind");
    expect(out).toEqual([
      "Listening on http://127.0.0.1:3000 (storage: /home/alice/.local/share/imbehind)\n",
    ]);
  });

  it("writes received and replied lines with a local time and the short id", () => {
    const { out, logger } = setup();
    logger.received("a1b2c3", "text", false);
    logger.replied("a1b2c3");
    expect(out).toEqual([
      "14:05:12 received   a1b2c3  chat/completions  text\n",
      "14:05:12 replied    a1b2c3\n",
    ]);
  });

  it("pads the event to ten columns and puts two spaces before the detail", () => {
    const { out, logger } = setup();
    logger.received("a1b2c3", "text", false);
    logger.replied("a1b2c3");
    logger.failure("a1b2c3", "read failed");
    const columns = out.map((line) => line.slice("14:05:12 ".length));
    // The short id starts in the same column on every line.
    expect(columns.map((line) => line.indexOf("a1b2c3"))).toEqual([11, 11, 11]);
    expect(columns.map((line) => line.slice(0, 11))).toEqual([
      "received   ",
      "replied    ",
      "error      ",
    ]);
  });

  it("writes the skipped, cancelled and timed_out lines", () => {
    const { out, logger } = setup();
    logger.skipped("e0f1a2");
    logger.cancelled("d4e5f6");
    logger.timedOut("b7c8d9");
    expect(out).toEqual([
      "14:05:12 skipped    e0f1a2\n",
      "14:05:12 cancelled  d4e5f6  client disconnected\n",
      "14:05:12 timed_out  b7c8d9\n",
    ]);
  });

  it("puts the short id of the new lines in the same column, and replaces a bad id", () => {
    const { out, logger } = setup();
    logger.skipped("a1b2c3");
    logger.cancelled("a1b2c3");
    logger.timedOut("a1b2c3");
    expect(out.map((line) => line.indexOf("a1b2c3"))).toEqual([20, 20, 20]);
    logger.skipped("not-an-id");
    expect(out[3]).toBe("14:05:12 skipped    ------\n");
  });

  it("uses the time of the clock for each line", async () => {
    const { out, clock, logger } = setup();
    await clock.advance(61_000);
    logger.replied("a1b2c3");
    expect(out).toEqual(["14:06:13 replied    a1b2c3\n"]);
  });

  it("writes a startup failure to standard error as an Error line", () => {
    const { out, err, logger } = setup();
    logger.startupError("port 3000 is already in use.");
    expect(err).toEqual(["Error: port 3000 is already in use.\n"]);
    expect(out).toEqual([]);
  });
});

describe("failure lines (NFR10.1 to NFR10.5)", () => {
  it("writes the short id and a fixed reason", () => {
    const { out, logger } = setup();
    logger.failure("a1b2c3", "write failed");
    expect(out).toEqual(["14:05:12 error      a1b2c3  write failed\n"]);
  });

  it("writes the reason unreadable for a file whose content cannot be read", () => {
    const { out, logger } = setup();
    logger.failure("a1b2c3", "unreadable");
    logger.failure("a1b2c3", "unreadable");
    expect(out).toEqual(["14:05:12 error      a1b2c3  unreadable\n"]);
  });

  it("lists the unreadable reason among the fixed reasons", () => {
    expect(IO_REASONS).toContain("unreadable");
  });

  it("writes a failure that has no request id with a placeholder", () => {
    const { out, logger } = setup();
    logger.failure(undefined, "read failed");
    expect(out).toEqual(["14:05:12 error      ------  read failed\n"]);
  });

  it("writes the same failure of the same request only the first time", () => {
    const { out, logger } = setup();
    logger.failure("a1b2c3", "read failed");
    logger.failure("a1b2c3", "read failed");
    logger.failure("a1b2c3", "read failed");
    expect(out).toHaveLength(1);
  });

  it("writes a different reason, or a different request, again", () => {
    const { out, logger } = setup();
    logger.failure("a1b2c3", "read failed");
    logger.failure("a1b2c3", "write failed");
    logger.failure("d4e5f6", "read failed");
    expect(out).toHaveLength(3);
  });

  it("writes the failure again after the request recovered", () => {
    const { out, logger } = setup();
    logger.failure("a1b2c3", "read failed");
    logger.recovered("a1b2c3");
    logger.failure("a1b2c3", "read failed");
    expect(out).toHaveLength(2);
    logger.failure(undefined, "read failed");
    logger.recovered(undefined);
    logger.failure(undefined, "read failed");
    expect(out).toHaveLength(4);
  });

  it("has no way to take free text, so request content cannot reach the log", () => {
    const { out, logger } = setup();
    // @ts-expect-error a reason must be one of the fixed phrases
    logger.failure("a1b2c3", "SECRET-CONTENT-12345");
    // @ts-expect-error received takes only a reply kind and a stream flag
    logger.received("a1b2c3", "SECRET-CONTENT-12345", "SECRET-CONTENT-12345");
    logger.replied("SECRET-CONTENT-12345");
    expect(out.join("")).not.toContain("SECRET-CONTENT-12345");
    expect(out).toEqual([
      "14:05:12 error      a1b2c3  failed\n",
      "14:05:12 received   a1b2c3  chat/completions  text\n",
      "14:05:12 replied    ------\n",
    ]);
  });
});

describe("the received line supplement", () => {
  it("shows the reply kind, and stream only when the request streams", () => {
    const { out, logger } = setup();
    logger.received("a1b2c3", "text", false);
    logger.received("a1b2c3", "json", false);
    logger.received("a1b2c3", "json", true);
    logger.received("a1b2c3", "text", true);
    expect(out).toEqual([
      "14:05:12 received   a1b2c3  chat/completions  text\n",
      "14:05:12 received   a1b2c3  chat/completions  json\n",
      "14:05:12 received   a1b2c3  chat/completions  json  stream\n",
      "14:05:12 received   a1b2c3  chat/completions  text  stream\n",
    ]);
  });
});

describe("screen writer (NFR14.1)", () => {
  it("writes one line per call, with no color codes", () => {
    const out: string[] = [];
    const screen = new Screen({ write: (text) => out.push(text) });
    screen.line("Sent.");
    screen.line("Error: input closed.");
    expect(out).toEqual(["Sent.\n", "Error: input closed.\n"]);
    expect(out.join("").includes("\u001b")).toBe(false);
  });
});
