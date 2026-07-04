/**
 * ContextAggregator — Deduplica, ordena y trunca chunks de contexto recuperados.
 *
 * Responsabilidades:
 *   1. Deduplicar por chunkId (conservar el chunk con mayor score)
 *   2. Ordenar por score descendente
 *   3. Truncar cuando la suma aproximada de tokens supere maxTokens
 */

import { type ContextChunk } from "../../models/strategies/types.js";

/** Estimación conservadora: 1 token ≈ 0.75 palabras en inglés/espanol técnico */
const WORDS_PER_TOKEN = 0.75;
export const DEFAULT_CONTEXT_MAX_TOKENS = 4000;

export class ContextAggregator {
  /**
   * Agrega chunks recuperados en una lista final lista para inyección.
   *
   * @param chunks Chunks provenientes de una o más estrategias
   * @param maxTokens Límite de tokens del contexto (default 4000)
   * @returns Lista truncada y ordenada de chunks únicos
   */
  aggregate(
    chunks: ContextChunk[],
    maxTokens = DEFAULT_CONTEXT_MAX_TOKENS,
    minScore = 0,
  ): ContextChunk[] {

    // 1. Deduplicar por identidad de evidencia (quedarse con mayor score)
    const byChunk = new Map<string, ContextChunk>();
    for (const chunk of chunks) {
      const existing = byChunk.get(chunk.chunkId);
      if (!existing || chunk.score > existing.score) {
        byChunk.set(chunk.chunkId, chunk);
      }
    }

    // 2. Filtrar por score mínimo (eliminar ruido de baja relevancia)
    const filtered = Array.from(byChunk.values()).filter((c) => c.score >= minScore);

    // 3. Ordenar por score descendente
    const sorted = filtered.sort((a, b) => b.score - a.score);

    // 4. Truncar por tokens aproximados
    const result: ContextChunk[] = [];
    let tokensUsed = 0;

    for (const chunk of sorted) {

      const estimatedTokens = Math.ceil(
        chunk.text.split(/\s+/).length / WORDS_PER_TOKEN
      );

      if (tokensUsed + estimatedTokens > maxTokens) continue;

      result.push(chunk);
      tokensUsed += estimatedTokens;
    }

    return result;
  }
}
