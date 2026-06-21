import {
  type RecoveryStrategy,
  type ContextChunk,
} from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { EmbeddingGenerator } from "../utilities/embeddings/embedding-generator.js";
import { Bm25Service } from "../utilities/search/bm25-service.js";

const RRF_K = 60;

/** Boost multiplicativo para chunks que coinciden con símbolos mencionados en la query */
const SYMBOL_BOOST = 1.5;

export class HybridStrategy implements RecoveryStrategy {

  private readonly embeddingGen: EmbeddingGenerator;
  private readonly bm25: Bm25Service;

  constructor(
    private readonly db: LaCoCoDatabase,
    private readonly lanceDb: LaCoCoLanceDb,
  ) {
    this.embeddingGen = new EmbeddingGenerator();
    this.bm25 = new Bm25Service(db);
  }

  /**
   * Recupera contexto mediante fusión híbrida de rankings.
   *
   * @param query Salida sanitizada del intermediario
   * @returns Chunks fusionados y ordenados por score RRF
   */
  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {

    const bm25Results = this.bm25.search(query.clean_query, 20);
    const rankingA = new Map<string, number>();
    for (let i = 0; i < bm25Results.length; i++) {
      const r = bm25Results[i]!;
      rankingA.set(r.nodeId, i + 1);
    }

    const embedding = await this.embeddingGen.generate(query.embedding_input);
    const annResults = await this.lanceDb.search(embedding, undefined, 20);
    const rankingB = new Map<string, number>();
    for (let i = 0; i < annResults.length; i++) {
      const r = annResults[i]!;
      rankingB.set(r.node_id, i + 1);
    }

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

    const sorted = Array.from(rrfScores.entries()).sort((a, b) => b[1] - a[1]);
    const signatures = this.db.getNodeSignatures(sorted.map(([id]) => id));

    const chunks: ContextChunk[] = sorted.map(([nodeId, score]) => ({
      nodeId,
      score,
      text: signatures.get(nodeId) ?? nodeId,
      source: "RRF",
    }));

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
