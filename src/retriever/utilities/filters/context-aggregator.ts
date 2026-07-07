/**
 * ContextAggregator — Deduplica, ordena y trunca chunks de contexto recuperados.
 *
 * Responsabilidades:
 *   1. Deduplicar por chunkId (conservar el chunk con mayor score)
 *   2. Ordenar por score descendente
 *   3. Truncar cuando la suma estimada de tokens supere maxTokens
 *
 * El conteo de tokens delega en `tokenizer.ts` (cl100k_base de OpenAI
 * como aproximacion). Ver `TOKENIZER_NOTE` para los limites de esta
 * eleccion.
 */

import { type ContextChunk } from "../../models/strategies/types.js";
import { estimateTokens } from "./tokenizer.js";

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

    // 4. Truncar por tokens reales (cl100k_base)
    const result: ContextChunk[] = [];
    let tokensUsed = 0;

    for (const chunk of sorted) {

      const chunkTokens = estimateTokens(chunk.text);

      if (tokensUsed + chunkTokens > maxTokens) continue;

      result.push(chunk);
      tokensUsed += chunkTokens;
    }

    return result;
  }
}
