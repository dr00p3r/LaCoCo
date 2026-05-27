/**
 * BM25Strategy (2.1) — Recuperación full-text pura sobre FTS5 SQLite.
 *
 * No aplica filtro dimensional. Útil como baseline rápido cuando la
 * intención del usuario es vaga o cuando se quiere comparar calidad
 * vs estrategias más sofisticadas.
 */

import { type RecoveryStrategy, type ContextChunk } from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";

export class BM25Strategy implements RecoveryStrategy {
  constructor(private readonly db: LaCoCoDatabase) {}

  /**
   * Recupera nodos mediante BM25 sobre la tabla FTS5 `nodes_fts`.
   *
   * @param query Salida sanitizada del intermediario
   * @returns Chunks ordenados por score BM25 (menor = más relevante, invertimos para consistencia)
   */
  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    const results = this.db.searchBM25(query.clean_query, 50);
    const signatures = this.db.getNodeSignatures(results.map((r) => r.node_id));

    return results.map((r) => ({
      nodeId: r.node_id,
      score: Math.max(0, 1 - Math.abs(r.score)),
      text: signatures.get(r.node_id) ?? r.node_id,
      source: "BM25",
    }));
  }
}
