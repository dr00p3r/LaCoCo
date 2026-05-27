import { describe, it, expect } from "vitest";
import { AgentIntermediary1 } from "../../src/retriever/utilities/mini-agents/agent-intermediary-1.js";

describe("AgentIntermediary1", () => {
  const intermediary = new AgentIntermediary1();

  describe("sanitize", () => {
    it("enruta prompts de código a RAG", () => {
      const result = intermediary.sanitize("refactoriza OrderService para usar async/await");
      expect(result.route).toBe("RAG");
    });

    it("enruta prompts genéricos a LLM_DIRECT", () => {
      const result = intermediary.sanitize("hola, buenos días");
      expect(result.route).toBe("LLM_DIRECT");
    });

    it("enruta prompts de debug a RAG", () => {
      const result = intermediary.sanitize("por qué falla el método save() en UserRepository");
      expect(result.route).toBe("RAG");
    });

    it("detecta intención de refactor", () => {
      const result = intermediary.sanitize("refactoriza la clase OrderService");
      expect(result.intent).toBe("refactor");
    });

    it("detecta intención de create", () => {
      const result = intermediary.sanitize("crea un endpoint POST /orders");
      expect(result.intent).toBe("create");
    });

    it("detecta intención de understand", () => {
      const result = intermediary.sanitize("qué hace la función calculateTaxes");
      expect(result.intent).toBe("understand");
    });

    it("detecta intención de debug", () => {
      const result = intermediary.sanitize("por qué falla el test de integración");
      expect(result.intent).toBe("debug");
    });

    it("normaliza la query para BM25", () => {
      const result = intermediary.sanitize("Refactoriza OrderService!!!");
      expect(result.clean_query).toBe("refactoriza OR orderservice");
    });

    it("usa keywords filtrados para embeddings", () => {
      const prompt = "Crea un DTO para crear pedidos";
      const result = intermediary.sanitize(prompt);
      expect(result.embedding_input).toBe("dto pedidos");
    });

    it("sugiere dimensiones basadas en keywords", () => {
      const result = intermediary.sanitize("hereda de BaseService e implementa IHandler");
      expect(result.dimensions).toContain("SYS");
    });

    it("asigna confidence entre 0 y 1", () => {
      const result = intermediary.sanitize("refactoriza OrderService");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});
