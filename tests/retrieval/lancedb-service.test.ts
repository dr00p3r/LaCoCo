import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { NodeEmbeddingRecord } from "../../src/persistence/lacoco-vectors-manager/model/types.js";

describe("LaCoCoLanceDb", () => {
  it("reemplaza embeddings por node_id sin acumular duplicados", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lacoco-lancedb-"));
    const db = new LaCoCoLanceDb(dir);

    try {
      await db.connect();
      await db.replaceBatch([
        record("file#A", unitVector(0), "old-a.ts"),
        record("file#B", unitVector(1), "b.ts"),
      ]);
      await db.replaceBatch([
        record("file#A", unitVector(0), "duplicate-a.ts"),
        record("file#A", unitVector(0), "current-a.ts"),
      ]);

      const results = await db.search(unitVector(0), undefined, 10);
      const nodeIds = results.map((result) => result.node_id);

      expect(nodeIds.filter((nodeId) => nodeId === "file#A")).toHaveLength(1);
      expect(nodeIds).toContain("file#B");
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function record(
  nodeId: string,
  embedding: Float32Array,
  filePath: string,
): NodeEmbeddingRecord {
  return {
    node_id: nodeId,
    embedding,
    dimension: "CPG",
    sub_type: "function",
    file_path: filePath,
  };
}

function unitVector(index: number): Float32Array {
  const vector = new Float32Array(384);
  vector[index] = 1;
  return vector;
}
