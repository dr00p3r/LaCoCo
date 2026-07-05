import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IctdStrategy } from "../../src/retriever/strategies/ictd-strategy.js";
import { ClcrStrategy } from "../../src/retriever/strategies/clcr-strategy.js";
import { RprStrategy } from "../../src/retriever/strategies/rpr-strategy.js";
import type { RecoveryStrategy } from "../../src/retriever/models/strategies/types.js";
import type { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { createGraphDb, makeQuery } from "./test-helpers.js";

vi.mock("../../src/embeddings/embedding-generator.js", () => {
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

  it("RPR deduplica por nodo terminal antes de aplicar el limite", async () => {
    db.insertNode({
      id: "file4#SharedTarget",
      kind: "TYPE",
      name: "SharedTarget",
      filepath: "/project/src/shared.ts",
      signature: "type SharedTarget = string",
      isDeprecated: 0,
    });
    db.insertEdge({
      sourceId: "file1#CreateOrderDto",
      targetId: "file4#SharedTarget",
      relation: "PRODUCES",
    });
    db.insertEdge({
      sourceId: "file3#Result",
      targetId: "file4#SharedTarget",
      relation: "CONSUMES_DATA",
    });
    db.populateMetadata();

    const chunks = await new RprStrategy(db, lanceDb, {
      anchorLimit: 10,
      maxDepth: 3,
      maxCandidates: 20,
      chunkLimit: 5,
    }).retrieve(makeQuery("no lexical match", ["CPG", "DTG"]));

    expect(chunks.map(({ nodeId }) => nodeId)).toHaveLength(
      new Set(chunks.map(({ nodeId }) => nodeId)).size,
    );
    const sharedTarget = chunks.find(({ nodeId }) => nodeId === "file4#SharedTarget");
    expect(sharedTarget).toBeDefined();
    expect(sharedTarget?.diagnostics?.duplicateCount).toBe(1);
    expect(sharedTarget?.path?.nodes.at(-1)).toBe("file4#SharedTarget");
  });
});
