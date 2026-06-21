import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IctdStrategy } from "../../src/retriever/strategies/ictd-strategy.js";
import { ClcrStrategy } from "../../src/retriever/strategies/clcr-strategy.js";
import { RprStrategy } from "../../src/retriever/strategies/rpr-strategy.js";
import type { RecoveryStrategy } from "../../src/retriever/models/strategies/types.js";
import type { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { createGraphDb, makeQuery } from "./test-helpers.js";

describe("estrategias tensoriales", () => {
  let db: LaCoCoDatabase;

  beforeEach(() => {
    db = createGraphDb();
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
  }

  it("ICTD difunde relevancia desde anclas BM25", async () => {
    await expectStrategyResults(
      new IctdStrategy(db, { anchorLimit: 10, maxIterations: 3 }),
      "ICTD"
    );
  });

  it("CLCR recupera nodos conectados entre capas", async () => {
    await expectStrategyResults(
      new ClcrStrategy(db, { anchorLimit: 10, primaryHops: 1, cascadeHops: 1 }),
      "CLCR"
    );
  });

  it("RPR recupera caminos relacionales", async () => {
    const chunks = await new RprStrategy(db, {
      anchorLimit: 10,
      maxDepth: 2,
      maxCandidates: 20,
    }).retrieve(makeQuery("OrderService", ["CPG"]));

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.source).toBe("RPR");
    expect(chunks[0]!.text).toContain("relations:");
  });
});
