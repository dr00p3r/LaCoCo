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
      replaceBatch: vi.fn(async (records: { node_id: string }[]) => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        inserted.push(...records.map((record) => record.node_id));
      }),
    } as unknown as LaCoCoLanceDb;
    // El callback recibe `string[]` y devuelve `Float32Array[]` (batched real).
    const generateEmbedding = vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array(384))
    );
    const callbacks = new VectorCallbacks(lanceDb, generateEmbedding, undefined, 2);

    for (let i = 0; i < 5; i++) {
      callbacks.insertNode(node(`node${i}`));
    }
    await callbacks.flush();

    expect(inserted.sort()).toEqual(["node0", "node1", "node2", "node3", "node4"]);
    expect(lanceDb.replaceBatch).toHaveBeenCalledTimes(3);
  });

  it("llama al generador UNA sola vez por batch con todos los textos", async () => {
    const lanceDb = {
      replaceBatch: vi.fn(async () => undefined),
    } as unknown as LaCoCoLanceDb;
    const generateEmbedding = vi.fn(async (texts: string[]) =>
      texts.map(() => new Float32Array(384))
    );
    const callbacks = new VectorCallbacks(lanceDb, generateEmbedding, undefined, 8);

    for (let i = 0; i < 6; i++) {
      callbacks.insertNode(node(`node${i}`));
    }
    await callbacks.flush();

    // 6 nodos con batchSize=8 → 1 sola llamada al generador (no 6 individuales).
    expect(generateEmbedding).toHaveBeenCalledTimes(1);
    const passedTexts = generateEmbedding.mock.calls[0]?.[0] as string[];
    expect(passedTexts).toHaveLength(6);
    expect(passedTexts[0]).toContain("node0");
    expect(passedTexts[5]).toContain("node5");
  });

  it("preserva el orden node→embedding en los registros insertados", async () => {
    const records: { node_id: string; sum: number }[] = [];
    const lanceDb = {
      replaceBatch: vi.fn(async (batch: { node_id: string; embedding: Float32Array }[]) => {
        for (const record of batch) {
          records.push({ node_id: record.node_id, sum: record.embedding[0]! });
        }
      }),
    } as unknown as LaCoCoLanceDb;
    // El embedding es un Float32Array de 384 dims; ponemos un valor distintivo
    // en la posición 0 según el índice del texto → verifica que el zip
    // node↔embedding no se cruce.
    const generateEmbedding = vi.fn(async (texts: string[]) =>
      texts.map((_, i) => {
        const vec = new Float32Array(384);
        vec[0] = 1000 + i;
        return vec;
      })
    );
    const callbacks = new VectorCallbacks(lanceDb, generateEmbedding, undefined, 10);

    for (let i = 0; i < 3; i++) callbacks.insertNode(node(`n${i}`));
    await callbacks.flush();

    expect(records).toEqual([
      { node_id: "n0", sum: 1000 },
      { node_id: "n1", sum: 1001 },
      { node_id: "n2", sum: 1002 },
    ]);
  });
});
