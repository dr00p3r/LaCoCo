import { describe, it, expect } from "vitest";
import { DimensionalFilter } from "../../src/retriever/dimensional-filter.js";
import type { SanitizerOutput } from "../../src/retriever/strategies/base.js";

describe("DimensionalFilter", () => {
  const filter = new DimensionalFilter(0.65);

  function makeQuery(text: string, dims: ("SYS" | "CPG" | "DTG")[] = []): SanitizerOutput {
    return {
      route: "RAG",
      clean_query: text.toLowerCase(),
      embedding_input: text,
      dimensions: dims,
      intent: "understand",
      confidence: 0.8,
    };
  }

  describe("heuristic filter (nivel 1)", () => {
    it("clasifica SYS cuando se menciona herencia", async () => {
      const result = await filter.filter(makeQuery("clase OrderService hereda de BaseService"));
      expect(result).toContain("SYS");
    });

    it("clasifica CPG cuando se menciona inyección", async () => {
      const result = await filter.filter(makeQuery("inyecta el repositorio en el constructor"));
      expect(result).toContain("CPG");
    });

    it("clasifica DTG cuando se menciona DTO", async () => {
      const result = await filter.filter(makeQuery("dto de entrada para crear pedidos"));
      expect(result).toContain("DTG");
    });

    it("clasifica múltiples dimensiones cuando hay keywords mixtas", async () => {
      const result = await filter.filter(
        makeQuery("clase que hereda de Base e inyecta Repository")
      );
      expect(result).toContain("SYS");
      expect(result).toContain("CPG");
    });

    it("defaultea a CPG cuando no hay keywords claras", async () => {
      const result = await filter.filter(makeQuery("función auxiliar de utilidad"));
      expect(result).toEqual(["CPG"]);
    });

    it("respeta el orden de relevancia (mayor score primero)", async () => {
      const result = await filter.filter(
        makeQuery("hereda de BaseService y usa DTOs")
      );
      // SYS debería tener más peso que DTG en este caso por keyword directa
      expect(result[0]).toBe("SYS");
    });
  });
});
