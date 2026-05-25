/**
 * HybridStrategy (2.4) — Fusión híbrida BM25 + Embeddings + RRF + DimFilter.
 *
 * Pipeline:
 *   1. Aplicar DimensionalFilter como hint.
 *   2. BM25 sobre FTS5 → ranking A.
 *   3. Embedding de query → ANN en LanceDB con filtro pre-ANN por dimensiones → ranking B.
 *   4. Fusión RRF (k=60) entre A y B.
 *   5. Opcional: re-ranker agente sobre top 20.
 *
 * Recomendada como estrategia por defecto por máxima calidad de recuperación.
 */

import {
  type RecoveryStrategy,
  type SanitizerOutput,
  type ContextChunk,
} from "./base.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { EmbeddingGenerator } from "../embedding/embedding-generator.js";
import { DimensionalFilter } from "../dimensional-filter.js";

/** Constante estándar de RRF */
const RRF_K = 60;

/** Boost multiplicativo para chunks que coinciden con símbolos mencionados en la query */
const SYMBOL_BOOST = 1.5;

export class HybridStrategy implements RecoveryStrategy {
  private readonly dimFilter: DimensionalFilter;
  private readonly embeddingGen: EmbeddingGenerator;

  constructor(
    private readonly db: LaCoCoDatabase,
    private readonly lanceDb: LaCoCoLanceDb,
    confidenceThreshold = 0.65
  ) {
    this.dimFilter = new DimensionalFilter(confidenceThreshold);
    this.embeddingGen = new EmbeddingGenerator();
  }

  /**
   * Recupera contexto mediante fusión híbrida de rankings.
   *
   * @param query Salida sanitizada del intermediario
   * @returns Chunks fusionados y ordenados por score RRF
   */
  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    const dimensions = await this.dimFilter.filter(query);

    // ── 1. Ranking BM25 ────────────────────────────────────────────
    const bm25Results = this.db.searchBM25(query.clean_query, 50);
    const rankingA = new Map<string, number>();
    for (let i = 0; i < bm25Results.length; i++) {
      const r = bm25Results[i]!;
      rankingA.set(r.node_id, i + 1);
    }

    // ── 2. Ranking ANN (LanceDB) ────────────────────────────────────
    const embedding = await this.embeddingGen.generate(query.embedding_input);

    // Construir filtro pre-ANN de dimensiones
    const dimFilter =
      dimensions.length > 0
        ? `dimension IN (${dimensions.map((d) => `'${d}'`).join(", ")})`
        : undefined;

    const annResults = await this.lanceDb.search(embedding, dimFilter, 50);
    const rankingB = new Map<string, number>();
    for (let i = 0; i < annResults.length; i++) {
      const r = annResults[i]!;
      rankingB.set(r.node_id, i + 1);
    }

    // ── 3. Fusión RRF ──────────────────────────────────────────────
    const allIds = new Set([...rankingA.keys(), ...rankingB.keys()]);
    const rrfScores = new Map<string, number>();

    for (const id of allIds) {
      const rankA = rankingA.get(id);
      const rankB = rankingB.get(id);

      let score = 0;
      if (rankA) score += 1 / (RRF_K + rankA);
      if (rankB) score += 1 / (RRF_K + rankB);

      rrfScores.set(id, score);
    }

    // ── 4. Convertir a ContextChunks ───────────────────────────────
    const sorted = Array.from(rrfScores.entries()).sort((a, b) => b[1] - a[1]);
    const signatures = this.db.getNodeSignatures(sorted.map(([id]) => id));

    const chunks: ContextChunk[] = sorted.map(([nodeId, score]) => ({
      nodeId,
      score,
      text: signatures.get(nodeId) ?? nodeId,
      source: "RRF",
    }));

    // ── 5. Boost por coincidencia de símbolos en la query ──────────
    const queryTokens = query.embedding_input.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    for (const chunk of chunks) {
      const lowerId = chunk.nodeId.toLowerCase();
      if (queryTokens.some((t) => lowerId.includes(t))) {
        chunk.score *= SYMBOL_BOOST;
      }
    }
    chunks.sort((a, b) => b.score - a.score);

    return chunks;
  }
}
