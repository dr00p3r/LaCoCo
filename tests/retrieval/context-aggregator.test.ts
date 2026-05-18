import { describe, it, expect } from "vitest";
import { ContextAggregator } from "../../src/retriever/context-aggregator.js";
import type { ContextChunk } from "../../src/retriever/strategies/base.js";

describe("ContextAggregator", () => {
  const aggregator = new ContextAggregator();

  function chunk(nodeId: string, score: number, text: string, source = "BM25"): ContextChunk {
    return { nodeId, score, text, source };
  }

  describe("deduplicación", () => {
    it("elimina duplicados por nodeId conservando mayor score", () => {
      const chunks: ContextChunk[] = [
        chunk("A", 0.8, "texto A", "BM25"),
        chunk("A", 0.5, "texto A dup", "ANN"),
        chunk("B", 0.7, "texto B"),
      ];

      const result = aggregator.aggregate(chunks);
      expect(result).toHaveLength(2);
      expect(result[0]!.nodeId).toBe("A");
      expect(result[0]!.score).toBe(0.8);
    });

    it("prioriza el chunk con mayor score independientemente del orden", () => {
      const chunks: ContextChunk[] = [
        chunk("A", 0.3, "bajo", "ANN"),
        chunk("A", 0.9, "alto", "BM25"),
      ];

      const result = aggregator.aggregate(chunks);
      expect(result[0]!.score).toBe(0.9);
    });
  });

  describe("ordenamiento", () => {
    it("ordena por score descendente", () => {
      const chunks: ContextChunk[] = [
        chunk("C", 0.3, "texto C"),
        chunk("A", 0.9, "texto A"),
        chunk("B", 0.6, "texto B"),
      ];

      const result = aggregator.aggregate(chunks);
      expect(result[0]!.nodeId).toBe("A");
      expect(result[1]!.nodeId).toBe("B");
      expect(result[2]!.nodeId).toBe("C");
    });
  });

  describe("truncado por tokens", () => {
    it("trunca cuando la suma estimada supera maxTokens", () => {
      const longText = "word ".repeat(1000); // ~1000 palabras ≈ 1333 tokens
      const chunks: ContextChunk[] = [
        chunk("A", 0.9, longText),
        chunk("B", 0.8, longText),
        chunk("C", 0.7, longText),
        chunk("D", 0.6, longText),
      ];

      const result = aggregator.aggregate(chunks, 2000);
      // Cada chunk ~1333 tokens, así que solo cabe 1
      expect(result.length).toBeLessThanOrEqual(2);
    });

    it("no trunca si todos los chunks caben", () => {
      const chunks: ContextChunk[] = [
        chunk("A", 0.9, "short"),
        chunk("B", 0.8, "tiny"),
      ];

      const result = aggregator.aggregate(chunks, 4000);
      expect(result).toHaveLength(2);
    });

    it("devuelve array vacío si maxTokens es 0", () => {
      const chunks: ContextChunk[] = [chunk("A", 0.9, "any text")];
      const result = aggregator.aggregate(chunks, 0);
      expect(result).toHaveLength(0);
    });
  });
});
