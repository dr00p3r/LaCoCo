import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { NodeEmbeddingRecord } from "../../src/persistence/lacoco-vectors-manager/model/types.js";

describe("LaCoCoLanceDb", () => {
  it("propaga errores de conexión y conserva el estado desconectado", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lacoco-lancedb-failure-"));
    const invalidPath = path.join(dir, "file");
    writeFileSync(invalidPath, "not a directory");
    const db = new LaCoCoLanceDb(invalidPath);

    try {
      await expect(db.connect()).rejects.toThrow();
      expect(db.health()).toEqual({
        connected: false,
        indexBuilt: false,
        lastIndexError: null,
      });
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

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

  it("aplica filtros dimensionales antes de devolver vecinos", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lacoco-lancedb-filter-"));
    const db = new LaCoCoLanceDb(dir);

    try {
      await db.connect();
      await db.insertBatch([
        record("file#SYS", unitVector(0), "sys.ts", "SYS"),
        record("file#CPG", unitVector(0), "cpg.ts", "CPG"),
      ]);

      const results = await db.search(unitVector(0), "dimension = 'SYS'", 10);

      expect(results.map((result) => result.node_id)).toEqual(["file#SYS"]);
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("expone el ciclo de clear y construcción del índice en health", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lacoco-lancedb-index-"));
    const db = new LaCoCoLanceDb(dir);

    try {
      expect(db.health().connected).toBe(false);
      await db.connect();
      await db.insertBatch(
        Array.from({ length: 256 }, (_, index) =>
          record(`file#${index}`, unitVector(index % 384), `file-${index}.ts`),
        ),
      );
      await db.clear();
      expect(await db.search(unitVector(0), undefined, 10)).toEqual([]);

      await db.insertBatch(
        Array.from({ length: 256 }, (_, index) =>
          record(`rebuilt#${index}`, unitVector(index % 384), `rebuilt-${index}.ts`),
        ),
      );
      await db.buildIndex();

      expect(db.health()).toEqual({
        connected: true,
        indexBuilt: true,
        lastIndexError: null,
      });
    } finally {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("conserva en health el error cuando HNSW no puede construirse", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lacoco-lancedb-index-error-"));
    const db = new LaCoCoLanceDb(dir);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      await db.connect();
      await db.buildIndex();

      expect(db.health().indexBuilt).toBe(false);
      expect(db.health().lastIndexError).toContain("Creating empty vector indices");
      expect(warning).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function record(
  nodeId: string,
  embedding: Float32Array,
  filePath: string,
  dimension: "SYS" | "CPG" | "DTG" = "CPG",
): NodeEmbeddingRecord {
  return {
    node_id: nodeId,
    embedding,
    dimension,
    sub_type: "function",
    file_path: filePath,
  };
}

function unitVector(index: number): Float32Array {
  const vector = new Float32Array(384);
  vector[index] = 1;
  return vector;
}
