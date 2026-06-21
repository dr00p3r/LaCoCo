import { describe, it, expect, vi } from "vitest";
import { VectorCallbacks } from "../../src/extractor/vector-callbacks.js";
import type { NodeRow } from "../../src/extractor/types.js";
import type { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";

describe("VectorCallbacks", () => {
  function node(id: string): NodeRow {
    return {
      id,
      kind: "FUNCTION",
      name: id,
      filepath: `/tmp/${id}.ts`,
      signature: `function ${id}(): void`,
      isDeprecated: 0,
    };
  }

  it("espera todos los flushes programados antes de terminar", async () => {
    const inserted: string[] = [];
    const lanceDb = {
      insertBatch: vi.fn(async (records: { node_id: string }[]) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        inserted.push(...records.map((record) => record.node_id));
      }),
    } as unknown as LaCoCoLanceDb;
    const generateEmbedding = vi.fn(async () => new Float32Array(384));
    const callbacks = new VectorCallbacks(lanceDb, generateEmbedding, undefined, 2);

    for (let i = 0; i < 5; i++) {
      callbacks.insertNode(node(`node${i}`));
    }
    await callbacks.flush();

    expect(inserted.sort()).toEqual(["node0", "node1", "node2", "node3", "node4"]);
    expect(lanceDb.insertBatch).toHaveBeenCalledTimes(3);
  });
});
