import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 20_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // src/bin.ts is a one-line launcher that only calls main() from src/cli.ts.
      // The behavior behind it is covered through src/cli.ts and by spawning dist/bin.js.
      exclude: ["src/bin.ts"],
      reporter: ["text", "json-summary"],
      reportsDirectory: "coverage",
      thresholds: {
        lines: 80,
        branches: 80,
      },
    },
  },
});
