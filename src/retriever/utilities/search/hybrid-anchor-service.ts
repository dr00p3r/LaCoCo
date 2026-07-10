import type { LaCoCoDatabase } from "../../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb, AnnSearchResult } from "../../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { SanitizerOutput } from "../../models/utilities/types.js";
import { EmbeddingGenerator } from "../../../embeddings/embedding-generator.js";
import { Bm25Service } from "./bm25-service.js";
import { getIntentWeights } from "../../strategies/helpers/intent-weights.js";
import { DIMENSIONS, type Dimension } from "../../../domain/dimensions.js";
import { resolveNumberConfig, resolveStringConfig } from "../../../cli/config.js";

const RRF_K = 60;

export interface HybridAnchor {
  nodeId: string;
  score: number;
  text: string;
}

/**
 * Selecciona anclas fusionando rankings BM25 y ANN mediante RRF.
 *
 * Anclaje ANN dimensional (estratificado suave). Con `retrieval.annOverfetch`
 * (env `LACOCO_ANN_OVERFETCH`, default 1) se sobre-trae el pool ANN y se sesga
 * la seleccion por intencion->dimension via `getIntentWeights`: cada dimension
 * recibe una cuota proporcional del top-K y los huecos restantes se rellenan
 * por orden ANN puro. No es un filtro duro `where`: preserva recall
 * cross-dimension y solo re-pondera que candidatos entran al pool antes del RRF.
 * Con overfetch=1 el comportamiento es identico al ANN plano previo.
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

    const overfetch = Math.max(1, resolveNumberConfig("retrieval.annOverfetch"));
    const embedding = await embeddingPromise;
    const annPool = await this.lanceDb.search(embedding, undefined, rankingLimit * overfetch);
    const annResults =
      overfetch <= 1
        ? annPool.slice(0, rankingLimit)
        : stratifyByDimension(annPool, query, rankingLimit, this.resolveDimOf(annPool));

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

  /**
   * Resuelve de qué fuente sale la dimensión de cada candidato del pool ANN:
   * - `kind` (default): la dimensión almacenada en el vector (proxy por KIND).
   * - `edge`: la dimensión *edge-derived* del grafo (`node_metadata.dimension`,
   *   argmax de `RELATION_TO_DIM` sobre aristas incidentes) — fiel a la tesis de
   *   que la dimensión vive en las aristas. Si el nodo no está en node_metadata,
   *   cae de vuelta a la dimensión del vector.
   * En modo `edge` se hace UNA consulta batched al grafo para todo el pool.
   */
  private resolveDimOf(pool: AnnSearchResult[]): (result: AnnSearchResult) => Dimension | undefined {
    if (resolveStringConfig("retrieval.annDimSource") !== "edge") {
      return (result) => result.dimension;
    }
    const edgeDims = this.db.getNodeDimensions(pool.map((result) => result.node_id));
    return (result) => edgeDims.get(result.node_id) ?? result.dimension;
  }
}

/**
 * Selecciona `limit` candidatos de un pool ANN sobre-traido, con cuotas por
 * dimension segun `getIntentWeights(intent, dimensions)`, y rellena los huecos
 * por orden ANN puro (best-first) para no perder recall cross-dimension.
 *
 * El pool viene ordenado por calidad ANN (best-first). El resultado se re-ordena
 * por posicion ANN original, de modo que la estratificacion decide *que* entra
 * al top-K pero el ranking dentro del subconjunto sigue siendo el de la ANN.
 * `dimOf` decide la fuente de dimension de cada candidato (KIND del vector vs
 * edge-derived del grafo). Candidatos con dimension indefinida solo participan
 * en la fase de relleno.
 */
function stratifyByDimension(
  pool: AnnSearchResult[],
  query: SanitizerOutput,
  limit: number,
  dimOf: (result: AnnSearchResult) => Dimension | undefined,
): AnnSearchResult[] {
  const weights = getIntentWeights(query.intent, query.dimensions);

  const byDim: Record<Dimension, AnnSearchResult[]> = { SYS: [], CPG: [], DTG: [] };
  for (const result of pool) {
    const dimension = dimOf(result);
    if (dimension && byDim[dimension]) byDim[dimension].push(result);
  }

  const picked = new Set<string>();
  const selected: AnnSearchResult[] = [];
  for (const dimension of DIMENSIONS) {
    const quota = Math.round(limit * weights[dimension]);
    for (const result of byDim[dimension].slice(0, quota)) {
      if (!picked.has(result.node_id)) {
        picked.add(result.node_id);
        selected.push(result);
      }
    }
  }

  // Relleno suave: completa hasta `limit` por orden ANN puro (incluye filas sin
  // dimension), preservando recall cross-dimension frente a un filtro duro.
  if (selected.length < limit) {
    for (const result of pool) {
      if (selected.length >= limit) break;
      if (!picked.has(result.node_id)) {
        picked.add(result.node_id);
        selected.push(result);
      }
    }
  }

  const poolIndex = new Map(pool.map((result, index) => [result.node_id, index]));
  return selected
    .sort((left, right) => poolIndex.get(left.node_id)! - poolIndex.get(right.node_id)!)
    .slice(0, limit);
}
