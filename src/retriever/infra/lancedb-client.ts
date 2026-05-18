/**
 * LanceDbClient — Wrapper embebido para LanceDB
 *
 * Responsabilidades:
 *   - Conectar / crear la tabla `node_embeddings` con schema NodeEmbeddingRecord.
 *   - Construir índice ANN (HNSW o IVF_PQ) para búsqueda aproximada.
 *   - Insertar embeddings en batch (post-extracción).
 *   - Buscar con filtros pre-ANN (dimension, sub_type, file_path).
 *
 * Por qué LanceDB:
 *   - Embebible (sin servidor), Rust-based, alto rendimiento.
 *   - Filtros pre-ANN reducen el espacio de búsqueda antes del ranking vectorial.
 */

import * as lancedb from "@lancedb/lancedb";
import { type NodeEmbeddingRecord } from "./types.js";

export { type NodeEmbeddingRecord };

export class LanceDbClient {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;

  /**
   * @param dbPath Ruta al directorio de datos de LanceDB (local).
   *               Por defecto: `./lancedb` en el CWD.
   */
  constructor(private readonly dbPath: string = "./lancedb") {}

  /** Abre la conexión y crea la tabla si no existe. */
  async connect(): Promise<void> {
    this.db = await lancedb.connect(this.dbPath);
    const existingTables = await this.db.tableNames();

    if (!existingTables.includes("node_embeddings")) {
      // Schema explícito para la tabla
      this.table = await this.db.createTable("node_embeddings", []);
    } else {
      this.table = await this.db.openTable("node_embeddings");
    }
  }

  /** Cierra la conexión (LanceDB libera recursos automáticamente, pero explícito es mejor). */
  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
      this.table = null;
    }
  }

  /**
   * Inserta un lote de registros de embedding.
   *
   * @param records Array de NodeEmbeddingRecord con embeddings Float32Array
   */
  async insertBatch(records: NodeEmbeddingRecord[]): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    if (records.length === 0) return;

    await this.table.add(records as unknown as Record<string, unknown>[]);
  }

  /**
   * Búsqueda ANN con filtro pre-ANN de metadatos.
   *
   * @param queryEmbedding Vector de consulta (Float32Array, 384 dims)
   * @param filter Filtro SQL-LanceDB de metadatos (ej: `dimension = 'CPG'`)
   * @param topK Número de vecinos cercanos a retornar
   * @returns Array de { node_id, score } ordenados por similitud descendente
   */
  async search(
    queryEmbedding: Float32Array,
    filter?: string,
    topK = 50
  ): Promise<{ node_id: string; score: number }[]> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");

    let query = this.table.query().nearestTo(queryEmbedding).limit(topK);

    if (filter) {
      query = query.where(filter);
    }

    const results = await query.toArray();

    // LanceDB retorna score de distancia; normalizamos a similitud coseno (1 - distance)
    // Nota: con normalize=true en el embedding, distancia ≈ 1 - cosine
    return results.map((r: Record<string, unknown>) => ({
      node_id: r.node_id as string,
      score: typeof r._distance === "number" ? 1 - r._distance : 0,
    }));
  }

  /**
   * Elimina todos los embeddings asociados a un node_id.
   * Útil durante re-indexación incremental (hot reload).
   */
  async deleteByNodeId(nodeId: string): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    await this.table.delete(`node_id = '${nodeId}'`);
  }

  /** Construye el índice ANN sobre la tabla (HNSW recomendado para latencia baja). */
  async buildIndex(): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    // HNSW ofrece latencia de búsqueda ~1-2ms en datasets medianos
    await (this.table as unknown as { createIndex: (opts: Record<string, unknown>) => Promise<void> }).createIndex({
      type: "hnsw",
      column: "vector",
      metric_type: "cosine",
    });
  }
}
