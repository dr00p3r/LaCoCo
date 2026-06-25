import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IctdStrategy } from "../../src/retriever/strategies/ictd-strategy.js";
import { ClcrStrategy } from "../../src/retriever/strategies/clcr-strategy.js";
import { RprStrategy } from "../../src/retriever/strategies/rpr-strategy.js";
import type { RecoveryStrategy } from "../../src/retriever/models/strategies/types.js";
import type { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { createGraphDb, makeQuery } from "./test-helpers.js";

vi.mock("../../src/retriever/utilities/embeddings/embedding-generator.js", () => {
  class MockEmbeddingGenerator {
    generate = vi.fn().mockResolvedValue(new Float32Array(384));
  }
  return { EmbeddingGenerator: MockEmbeddingGenerator };
});

describe("estrategias tensoriales", () => {
  let db: LaCoCoDatabase;
  let search: ReturnType<typeof vi.fn>;
  let lanceDb: LaCoCoLanceDb;

  beforeEach(() => {
    db = createGraphDb();
    search = vi.fn().mockResolvedValue([
      { node_id: "file1#OrderService.createOrder", score: 0.9 },
    ]);
    lanceDb = { search } as unknown as LaCoCoLanceDb;
  });

  afterEach(() => {
    db.close();
  });

  async function expectStrategyResults(
    strategy: RecoveryStrategy,
    source: string
  ): Promise<void> {
    const chunks = await strategy.retrieve(makeQuery("OrderService", ["CPG"]));

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.source).toBe(source);
    expect(chunks[0]!.score).toBeGreaterThan(0);
    expect(search).toHaveBeenCalledWith(expect.any(Float32Array), undefined, 10);
  }

  it("ICTD difunde relevancia desde anclas hibridas", async () => {
    await expectStrategyResults(
      new IctdStrategy(db, lanceDb, { anchorLimit: 10, maxIterations: 3 }),
      "ICTD"
    );
  });

  it("CLCR recupera nodos conectados entre capas", async () => {
    await expectStrategyResults(
      new ClcrStrategy(db, lanceDb, { anchorLimit: 10, primaryHops: 1, cascadeHops: 1 }),
      "CLCR"
    );
  });

  it("RPR recupera caminos relacionales", async () => {
    const chunks = await new RprStrategy(db, lanceDb, {
      anchorLimit: 10,
      maxDepth: 2,
      maxCandidates: 20,
    }).retrieve(makeQuery("OrderService", ["CPG"]));

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.source).toBe("RPR");
    expect(chunks[0]!.text).toContain("relations:");
    expect(search).toHaveBeenCalledWith(expect.any(Float32Array), undefined, 10);
  });
});
