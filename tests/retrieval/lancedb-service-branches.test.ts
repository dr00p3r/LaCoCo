import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { NodeEmbeddingRecord } from "../../src/persistence/lacoco-vectors-manager/model/types.js";

/**
 * Ramas de guardia, borrado y mantenimiento de LaCoCoLanceDb que la suite base
 * no ejercita: rechazos por tabla no conectada, los tres borrados reales, el
 * filtro vacío, y los distintos disparadores de #maintenanceNeeded.
 */
describe("LaCoCoLanceDb — ramas de guardia y mantenimiento", () => {
  describe("guardias sin conexión (tabla nula)", () => {
    let db: LaCoCoLanceDb;

    beforeEach(() => {
      db = new LaCoCoLanceDb("./inexistente");
    });

    it("rechaza toda operación de escritura/lectura antes de connect()", async () => {
      // Arrange / Act / Assert — cada método valida la tabla antes de tocar el DAO.
      const vector = new Float32Array(384);
      await expect(db.insertBatch([])).rejects.toThrow("LanceDB no conectado");
      await expect(db.replaceBatch([])).rejects.toThrow("LanceDB no conectado");
      await expect(db.search(vector)).rejects.toThrow("LanceDB no conectado");
      await expect(db.deleteByNodeId("x")).rejects.toThrow("LanceDB no conectado");
      await expect(db.deleteByNodeIds(["x"])).rejects.toThrow("LanceDB no conectado");
      await expect(db.deleteByFilePath("x.ts")).rejects.toThrow("LanceDB no conectado");
      await expect(db.clear()).rejects.toThrow("LanceDB no conectado");
      await expect(db.buildIndex()).rejects.toThrow("LanceDB no conectado");
      await expect(db.optimizeIfNeeded()).rejects.toThrow("LanceDB no conectado");
    });

    it("close() es idempotente cuando nunca se conectó", async () => {
      // Arrange / Act / Assert — sin db no entra en el bloque de cierre.
      await expect(db.close()).resolves.toBeUndefined();
      expect(db.health().connected).toBe(false);
    });

    it("expone el directorio LanceDB subyacente sin necesidad de conexión", () => {
      // Arrange / Act / Assert — getDbPath permite abrir tablas hermanas.
      expect(db.getDbPath()).toBe("./inexistente");
    });
  });

  describe("operaciones sobre una tabla conectada", () => {
    let dir: string;
    let db: LaCoCoLanceDb;

    beforeEach(async () => {
      dir = mkdtempSync(path.join(tmpdir(), "lacoco-lancedb-branches-"));
      db = new LaCoCoLanceDb(dir);
      await db.connect();
    });

    afterEach(async () => {
      await db.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it("rechaza búsquedas con filtro de cadena vacía", async () => {
      // Arrange
      await db.insertBatch([record("file#A", unitVector(0), "a.ts")]);
      // Act / Assert — el filtro vacío es un error de uso, no un no-op.
      await expect(db.search(unitVector(0), "")).rejects.toThrow(
        "El filtro de LanceDB no puede ser una cadena vacía",
      );
    });

    it("borra por node_id individual y descuenta la fila", async () => {
      // Arrange
      await db.insertBatch([
        record("file#A", unitVector(0), "a.ts"),
        record("file#B", unitVector(1), "b.ts"),
      ]);
      // Act
      await db.deleteByNodeId("file#A");
      // Assert
      const ids = (await db.search(unitVector(0), undefined, 10)).map((r) => r.node_id);
      expect(ids).not.toContain("file#A");
      expect(ids).toContain("file#B");
    });

    it("borra por lote de node_ids", async () => {
      // Arrange
      await db.insertBatch([
        record("file#A", unitVector(0), "a.ts"),
        record("file#B", unitVector(1), "b.ts"),
        record("file#C", unitVector(2), "c.ts"),
      ]);
      // Act
      await db.deleteByNodeIds(["file#A", "file#B"]);
      // Assert
      const ids = (await db.search(unitVector(2), undefined, 10)).map((r) => r.node_id);
      expect(ids).toEqual(["file#C"]);
    });

    it("borra por ruta de archivo", async () => {
      // Arrange — dos filas en el mismo archivo, una en otro.
      await db.insertBatch([
        record("file#A", unitVector(0), "shared.ts"),
        record("file#B", unitVector(1), "shared.ts"),
        record("file#C", unitVector(2), "other.ts"),
      ]);
      // Act
      await db.deleteByFilePath("shared.ts");
      // Assert
      const ids = (await db.search(unitVector(2), undefined, 10)).map((r) => r.node_id);
      expect(ids).toEqual(["file#C"]);
    });

    it("fuerza la optimización aunque no haga falta mantenimiento", async () => {
      // Arrange — db recién conectada, sin escrituras pendientes.
      expect(db.health().maintenance.needed).toBe(false);
      // Act — force=true salta el corto-circuito de #maintenanceNeeded.
      await db.optimizeIfNeeded(true);
      // Assert — la optimización se ejecutó y marcó la marca temporal.
      expect(db.health().maintenance.lastOptimizedAt).not.toBeNull();
      expect(db.health().maintenance.lastOptimizeError).toBeNull();
    });

    it("reutiliza la promesa de optimización en llamadas concurrentes", async () => {
      // Arrange / Act — dos optimizaciones forzadas sin await intermedio: la 2ª
      // debe engancharse a la promesa en vuelo de la 1ª.
      const [first, second] = await Promise.all([
        db.optimizeIfNeeded(true),
        db.optimizeIfNeeded(true),
      ]);
      // Assert — misma optimización compartida (ambas resuelven al mismo valor).
      expect(first).toEqual(second);
    });
  });

  describe("disparadores de #maintenanceNeeded", () => {
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(path.join(tmpdir(), "lacoco-lancedb-maint-"));
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("optimiza al superar el umbral de filas modificadas (no el de escrituras)", async () => {
      // Arrange — solo rowsModified es alcanzable; el resto de umbrales altos.
      const db = new LaCoCoLanceDb(dir, {
        writeOperations: 999,
        rowsModified: 1,
        smallFragments: 999,
        unindexedRows: 999,
      });
      try {
        await db.connect();
        // Act — una sola inserción supera rowsModified>=1 → dispara la optimización.
        await db.insertBatch([record("file#A", unitVector(0), "a.ts")]);
        // Assert — la rama de rowsModified activó el mantenimiento y luego lo reseteó.
        expect(db.health().maintenance).toMatchObject({
          needed: false,
          rowsModified: 0,
          lastOptimizeError: null,
        });
        expect(db.health().maintenance.lastOptimizedAt).not.toBeNull();
      } finally {
        await db.close();
      }
    });
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
