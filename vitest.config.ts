import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  test: {
    // src/generated/ui-html.ts is a gitignored build artifact; tests that
    // import src/server.ts use this stub instead of requiring a UI build.
    alias: [
      {
        find: /^.*generated\/ui-html\.js$/,
        replacement: fileURLToPath(new URL("./tests/stubs/ui-html.ts", import.meta.url)),
      },
    ],
    globals: true,
    environment: "node",
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      exclude: [
        "node_modules/**",
        "dist/**",
        "tests/**",
        "*.config.ts",
        "**/*.d.ts",
      ],
    },
    include: ["tests/**/*.test.ts"],
    exclude: ["node_modules", "dist"],
  },
});
