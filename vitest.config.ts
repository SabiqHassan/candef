import { defineConfig } from "vitest/config";

// The V1 prototype is a preserved reference with its own toolchain; never run its tests from the root.
export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "experiments/**",
      "research-cache/**",
      ".preview/**",
      "**/*.pw.ts",
      "tests/e2e/**",
    ],
  },
});
