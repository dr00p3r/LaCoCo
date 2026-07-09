import type { LaCoCoDatabase } from "../../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { SanitizerOutput } from "../../models/utilities/types.js";
import { EmbeddingGenerator } from "../../../embeddings/embedding-generator.js";
import { Bm25Service } from "./bm25-service.js";

const RRF_K = 60;

export interface HybridAnchor {
  nodeId: string;
  score: number;
  text: string;
}

/**
 * Selecciona anclas fusionando rankings BM25 y ANN mediante RRF.
 *
 * La busqueda ANN no aplica filtros dimensionales: las dimensiones solo
 * intervienen posteriormente en las estrategias que recorren el grafo.
 */
export class HybridAnchorService {
  private readonly embeddingGen = new EmbeddingGenerator();
  private readonly bm25: Bm25Service;

  constructor(
    private readonly db: LaCoCoDatabase,
    private readonly lanceDb: LaCoCoLanceDb,
  ) {
    this.bm25 = new Bm25Service(db);
  }

  /**
   * Recupera y fusiona hasta `rankingLimit` candidatos de cada buscador.
   *
   * BM25 (sync, FTS5 sobre SQLite) y el embedding (async, transformers.js) son
   * independientes: el primero no consume el vector y el segundo no necesita
   * los hits. Se lanzan en paralelo para solapar la latencia de inferencia del
   * modelo (~30-80 ms CPU) con el barrido FTS5. La fusión RRF solo requiere
   * ambos rankings listos antes de combinar → el orden de `await` no afecta
   * el resultado.
   *
   * @param query Salida sanitizada del intermediario.
   * @param rankingLimit Candidatos maximos por ranking antes de la fusion.
   * @returns Anclas ordenadas por score RRF descendente.
   */
  async search(query: SanitizerOutput, rankingLimit = 20): Promise<HybridAnchor[]> {
    if (rankingLimit <= 0) return [];

    const embeddingPromise = this.embeddingGen.generate(query.embedding_input);
    const bm25Results = this.bm25.search(query.clean_query, rankingLimit);
    const bm25Ranks = new Map<string, number>();
    for (let index = 0; index < bm25Results.length; index++) {
      const result = bm25Results[index]!;
      if (!bm25Ranks.has(result.nodeId)) bm25Ranks.set(result.nodeId, index + 1);
    }

    const embedding = await embeddingPromise;
    const annResults = await this.lanceDb.search(embedding, undefined, rankingLimit);
    const annRanks = new Map<string, number>();
    for (let index = 0; index < annResults.length; index++) {
      const result = annResults[index]!;
      if (!annRanks.has(result.node_id)) annRanks.set(result.node_id, index + 1);
    }

    const nodeIds = new Set([...bm25Ranks.keys(), ...annRanks.keys()]);
    const ranked = Array.from(nodeIds, (nodeId) => {
      const bm25Rank = bm25Ranks.get(nodeId);
      const annRank = annRanks.get(nodeId);
      const score =
        (bm25Rank === undefined ? 0 : 1 / (RRF_K + bm25Rank))
        + (annRank === undefined ? 0 : 1 / (RRF_K + annRank));
      return { nodeId, score };
    }).sort((left, right) =>
      right.score - left.score || left.nodeId.localeCompare(right.nodeId)
    );

    const signatures = this.db.getNodeSignatures(ranked.map(({ nodeId }) => nodeId));
    return ranked.map(({ nodeId, score }) => ({
      nodeId,
      score,
      text: signatures.get(nodeId) ?? nodeId,
    }));
  }
}
