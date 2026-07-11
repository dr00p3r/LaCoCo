import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ConnectorStrategy } from "../../src/retriever/strategies/connector-strategy.js";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { makeQuery } from "./test-helpers.js";

vi.mock("../../src/embeddings/embedding-generator.js", () => {
  class MockEmbeddingGenerator {
    generate = vi.fn().mockResolvedValue(new Float32Array(384));
  }
  return { EmbeddingGenerator: MockEmbeddingGenerator };
});

/**
 * Grafo con un CONECTOR claro: dos anclas (compA, compB) que ambas llaman a un
 * helper interno compartido (fileH#helper). El helper NO es ancla, pero conecta
 * los dos síntomas → Structural Connector Retrieval debe surfacearlo.
 */
function createConnectorGraph(): LaCoCoDatabase {
  const db = new LaCoCoDatabase(":memory:");
  const node = (id: string, name: string, kind = "FUNCTION") =>
    db.insertNode({ id, kind, name, filepath: `/src/${name}.ts`, signature: `function ${name}()`, isDeprecated: 0 });

  node("fileA#compA", "compA");
  node("fileB#compB", "compB");
  node("fileH#helper", "helper"); // conector interno (el "fix")
  node("fileX#distractor", "distractor"); // hoja no conectora

  // compA y compB llaman al helper compartido → camino compA - helper - compB.
  db.insertEdge({ sourceId: "fileA#compA", targetId: "fileH#helper", relation: "CALLS" });
  db.insertEdge({ sourceId: "fileB#compB", targetId: "fileH#helper", relation: "CALLS" });
  // distractor cuelga solo de compA (no conecta a compB).
  db.insertEdge({ sourceId: "fileA#compA", targetId: "fileX#distractor", relation: "CALLS" });

  db.populateMetadata();
  return db;
}

describe("ConnectorStrategy (Structural Connector Retrieval)", () => {
  let db: LaCoCoDatabase;
  let lanceDb: LaCoCoLanceDb;

  beforeEach(() => {
    db = createConnectorGraph();
  });

  afterEach(() => {
    db.close();
  });

  function withAnchors(anchors: { node_id: string; score: number }[]): LaCoCoLanceDb {
    return { search: vi.fn().mockResolvedValue(anchors) } as unknown as LaCoCoLanceDb;
  }

  it("surfacea el conector interno que une dos anclas", async () => {
    lanceDb = withAnchors([
      { node_id: "fileA#compA", score: 0.9 },
      { node_id: "fileB#compB", score: 0.85 },
    ]);
    const chunks = await new ConnectorStrategy(db, lanceDb, { anchorLimit: 10 })
      .retrieve(makeQuery("compA compB", ["CPG"]));

    const ids = chunks.map((c) => c.nodeId);
    expect(ids).toContain("fileH#helper"); // el conector aparece
    expect(ids).not.toContain("fileX#distractor"); // el distractor NO (no conecta)
    const helper = chunks.find((c) => c.nodeId === "fileH#helper")!;
    expect(helper.source).toBe("CONNECTOR");
    // Las anclas se conservan (fusión RRF, no interleave duro).
    expect(ids).toContain("fileA#compA");
    expect(ids).toContain("fileB#compB");
  });

  it("degrada a las anclas con una sola ancla (no hay par que conectar)", async () => {
    lanceDb = withAnchors([{ node_id: "fileA#compA", score: 0.9 }]);
    const chunks = await new ConnectorStrategy(db, lanceDb, { anchorLimit: 10 })
      .retrieve(makeQuery("compA", ["CPG"]));

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.source).toBe("CONNECTOR");
    expect(chunks[0]!.nodeId).toBe("fileA#compA");
  });
});
