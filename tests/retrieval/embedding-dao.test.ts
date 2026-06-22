import { describe, expect, it, vi } from "vitest";
import type * as lancedb from "@lancedb/lancedb";
import { EmbeddingDao } from "../../src/persistence/lacoco-vectors-manager/dao/embedding-dao.js";

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
});
