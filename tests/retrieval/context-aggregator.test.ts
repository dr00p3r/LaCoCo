import { describe, it, expect } from "vitest";
import { ContextAggregator } from "../../src/retriever/utilities/filters/context-aggregator.js";
import type { ContextChunk } from "../../src/retriever/models/strategies/types.js";

describe("ContextAggregator", () => {
  const aggregator = new ContextAggregator();

  function chunk(
    nodeId: string,
    score: number,
    text: string,
    source = "BM25",
    chunkId = nodeId,
  ): ContextChunk {
    return { chunkId, nodeId, score, text, source };
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

    it("preserva caminos RPR distintos que terminan en el mismo nodo", () => {
      const chunks = [
        chunk("target", 0.9, "A --CALLS--> target", "RPR", "RPR:A>target"),
        chunk("target", 0.8, "B --CALLS--> target", "RPR", "RPR:B>target"),
      ];

      expect(aggregator.aggregate(chunks)).toHaveLength(2);
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
      // 1000 palabras "word " => ~1001 tokens con cl100k_base
      const longText = "word ".repeat(1000);
      const chunks: ContextChunk[] = [
        chunk("A", 0.9, longText),
        chunk("B", 0.8, longText),
        chunk("C", 0.7, longText),
        chunk("D", 0.6, longText),
      ];

      const result = aggregator.aggregate(chunks, 2000);
      // Cada chunk ~1001 tokens; con budget 2000 cabe 1
      expect(result.length).toBeLessThanOrEqual(2);
      expect(result.length).toBe(1);
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

    it("omite un chunk demasiado grande y conserva los siguientes que caben", () => {
      // 100 palabras "word " => ~101 tokens con cl100k_base
      // "short text" => 2 tokens
      // budget 10 -> no cabe A (~101), cabe B (2)
      const chunks: ContextChunk[] = [
        chunk("A", 0.9, "word ".repeat(100)),
        chunk("B", 0.8, "short text"),
      ];

      const result = aggregator.aggregate(chunks, 10);
      expect(result.map((item) => item.nodeId)).toEqual(["B"]);
    });

    it("cabe mas contenido que con la heuristica words/0.75 (delta de truncado)", () => {
      // Con la heuristica vieja, 1000 palabras = ~1333 tokens, budget 1000 -> 0 chunks.
      // Con cl100k_base, 1000 palabras = ~1001 tokens, budget 1000 -> 0 chunks tambien,
      // pero con budget 1100 cabe 1 chunk (antes no cabia).
      const longText = "word ".repeat(1000);
      const chunks: ContextChunk[] = [
        chunk("A", 0.9, longText),
        chunk("B", 0.8, longText),
      ];
      const result = aggregator.aggregate(chunks, 1100);
      expect(result.length).toBe(1);
    });
  });
});
