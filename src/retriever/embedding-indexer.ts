/**
 * EmbeddingIndexer — Orquesta la generación de embeddings post-extracción
 *
 * Responsabilidades:
 *   1. Leer todos los nodos del grafo SQLite.
 *   2. Generar embeddings con all-MiniLM-L6-v2 vía transformers.js.
 *   3. Inferir metadatos (dimension, sub_type) a partir del kind y edges.
 *   4. Insertar registros en LanceDB en batch.
 *
 * Este componente cierra el loop entre el extractor (grafo estructural)
 * y el retriever (búsqueda semántica).
 */

import { SqliteManager, type GraphNode } from "../shared/db/sqlite-manager.js";
import { EmbeddingGenerator } from "./embedding/embedding-generator.js";
import { LanceDbClient } from "./infra/lancedb-client.js";
import { type NodeEmbeddingRecord } from "./infra/types.js";

/** Batch size para generación de embeddings (evita OOM) */
const BATCH_SIZE = 32;

export class EmbeddingIndexer {
  private readonly embedGen: EmbeddingGenerator;

  constructor(
    private readonly db: SqliteManager,
    private readonly lanceDb: LanceDbClient
  ) {
    this.embedGen = new EmbeddingGenerator();
  }

  /**
   * Indexa embeddings para TODOS los nodos existentes en SQLite.
   * Llama después del cold-start del extractor.
   *
   * @param onProgress Callback opcional para reportar progreso (current, total)
   */
  async indexAll(onProgress?: (current: number, total: number) => void): Promise<void> {
    const nodes = this.#getAllNodes();
    const total = nodes.length;
    console.log(`[EmbeddingIndexer] 🧠 Generando embeddings para ${total} nodos...`);

    for (let i = 0; i < total; i += BATCH_SIZE) {
      const batch = nodes.slice(i, i + BATCH_SIZE);
      await this.#indexBatch(batch);
      onProgress?.(Math.min(i + BATCH_SIZE, total), total);
    }

    console.log(`[EmbeddingIndexer] ✅ ${total} embeddings insertados en LanceDB.`);
  }

  /**
   * Re-indexa embeddings para los nodos de un archivo específico.
   * Útil en hot-reload incremental.
   */
  async indexFile(filePath: string): Promise<void> {
    // Eliminar embeddings previos del archivo
    const nodes = this.db.getNodesByFile(filePath);
    for (const node of nodes) {
      await this.lanceDb.deleteByNodeId(node.id);
    }

    // Re-generar e insertar
    await this.#indexBatch(nodes);
    console.log(`[EmbeddingIndexer] 🔄 ${nodes.length} embeddings re-indexados para ${filePath}`);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  #getAllNodes(): GraphNode[] {
    const rawDb = this.db.getRawDb();
    return rawDb.prepare("SELECT * FROM nodes").all() as GraphNode[];
  }

  async #indexBatch(nodes: GraphNode[]): Promise<void> {
    if (nodes.length === 0) return;

    // Generar embeddings en batch
    const texts = nodes.map((n) => `${n.name} ${n.signature}`);
    const embeddings = await this.embedGen.generateBatch(texts);

    // Construir registros con metadatos inferidos
    const records: NodeEmbeddingRecord[] = nodes.map((node, i) => ({
      node_id: node.id,
      embedding: embeddings[i]!,
      dimension: this.#inferDimension(node),
      sub_type: this.#inferSubType(node),
      file_path: node.filepath,
    }));

    await this.lanceDb.insertBatch(records);
  }

  /**
   * Infiere la dimensión semántica (SYS/CPG/DTG) a partir del tipo de nodo
   * y las aristas salientes.
   */
  #inferDimension(node: GraphNode): "SYS" | "CPG" | "DTG" {
    const rawDb = this.db.getRawDb();

    // Contar aristas por tipo de relación
    const edges = rawDb
      .prepare("SELECT relation FROM edges WHERE sourceId = ?")
      .all(node.id) as { relation: string }[];

    let sys = 0, cpg = 0, dtg = 0;
    for (const e of edges) {
      if (["EXTENDS", "IMPLEMENTS", "IMPORTS_EXTERNAL"].includes(e.relation)) sys++;
      if (["INJECTS", "CALLS", "INSTANTIATES"].includes(e.relation)) cpg++;
      if (["CONSUMES_DATA", "PRODUCES", "MUTATES_STATE"].includes(e.relation)) dtg++;
    }

    // Fallback por kind
    if (node.kind === "CLASS" || node.kind === "INTERFACE") sys += 2;
    if (node.kind === "METHOD" || node.kind === "FUNCTION" || node.kind === "ARROW_FUNCTION") cpg += 2;
    if (node.kind === "PROPERTY" || node.kind === "VARIABLE") dtg += 1;

    const max = Math.max(sys, cpg, dtg);
    if (max === sys) return "SYS";
    if (max === cpg) return "CPG";
    return "DTG";
  }

  #inferSubType(node: GraphNode): string {
    switch (node.kind) {
      case "CLASS": return "class";
      case "METHOD": return "method";
      case "FUNCTION": return "function";
      case "ARROW_FUNCTION": return "arrow_function";
      case "VARIABLE": return "variable";
      case "INTERFACE": return "interface";
      case "TYPE": return "type_alias";
      case "ENUM": return "enum";
      case "ENUM_MEMBER": return "enum_member";
      case "PROPERTY": return "property";
      case "ACCESSOR": return "accessor";
      case "EXTERNAL_LIB": return "package";
      default: return "unknown";
    }
  }
}
