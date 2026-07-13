import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Default 5s no es suficiente para el E2E CLI: el test lanza
    // `execFileSync` con timeout interno de 30s, pero el test mismo muere a
    // los 5s antes de llegar al catch que detecta EPERM y llama
    // `context.skip()`. 60s da margen para que la CLI arranque, indexe y
    // reporte el fallo de permisos sin que el test se suicide por timeout.
    testTimeout: 60_000,
    include: [
      "tests/**/*.test.ts",
      "eval/scripts/**/*.test.ts",
    ],
    exclude: [
      "eval/workdir/**",
      "eval/runs/**",
      "tests/**/*.integration.test.ts",
      "tests/**/*e2e*.test.ts",
    ],
  },
});
