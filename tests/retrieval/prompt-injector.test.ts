import { describe, it, expect } from "vitest";
import { PromptInjector } from "../../src/retriever/utilities/filters/prompt-injector.js";
import type { ContextChunk } from "../../src/retriever/models/strategies/types.js";

describe("PromptInjector", () => {
  const injector = new PromptInjector();

  function chunk(nodeId: string, score: number, text: string, source = "BM25"): ContextChunk {
    return { chunkId: nodeId, nodeId, score, text, source };
  }

  describe("inject", () => {
    it("inyecta chunks en una sección separada del prompt", () => {
      const prompt = "Refactoriza OrderService";
      const chunks = [chunk("OrderService", 0.9, "class OrderService {}")];

      const result = injector.inject(prompt, chunks);
      expect(result).toContain("### Contexto del Proyecto");
      expect(result).toContain("class OrderService {}");
      expect(result).toContain(prompt);
    });

    it("mantiene el prompt original intacto", () => {
      const prompt = "crea un endpoint";
      const chunks = [chunk("A", 0.5, "texto")];

      const result = injector.inject(prompt, chunks);
      expect(result.endsWith(prompt)).toBe(true);
    });

    it("no inyecta nada si chunks está vacío", () => {
      const prompt = "pregunta simple";
      const result = injector.inject(prompt, []);
      expect(result).toBe(prompt);
    });

    it("enumera múltiples chunks con numeración", () => {
      const chunks: ContextChunk[] = [
        chunk("A", 0.9, "class A {}"),
        chunk("B", 0.8, "function b() {}"),
      ];

      const result = injector.inject("refactoriza", chunks);
      expect(result).toContain("[1]");
      expect(result).toContain("[2]");
      expect(result).toContain("class A {}");
      expect(result).toContain("function b() {}");
    });

    it("lanza error si la versión del template no existe", () => {
      expect(() => injector.inject("prompt", [], "v999")).toThrow("desconocido");
    });
  });
});
