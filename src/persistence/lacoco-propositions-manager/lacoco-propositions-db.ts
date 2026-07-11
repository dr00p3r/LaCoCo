import * as lancedb from "@lancedb/lancedb";
import { EMBEDDING_DIM } from "../../embeddings/embedding-config.js";
import type { NodePropositionRecord } from "./model/types.js";

const TABLE_NAME = "node_propositions";

/** Hit del canal de proposiciones ya colapsado al nodo de código real. */
export interface PropositionSearchHit {
  realNodeId: string;
  score: number;
}

/**
 * Contrato mínimo que el `HybridAnchorService` consume del canal de
 * proposiciones. Se depende de la interfaz (no de la clase) para poder
 * inyectar un fake en tests sin LanceDB.
 */
export interface PropositionsSearcher {
  search(queryEmbedding: Float32Array, topK: number): Promise<PropositionSearchHit[]>;
}

/**
 * Tabla LanceDB `node_propositions` — canal de recall doc-side de C2.
 *
 * Vive en el MISMO directorio LanceDB que `node_embeddings` (viaja con el
 * índice), pero es una tabla SEPARADA: así las filas-proposición nunca
 * contaminan los ~11 sitios de búsqueda que asumen que toda fila es un nodo del
 * grafo. Escritura la usa `PropositionsIndexer`; lectura solo el
 * `HybridAnchorService` cuando el flag `retrieval.propositions` está activo.
 *
 * `search()` colapsa las filas-proposición a su `real_node_id` (mejor score si
 * varias proposiciones del mismo nodo afloran), de modo que el ancla siempre
 * apunta al nodo de código real y `getNodeSignatures` lo resuelve normalmente.
 */
export class LaCoCoPropositionsDb implements PropositionsSearcher {
  #db: lancedb.Connection | null = null;
  #table: lancedb.Table | null = null;
  /** null = aún no se intentó conectar; false = el dir no tiene la tabla. */
  #tableExists: boolean | null = null;

  constructor(private readonly dbPath: string) {}

  /**
   * Conexión perezosa e idempotente. Si la tabla no existe (índice sin C2), deja
   * `#tableExists=false` y las lecturas devuelven `[]` sin fallar.
   */
  async connect(): Promise<void> {
    if (this.#db) return;
    this.#db = await lancedb.connect(this.dbPath);
    const tables = await this.#db.tableNames();
    if (tables.includes(TABLE_NAME)) {
      this.#table = await this.#db.openTable(TABLE_NAME);
      this.#tableExists = true;
    } else {
      this.#tableExists = false;
    }
  }

  /** Crea (o recrea) la tabla vacía con el esquema Arrow sembrado. */
  async reset(): Promise<void> {
    if (!this.#db) this.#db = await lancedb.connect(this.dbPath);
    const tables = await this.#db.tableNames();
    if (tables.includes(TABLE_NAME)) await this.#db.dropTable(TABLE_NAME);

    const dummy: NodePropositionRecord = {
      prop_id: "__schema_init__",
      real_node_id: "__schema_init__",
      embedding: new Float32Array(EMBEDDING_DIM),
      text: "",
      dimension: "CPG",
      file_path: "/dev/null",
    };
    this.#table = await this.#db.createTable(TABLE_NAME, [dummy as unknown as Record<string, unknown>]);
    await this.#table.delete("prop_id = '__schema_init__'");
    this.#tableExists = true;
  }

  async add(records: NodePropositionRecord[]): Promise<void> {
    if (records.length === 0) return;
    if (!this.#table) throw new Error("node_propositions no inicializada; llame a reset() primero.");
    await this.#table.add(records as unknown as Record<string, unknown>[]);
  }

  async buildIndex(): Promise<void> {
    if (!this.#table) return;
    try {
      await this.#table.createIndex("embedding", {
        config: lancedb.Index.hnswSq({ distanceType: "cosine", numPartitions: 1 }),
        name: "prop_embedding_hnsw",
        replace: true,
        waitTimeoutSeconds: 60,
      });
    } catch (err) {
      // Con muy pocas filas el HNSW puede no construirse; la búsqueda cae a
      // fuerza bruta (correcta, solo más lenta). No es fatal.
      console.warn(
        "[LaCoCoPropositionsDb] No se pudo construir el índice HNSW de proposiciones:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  async search(queryEmbedding: Float32Array, topK: number): Promise<PropositionSearchHit[]> {
    if (topK <= 0) return [];
    await this.connect();
    if (!this.#table || this.#tableExists === false) return [];

    // Sobre-traemos para que, tras colapsar varias proposiciones del mismo nodo,
    // queden ~topK nodos distintos.
    const rows = await this.#table
      .query()
      .nearestTo(queryEmbedding)
      .limit(topK * 3)
      .toArray();

    const bestByNode = new Map<string, number>();
    const order: string[] = [];
    for (const row of rows as Record<string, unknown>[]) {
      const realNodeId = row.real_node_id as string | undefined;
      if (!realNodeId) continue;
      const score = typeof row._distance === "number" ? 1 - row._distance : 0;
      const prev = bestByNode.get(realNodeId);
      if (prev === undefined) {
        bestByNode.set(realNodeId, score);
        order.push(realNodeId);
      } else if (score > prev) {
        bestByNode.set(realNodeId, score);
      }
    }

    return order
      .map((realNodeId) => ({ realNodeId, score: bestByNode.get(realNodeId)! }))
      .sort((a, b) => b.score - a.score || a.realNodeId.localeCompare(b.realNodeId))
      .slice(0, topK);
  }

  async close(): Promise<void> {
    if (this.#db) {
      try {
        await this.#db.close();
      } finally {
        this.#db = null;
        this.#table = null;
        this.#tableExists = null;
      }
    }
  }
}
