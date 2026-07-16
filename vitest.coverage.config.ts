import { defineConfig } from "vitest/config";

// Configuración de COBERTURA: corre la suite completa (unitarias + integración +
// E2E) sobre el código de producto (`src/`) para reportar una única cifra de
// cobertura reproducible. Se usa vía `pnpm test:coverage`.
export default defineConfig({
  test: {
    testTimeout: 60_000,
    include: [
      "tests/**/*.test.ts",
      "eval/scripts/**/*.test.ts",
    ],
    exclude: [
      "eval/workdir/**",
      "eval/runs/**",
    ],
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**/*.ts"],
      // Se excluyen del cómputo de cobertura dos subsistemas fuera del alcance
      // funcional del producto evaluado:
      //   1. La feature C2 "propositions" (recuperación por proposiciones doc-side):
      //      está APARCADA tras el flag `LACOCO_PROPOSITIONS` (apagado por defecto);
      //      no forma parte del pipeline por defecto. (El enricher de proposiciones
      //      del semantic-profile SÍ se mide, porque sí está en uso y probado.)
      //   2. El subsistema de visualización `inspect` (render HTML/cytoscape del
      //      grafo): herramienta auxiliar de depuración, no lógica de producto.
      exclude: [
        "src/indexer/propositions-indexer.ts",
        "src/persistence/lacoco-propositions-manager/**",
        "src/cli/inspect.ts",
        "src/cli/inspect/**",
      ],
      reporter: ["text-summary", "html", "json-summary"],
      reportsDirectory: "coverage",
    },
  },
});
