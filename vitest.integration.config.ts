import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 60_000,
    include: [
      "tests/**/*.integration.test.ts",
      "tests/**/*e2e*.test.ts",
    ],
    exclude: [
      "eval/workdir/**",
      "eval/runs/**",
    ],
  },
});
