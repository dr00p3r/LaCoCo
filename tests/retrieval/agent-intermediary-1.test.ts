import { describe, it, expect, vi } from "vitest";
import { AgentIntermediary1 } from "../../src/retriever/utilities/mini-agents/agent-intermediary/index.js";

vi.mock("../../src/retriever/utilities/mini-agents/agent-intermediary/classifier.js", () => {
  class MockSlmClassifier {
    classify = vi.fn().mockResolvedValue({
      route: "RAG",
      intent: "refactor",
      dimensions: ["CPG"],
      confidence: 0.9,
    });
  }
  return { SlmClassifier: MockSlmClassifier };
});

describe("AgentIntermediary1", () => {
  const intermediary = new AgentIntermediary1();

  describe("sanitize", () => {
    it("clasifica como RAG cuando hay referencias a código", async () => {
      const result = await intermediary.sanitize("refactoriza OrderService para usar async/await");
      expect(result.route).toBe("RAG");
    });

    it("clasifica como RAG con consulta de debug", async () => {
      const result = await intermediary.sanitize("por qué falla el método save() en UserRepository");
      expect(result.route).toBe("RAG");
    });

    it("clasifica como RAG con keyword de refactor", async () => {
      const result = await intermediary.sanitize("refactoriza la clase OrderService");
      expect(result.route).toBe("RAG");
    });

    it("clasifica como RAG con keyword de crear", async () => {
      const result = await intermediary.sanitize("crea un endpoint POST /orders");
      expect(result.route).toBe("RAG");
    });

    it("clasifica como RAG con keyword de entender", async () => {
      const result = await intermediary.sanitize("qué hace la función calculateTaxes");
      expect(result.route).toBe("RAG");
    });

    it("clasifica como RAG con keyword de error", async () => {
      const result = await intermediary.sanitize("por qué falla el test de integración");
      expect(result.route).toBe("RAG");
    });

    it("normaliza la query para BM25", async () => {
      const result = await intermediary.sanitize("Refactoriza OrderService!!!");
      expect(result.clean_query).toBe("refactoriza OR orderservice");
    });

    it("usa keywords filtrados para embeddings", async () => {
      const prompt = "Crea un DTO para crear pedidos";
      const result = await intermediary.sanitize(prompt);
      expect(result.embedding_input).toBe("dto pedidos");
    });

    it("sugiere dimensiones basadas en keywords", async () => {
      const result = await intermediary.sanitize("hereda de BaseService e implementa IHandler");
      expect(result.dimensions).toBeDefined();
    });

    it("retorna confidence en rango 0-1", async () => {
      const result = await intermediary.sanitize("refactoriza OrderService");
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });
  });
});
