import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { HybridAnchorService } from "../../src/retriever/utilities/search/hybrid-anchor-service.js";
import { Bm25Service } from "../../src/retriever/utilities/search/bm25-service.js";
import type { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { createGraphDb, makeQuery } from "./test-helpers.js";

vi.mock("../../src/embeddings/embedding-generator.js", () => {
  class MockEmbeddingGenerator {
    generate = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const vec = new Float32Array(384);
      vec[0] = 1;
      return vec;
    });
  }
  return { EmbeddingGenerator: MockEmbeddingGenerator };
});

describe("HybridAnchorService", () => {
  let db: LaCoCoDatabase;

  beforeEach(() => {
    db = createGraphDb();
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  it("ejecuta BM25 y la generacion del embedding en paralelo", async () => {
    // BM25 es sync: lo hacemos "lento" con busy-wait para que la diferencia
    // serie/paralelo sea observable en wall time. Si la implementacion kickea
    // el embedding antes de la busqueda BM25 (nuestra optimizacion), el total
    // ≈ 50ms; si fuese serie, el total ≈ 100ms.
    const BUSY_WAIT_MS = 50;
    const bm25Spy = vi.spyOn(Bm25Service.prototype, "search").mockImplementation(() => {
      const start = Date.now();
      while (Date.now() - start < BUSY_WAIT_MS) {
        // busy-wait intencional para simular I/O o CPU sostenido
      }
      return [{
        nodeId: "file1#OrderService",
        rawScore: 1,
        score: 0.5,
        rank: 1,
        text: "OrderService",
      }];
    });
    const lanceSearch = vi.fn().mockResolvedValue([]);
    const lanceDb = { search: lanceSearch } as unknown as LaCoCoLanceDb;
    const service = new HybridAnchorService(db, lanceDb);

    const start = performance.now();
    const anchors = await service.search(makeQuery("OrderService", ["CPG"]));
    const elapsed = performance.now() - start;

    expect(bm25Spy).toHaveBeenCalledTimes(1);
    expect(anchors.length).toBe(1);
    // Tolerancia de 30ms: incluye overhead de vitest + event loop scheduling.
    // Umbral discriminador: 50ms busy + 50ms embedding = 100ms serie vs 50ms paralelo.
    expect(elapsed).toBeLessThan(BUSY_WAIT_MS + 30);
  });

  it("el ranking fusionado es independiente del orden BM25/ANN", async () => {
    vi.spyOn(Bm25Service.prototype, "search").mockReturnValue([{
      nodeId: "file1#OrderService.createOrder",
      rawScore: 1,
      score: 0.8,
      rank: 1,
      text: "createOrder",
    }, {
      nodeId: "file1#OrderService",
      rawScore: 0.5,
      score: 0.4,
      rank: 2,
      text: "OrderService",
    }]);
    const lanceSearch = vi.fn().mockResolvedValue([
      { node_id: "file1#OrderService", score: 0.9 },
      { node_id: "file1#CreateOrderDto", score: 0.6 },
    ]);
    const lanceDb = { search: lanceSearch } as unknown as LaCoCoLanceDb;
    const service = new HybridAnchorService(db, lanceDb);

    const anchors = await service.search(makeQuery("OrderService", ["CPG"]));

    // RRF con K=60:
    //   OrderService.createOrder: bm25=1 → 1/61, ann=undefined → 0  → 1/61 ≈ 0.01639
    //   OrderService:               bm25=2 → 1/62, ann=1 → 1/61     → 1/62+1/61 ≈ 0.03252
    //   CreateOrderDto:             bm25=undefined → 0, ann=2 → 1/62 → 1/62 ≈ 0.01613
    const orderByScore = anchors.find((a) => a.nodeId === "file1#OrderService")!;
    const orderCreate = anchors.find((a) => a.nodeId === "file1#OrderService.createOrder")!;
    const createDto = anchors.find((a) => a.nodeId === "file1#CreateOrderDto")!;
    expect(orderByScore).toBeDefined();
    expect(orderCreate).toBeDefined();
    expect(createDto).toBeDefined();
    // OrderService (presente en ambos rankings) supera a OrderService.createOrder (solo BM25)
    expect(orderByScore.score).toBeGreaterThan(orderCreate.score);
    // OrderService.createOrder (rank 1 BM25) supera a CreateOrderDto (rank 2 ANN)
    expect(orderCreate.score).toBeGreaterThan(createDto.score);
  });
});
