import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "tests/**/*.test.ts",
      "eval/scripts/**/*.test.ts",
    ],
    exclude: [
      "eval/workdir/**",
      "eval/runs/**",
    ],
  },
});
