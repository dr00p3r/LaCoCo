import * as lancedb from "@lancedb/lancedb";
import type { NodeEmbeddingRecord } from "./model/types.js";
import { ConnectionDao } from "./dao/connection-dao.js";
import { EmbeddingDao } from "./dao/embedding-dao.js";
import { SearchDao } from "./dao/search-dao.js";
import type { AnnSearchResult } from "./dao/search-dao.js";

export type { NodeEmbeddingRecord, AnnSearchResult };

export interface LanceDbHealth {
  connected: boolean;
  indexBuilt: boolean;
  lastIndexError: string | null;
  maintenance: {
    needed: boolean;
    writeOperations: number;
    rowsModified: number;
    smallFragments: number;
    unindexedRows: number;
    lastOptimizedAt: string | null;
    lastOptimizeError: string | null;
  };
}

export interface LanceDbMaintenancePolicy {
  writeOperations: number;
  rowsModified: number;
  smallFragments: number;
  unindexedRows: number;
  retentionMs: number;
}

export const DEFAULT_LANCEDB_MAINTENANCE_POLICY: Readonly<LanceDbMaintenancePolicy> = Object.freeze({
  writeOperations: 20,
  rowsModified: 100_000,
  smallFragments: 20,
  unindexedRows: 100_000,
  retentionMs: 7 * 24 * 60 * 60 * 1000,
});

export class LaCoCoLanceDb {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;
  private indexBuilt = false;
  private lastIndexError: string | null = null;
  private writeOperations = 0;
  private rowsModified = 0;
  private smallFragments = 0;
  private unindexedRows = 0;
  private lastOptimizedAt: string | null = null;
  private lastOptimizeError: string | null = null;
  private optimizePromise: Promise<lancedb.OptimizeStats | null> | null = null;
  private readonly maintenancePolicy: LanceDbMaintenancePolicy;

  private readonly connectionDao: ConnectionDao;
  private readonly embeddingDao: EmbeddingDao;
  private readonly searchDao: SearchDao;

  constructor(
    private readonly dbPath: string = "./lancedb",
    maintenancePolicy?: Partial<LanceDbMaintenancePolicy>,
  ) {
    this.connectionDao = new ConnectionDao();
    this.embeddingDao = new EmbeddingDao();
    this.searchDao = new SearchDao();
    this.maintenancePolicy = {
      ...DEFAULT_LANCEDB_MAINTENANCE_POLICY,
      ...maintenancePolicy,
    };
    validateMaintenancePolicy(this.maintenancePolicy);
  }

  /** Directorio LanceDB subyacente (para abrir tablas hermanas, p. ej. node_propositions). */
  getDbPath(): string {
    return this.dbPath;
  }

  async connect(): Promise<void> {
    const { db, table } = await this.connectionDao.connect(this.dbPath);
    this.db = db;
    this.table = table;
    this.indexBuilt = (await table.listIndices()).some((index) => index.name === "embedding_hnsw");
    await this.#refreshMaintenanceStats();
  }

  async close(): Promise<void> {
    if (this.db) {
      try {
        await this.connectionDao.close(this.db);
      } finally {
        this.db = null;
        this.table = null;
      }
    }
  }

  async insertBatch(records: NodeEmbeddingRecord[]): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    await this.embeddingDao.insertBatch(this.table, records);
    this.#recordWrite(records.length);
    await this.optimizeIfNeeded();
  }

  async replaceBatch(records: NodeEmbeddingRecord[]): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    await this.embeddingDao.replaceBatch(this.table, records);
    this.#recordWrite(records.length);
    await this.optimizeIfNeeded();
  }

  async search(
    queryEmbedding: Float32Array,
    filter?: string,
    topK = 50
  ): Promise<AnnSearchResult[]> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    if (filter !== undefined && filter.length === 0) {
      throw new Error("El filtro de LanceDB no puede ser una cadena vacía");
    }
    return this.searchDao.search(this.table, queryEmbedding, filter, topK);
  }

  async deleteByNodeId(nodeId: string): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    await this.embeddingDao.deleteByNodeId(this.table, nodeId);
    this.#recordWrite(1, false);
    await this.optimizeIfNeeded();
  }

  async deleteByNodeIds(nodeIds: string[]): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    await this.embeddingDao.deleteByNodeIds(this.table, nodeIds);
    this.#recordWrite(nodeIds.length, false);
    await this.optimizeIfNeeded();
  }

  async deleteByFilePath(filePath: string): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    await this.embeddingDao.deleteByFilePath(this.table, filePath);
    this.#recordWrite(0, false);
    await this.optimizeIfNeeded();
  }

  async clear(): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    await this.embeddingDao.clear(this.table);
    this.#recordWrite(0, false);
  }

  async buildIndex(): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    try {
      await this.connectionDao.buildIndex(this.table);
      this.indexBuilt = true;
      this.lastIndexError = null;
      this.unindexedRows = 0;
    } catch (err) {
      this.indexBuilt = false;
      this.lastIndexError = err instanceof Error ? err.message : String(err);
      console.warn(
        "[LaCoCo] No se pudo construir el índice HNSW; la indexación queda utilizable sin ANN optimizado:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  health(): LanceDbHealth {
    return {
      connected: this.db !== null && this.table !== null,
      indexBuilt: this.indexBuilt,
      lastIndexError: this.lastIndexError,
      maintenance: {
        needed: this.#maintenanceNeeded(),
        writeOperations: this.writeOperations,
        rowsModified: this.rowsModified,
        smallFragments: this.smallFragments,
        unindexedRows: this.unindexedRows,
        lastOptimizedAt: this.lastOptimizedAt,
        lastOptimizeError: this.lastOptimizeError,
      },
    };
  }

  async optimizeIfNeeded(force = false): Promise<lancedb.OptimizeStats | null> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    if (!force && !this.#maintenanceNeeded()) return null;
    if (this.optimizePromise) return this.optimizePromise;

    this.optimizePromise = this.#optimize();
    try {
      return await this.optimizePromise;
    } finally {
      this.optimizePromise = null;
    }
  }

  async #optimize(): Promise<lancedb.OptimizeStats | null> {
    const table = this.table!;
    const cleanupOlderThan = new Date(Date.now() - this.maintenancePolicy.retentionMs);
    try {
      const stats = await this.connectionDao.optimize(table, cleanupOlderThan);
      this.writeOperations = 0;
      this.rowsModified = 0;
      this.lastOptimizedAt = new Date().toISOString();
      this.lastOptimizeError = null;
      await this.#refreshMaintenanceStats();
      return stats;
    } catch (error) {
      this.lastOptimizeError = error instanceof Error ? error.message : String(error);
      console.warn("[LaCoCo] No se pudo optimizar LanceDB:", this.lastOptimizeError);
      return null;
    }
  }

  async #refreshMaintenanceStats(): Promise<void> {
    if (!this.table) return;
    const stats = await this.connectionDao.stats(this.table);
    this.smallFragments = stats.fragmentStats.numSmallFragments;
    this.unindexedRows = this.indexBuilt
      ? await this.connectionDao.unindexedRows(this.table, "embedding_hnsw")
      : stats.numRows;
  }

  #recordWrite(rows: number, addsUnindexedRows = true): void {
    this.writeOperations++;
    this.rowsModified += rows;
    if (addsUnindexedRows) this.unindexedRows += rows;
  }

  #maintenanceNeeded(): boolean {
    return this.writeOperations >= this.maintenancePolicy.writeOperations
      || this.rowsModified >= this.maintenancePolicy.rowsModified
      || this.smallFragments >= this.maintenancePolicy.smallFragments
      || (this.indexBuilt && this.unindexedRows >= this.maintenancePolicy.unindexedRows);
  }
}

function validateMaintenancePolicy(policy: LanceDbMaintenancePolicy): void {
  for (const [key, value] of Object.entries(policy)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`LanceDbMaintenancePolicy.${key} debe ser un entero positivo`);
    }
  }
}
