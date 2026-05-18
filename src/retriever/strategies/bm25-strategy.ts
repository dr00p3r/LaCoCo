/**
 * BM25Strategy (2.1) — Recuperación full-text pura sobre FTS5 SQLite.
 *
 * No aplica filtro dimensional. Útil como baseline rápido cuando la
 * intención del usuario es vaga o cuando se quiere comparar calidad
 * vs estrategias más sofisticadas.
 */

import { type RecoveryStrategy, type SanitizerOutput, type ContextChunk } from "./base.js";
import { type SqliteManager } from "../../shared/db/sqlite-manager.js";

export class BM25Strategy implements RecoveryStrategy {
  constructor(private readonly db: SqliteManager) {}

  /**
   * Recupera nodos mediante BM25 sobre la tabla FTS5 `nodes_fts`.
   *
   * @param query Salida sanitizada del intermediario
   * @returns Chunks ordenados por score BM25 (menor = más relevante, invertimos para consistencia)
   */
  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    const results = this.db.searchBM25(query.clean_query, 50);

    return results.map((r) => ({
      nodeId: r.node_id,
      // Invertimos el score BM25 (menor es mejor) a un score descendiente 0-1
      score: Math.max(0, 1 - Math.abs(r.score)),
      text: r.node_id, // El caller puede hacer JOIN para obtener signature
      source: "BM25",
    }));
  }
}
