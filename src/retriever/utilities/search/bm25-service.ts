import type { LaCoCoDatabase } from "../../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { ContextChunk } from "../../models/strategies/types.js";

export interface Bm25Hit {
  nodeId: string;
  rawScore: number;
  score: number;
  rank: number;
  text: string;
}

/**
 * Servicio compartido para búsquedas BM25 sobre SQLite/FTS5.
 *
 * @param rawScore Score nativo devuelto por FTS5.
 * @param rank Posición 1-based en el ranking.
 * @param total Total de resultados devueltos.
 * @returns Score normalizado estable en el rango 0..1.
 */
export function normalizeBm25Score(
  rawScore: number,
  rank: number,
  total: number
): number {
  if (total <= 0) return 0;

  const rankScore = (total - rank + 1) / total;
  if (!Number.isFinite(rawScore)) return rankScore;

  return Math.max(0, Math.min(1, rankScore));
}

export class Bm25Service {
  constructor(private readonly db: LaCoCoDatabase) {}

  /**
   * Ejecuta BM25 y devuelve hits con firmas y ranking normalizado.
   *
   * @param query Query FTS5 sanitizada.
   * @param limit Máximo de hits a recuperar.
   * @returns Hits ordenados por relevancia descendente.
   */
  search(query: string, limit = 50): Bm25Hit[] {
    if (query.trim().length === 0) return [];

    const results = this.db.searchBM25(query, limit);
    const signatures = this.db.getNodeSignatures(results.map((r) => r.node_id));
    const total = results.length;

    return results.map((r, index) => {
      const rank = index + 1;
      return {
        nodeId: r.node_id,
        rawScore: r.score,
        score: normalizeBm25Score(r.score, rank, total),
        rank,
        text: signatures.get(r.node_id) ?? r.node_id,
      };
    });
  }

  /**
   * Convierte hits BM25 en chunks de contexto.
   *
   * @param hits Hits BM25 normalizados.
   * @param source Etiqueta de origen a asociar al chunk.
   * @returns Chunks listos para agregación.
   */
  toChunks(hits: Bm25Hit[], source = "BM25"): ContextChunk[] {
    return hits.map((hit) => ({
      nodeId: hit.nodeId,
      score: hit.score,
      text: hit.text,
      source,
    }));
  }
}
