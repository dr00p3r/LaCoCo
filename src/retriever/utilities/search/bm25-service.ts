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

/**
 * Convierte la consulta emitida por el SLM en sintaxis FTS5 segura.
 *
 * El SLM sigue siendo la unica capa que decide los terminos semanticos. Esta
 * funcion solo normaliza la sintaxis para que caracteres como paréntesis,
 * comillas invertidas o dos puntos no sean interpretados como operadores FTS5.
 */
export function normalizeFts5Query(query: string): string {
  const clauses = splitFts5OrClauses(query)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);

  return clauses.map(quoteFts5Phrase).join(" OR ");
}

export function splitFts5OrClauses(query: string): string[] {
  const clauses: string[] = [];
  let current = "";
  let inQuote = false;

  for (let index = 0; index < query.length; index++) {
    const char = query[index]!;

    if (char === '"') {
      if (inQuote && query[index + 1] === '"') {
        current += '""';
        index++;
        continue;
      }
      inQuote = !inQuote;
      current += char;
      continue;
    }

    if (!inQuote && isStandaloneOr(query, index)) {
      clauses.push(current);
      current = "";
      index += 1;
      continue;
    }

    current += char;
  }

  clauses.push(current);
  return clauses;
}

function isStandaloneOr(query: string, index: number): boolean {
  const candidate = query.slice(index, index + 2);
  if (candidate.toUpperCase() !== "OR") return false;

  const before = index === 0 ? " " : query[index - 1]!;
  const after = index + 2 >= query.length ? " " : query[index + 2]!;
  return /\s/.test(before) && /\s/.test(after);
}

function quoteFts5Phrase(clause: string): string {
  const phrase = unwrapQuotedPhrase(clause);
  return `"${phrase.replace(/"/g, '""')}"`;
}

function unwrapQuotedPhrase(clause: string): string {
  if (clause.length >= 2 && clause.startsWith('"') && clause.endsWith('"')) {
    return clause.slice(1, -1).replace(/""/g, '"');
  }
  return clause;
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

    const ftsQuery = normalizeFts5Query(query);
    if (ftsQuery.length === 0) return [];

    const results = this.db.searchBM25(ftsQuery, limit);
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
      chunkId: hit.nodeId,
      nodeId: hit.nodeId,
      score: hit.score,
      text: hit.text,
      source,
    }));
  }
}
