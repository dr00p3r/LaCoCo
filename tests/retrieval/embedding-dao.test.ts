import { describe, expect, it, vi } from "vitest";
import type * as lancedb from "@lancedb/lancedb";
import { EmbeddingDao } from "../../src/persistence/lacoco-vectors-manager/dao/embedding-dao.js";
import type { NodeEmbeddingRecord } from "../../src/persistence/lacoco-vectors-manager/model/types.js";

describe("EmbeddingDao", () => {
  it("elimina por archivo escapando literales SQL", async () => {
    const table = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as lancedb.Table;
    const dao = new EmbeddingDao();

    await dao.deleteByFilePath(table, "/tmp/O'Brien.ts");

    expect(table.delete).toHaveBeenCalledWith("file_path = '/tmp/O''Brien.ts'");
  });

  it("limpia todos los registros vectoriales", async () => {
    const table = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as lancedb.Table;
    const dao = new EmbeddingDao();

    await dao.clear(table);

    expect(table.delete).toHaveBeenCalledWith("node_id IS NOT NULL");
  });

  it("elimina varios nodos escapando literales SQL", async () => {
    const table = { delete: vi.fn().mockResolvedValue(undefined) } as unknown as lancedb.Table;
    const dao = new EmbeddingDao();

    await dao.deleteByNodeIds(table, ["file#A", "file#O'Brien", "file#A"]);

    expect(table.delete).toHaveBeenCalledWith("node_id IN ('file#A', 'file#O''Brien')");
  });

  it("reemplaza lotes de forma idempotente por node_id", async () => {
    const execute = vi.fn().mockResolvedValue(undefined);
    const whenNotMatchedInsertAll = vi.fn().mockReturnValue({ execute });
    const whenMatchedUpdateAll = vi.fn().mockReturnValue({ whenNotMatchedInsertAll });
    const mergeInsert = vi.fn().mockReturnValue({ whenMatchedUpdateAll });
    const table = {
      mergeInsert,
    } as unknown as lancedb.Table;
    const dao = new EmbeddingDao();

    await dao.replaceBatch(table, [
      record("file#A", "old"),
      record("file#B", "current"),
      record("file#A", "current"),
    ]);

    expect(mergeInsert).toHaveBeenCalledWith("node_id");
    expect(whenMatchedUpdateAll).toHaveBeenCalledOnce();
    expect(whenNotMatchedInsertAll).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith([
      expect.objectContaining({ node_id: "file#A", file_path: "current" }),
      expect.objectContaining({ node_id: "file#B", file_path: "current" }),
    ]);
  });
});

function record(nodeId: string, filePath: string): NodeEmbeddingRecord {
  return {
    node_id: nodeId,
    embedding: new Float32Array(384),
    dimension: "CPG",
    sub_type: "function",
    file_path: filePath,
  };
}
