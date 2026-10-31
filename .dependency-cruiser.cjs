/**
 * Dependency rules for src/. They follow the module graph of the design:
 *
 *   cli            -> config, http, answer-console, broker, store, serve-lock, sweeper, log, clock,
 *                     platform
 *   http           -> chat-completions, broker, log
 *   answer-console -> broker, log, clock, platform, conversation-view
 *   broker         -> store, clock, reply-check, reply-file-check
 *   reply-file-check -> reply-check
 *   sweeper        -> broker, clock
 *   log            -> clock
 *   store          -> platform
 *   serve-lock     -> platform
 *   config         -> platform
 *   bin            -> cli, platform
 *
 * errors, ids, media-parts, model and tool-calls are leaf modules that any module may use. A leaf
 * module may import another leaf module, but never a module that is not a leaf, and leaf modules
 * never form a cycle (tool-calls and media-parts import model; model imports nothing). clock
 * imports nothing from the project (no rule allows it). chat-completions, platform, reply-check
 * and conversation-view import only the leaf modules. serve-lock imports only platform and the
 * leaf modules. Type-only imports count as dependencies. Cycles are never allowed.
 */

const LEAVES = "errors|ids|media-parts|model|tool-calls";
const LEAF_PATH = "^src/(" + LEAVES + ")\\.ts$";

/** Builds an allowed-dependency rule: `from` may import `targets` and the leaf modules. */
function allow(from, targets) {
  const list = [LEAVES, ...targets].join("|");
  return {
    comment: `src/${from}.ts may import only: ${[...targets, "the leaf modules"].join(", ")}`,
    from: { path: `^src/${from}\\.ts$` },
    to: { path: `^src/(${list})\\.ts$` },
  };
}

/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      comment: "Modules must not depend on each other in a cycle.",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-runtime-dependencies",
      severity: "error",
      comment: "The program has no runtime dependencies. Use Node.js built-in modules only.",
      from: { path: "^src" },
      to: {
        dependencyTypes: [
          "npm",
          "npm-dev",
          "npm-optional",
          "npm-peer",
          "npm-bundled",
          "npm-no-pkg",
          "npm-unknown",
        ],
      },
    },
    {
      name: "src-does-not-use-tests",
      severity: "error",
      comment: "Product code must not import test code.",
      from: { path: "^src" },
      to: { path: "^test" },
    },
  ],
  allowed: [
    {
      comment: "Node.js built-in modules may be used anywhere in src.",
      from: { path: "^src" },
      to: { dependencyTypes: ["core"] },
    },
    {
      comment: "A leaf module may import another leaf module. The no-circular rule forbids cycles.",
      from: { path: LEAF_PATH },
      to: { path: LEAF_PATH },
    },
    allow("cli", [
      "config",
      "http/server",
      "answer/answer-console",
      "broker/exchange-broker",
      "store/exchange-store",
      "store/serve-lock",
      "sweeper/sweeper",
      "log",
      "clock",
      "platform",
    ]),
    allow("bin", ["cli", "platform"]),
    allow("config", ["platform"]),
    allow("log", ["clock"]),
    allow("platform", []),
    allow("http/server", ["chat-completions/adapter", "broker/exchange-broker", "log"]),
    allow("answer/answer-console", [
      "answer/conversation-view",
      "broker/exchange-broker",
      "log",
      "clock",
      "platform",
    ]),
    allow("answer/conversation-view", []),
    allow("broker/exchange-broker", [
      "store/exchange-store",
      "clock",
      "broker/reply-check",
      "broker/reply-file-check",
    ]),
    allow("broker/reply-check", []),
    allow("broker/reply-file-check", ["broker/reply-check"]),
    allow("store/exchange-store", ["platform"]),
    allow("store/serve-lock", ["platform"]),
    allow("sweeper/sweeper", ["broker/exchange-broker", "clock"]),
    allow("chat-completions/adapter", []),
  ],
  allowedSeverity: "error",
  options: {
    doNotFollow: { path: "node_modules" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.json" },
    enhancedResolveOptions: {
      exportsFields: ["exports"],
      conditionNames: ["import", "require", "node", "default"],
      extensions: [".ts", ".js"],
    },
  },
};
