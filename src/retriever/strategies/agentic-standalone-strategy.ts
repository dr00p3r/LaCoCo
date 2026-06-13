/**
 * AgenticStandaloneStrategy — Variante del agente agéntico sin uso de dimensiones.
 *
 * Usa la misma lógica de AgenticStrategy pero no usa el hint dimensional
 * del intermediario, operando sobre el grafo completo.
 *
 * Propósito: baseline para benchmarks.
 */

import {
  type RecoveryStrategy,
  type ContextChunk,
} from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";

export class AgenticStandaloneStrategy implements RecoveryStrategy {
  private readonly maxIterations = 3;

  constructor(
    private readonly db: LaCoCoDatabase,
    private readonly slmEndpoint = "http://localhost:11434/api/generate"
  ) {}

  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    // Sin filtro dimensional: semilla pura BM25
    const seedResults = this.db.searchBM25(query.clean_query, 20);
    const collected = new Map<string, ContextChunk>();
    const seedSigs = this.db.getNodeSignatures(seedResults.map((r) => r.node_id));

    for (const r of seedResults) {
      collected.set(r.node_id, {
        nodeId: r.node_id,
        score: Math.max(0, 1 - Math.abs(r.score)),
        text: seedSigs.get(r.node_id) ?? r.node_id,
        source: "AGENTIC-STANDALONE",
      });
    }

    // Expansión por vecindad sin hints dimensionales
    for (let i = 0; i < this.maxIterations && collected.size < 50; i++) {
      const currentIds = Array.from(collected.keys());
      const neighbors = this.#getNeighbors(currentIds);
      for (const n of neighbors) {
        if (!collected.has(n.nodeId)) {
          collected.set(n.nodeId, n);
        }
      }
    }

    return Array.from(collected.values()).sort((a, b) => b.score - a.score);
  }

  #getNeighbors(nodeIds: string[]): ContextChunk[] {
    if (nodeIds.length === 0) return [];

    const placeholders = nodeIds.map(() => "?").join(",");
    const sql = `
      SELECT sourceId, targetId, relation
      FROM edges
      WHERE sourceId IN (${placeholders}) OR targetId IN (${placeholders})
      LIMIT 100
    `;

    const rawDb = this.db.getRawDb();
    const rows = rawDb.prepare(sql).all([...nodeIds, ...nodeIds]) as {
      sourceId: string;
      targetId: string;
      relation: string;
    }[];

    const chunks: ContextChunk[] = [];
    for (const row of rows) {
      const otherId = nodeIds.includes(row.sourceId) ? row.targetId : row.sourceId;
      chunks.push({
        nodeId: otherId,
        score: 0.5,
        text: `${otherId} (via ${row.relation})`,
        source: "AGENTIC-STANDALONE",
      });
    }
    return chunks;
  }
}
