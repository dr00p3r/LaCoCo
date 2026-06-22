import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HybridStrategy } from "../../src/retriever/strategies/hybrid-strategy.js";
import type { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { createGraphDb, makeQuery } from "./test-helpers.js";

vi.mock("../../src/retriever/utilities/embeddings/embedding-generator.js", () => {
  class MockEmbeddingGenerator {
    generate = vi.fn().mockResolvedValue(new Float32Array(384));
  }
  return { EmbeddingGenerator: MockEmbeddingGenerator };
});

describe("HybridStrategy", () => {
  let db: LaCoCoDatabase;

  beforeEach(() => {
    db = createGraphDb();
  });

  afterEach(() => {
    db.close();
  });

  it("fusiona BM25 y ANN sin aplicar filtro dimensional", async () => {
    const search = vi.fn().mockResolvedValue([
      { node_id: "file1#OrderService.createOrder", score: 0.9 },
    ]);
    const lanceDb = { search } as unknown as LaCoCoLanceDb;
    const strategy = new HybridStrategy(db, lanceDb);

    const chunks = await strategy.retrieve(makeQuery("OrderService", ["CPG"]));

    expect(search).toHaveBeenCalledWith(
      expect.any(Float32Array),
      undefined,
      20
    );
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.source).toBe("RRF");
  });

  it("mantiene ANN sin filtro aunque se consulten todas las dimensiones", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const lanceDb = { search } as unknown as LaCoCoLanceDb;
    const strategy = new HybridStrategy(db, lanceDb);

    await strategy.retrieve(makeQuery("OrderService", ["SYS", "CPG", "DTG"]));

    expect(search).toHaveBeenCalledWith(expect.any(Float32Array), undefined, 20);
  });
});
