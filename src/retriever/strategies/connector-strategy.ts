/**
 * ConnectorStrategy — Structural Connector Retrieval (SCR).
 *
 * Mecanismo NUEVO frente a las estrategias de grafo existentes: en vez de
 * *esparcir* relevancia desde las anclas (difusión=ictd, PageRank=ppr,
 * voto-1-hop=consensus, proximidad plana=repograph, cascada=clcr), puntúa por
 * CONECTIVIDAD tipada ENTRE anclas. Intuición de reparación de programas: el
 * edit-site es a menudo el nodo que CONECTA los síntomas — punto de articulación,
 * dependencia compartida o ancestro común de los símbolos que la query toca
 * ("el fix vive en la confluencia de los síntomas").
 *
 * Algoritmo:
 *   1. Anclas BM25 + ANN + RRF (como todas).
 *   2. Subgrafo inducido; aristas NO dirigidas con COSTO TIPADO
 *      w(e) = 1 / weight_dim(intent) → los caminos prefieren la dimensión
 *      relevante a la intención (SYS/CPG/DTG).
 *   3. Dijkstra entre pares de las top-M anclas; cada NODO INTERNO de un camino
 *      más corto acumula confluencia ponderada por los scores de las anclas y
 *      decaída por longitud, con amortiguación de hubs.
 *   4. Inyección guardada: las anclas conservan su score semántico; los conectores
 *      no-ancla se inyectan ESCALADOS por confluencia y CAPADOS por debajo de la
 *      ancla `topAnchorsProtected`. Rescata el conector multi-hop SIN sacrificar el
 *      gold-ancla — resuelve la tensión rescate↔regresión que hunde al consenso
 *      (que pierde el gold-ancla al interleavar el multi-hop). Un RRF plano falla
 *      aquí: expulsa las anclas de rango medio bajo los conectores.
 *
 * Determinista, costo cero de inferencia. Nicho frente al SOTA: RepoGraph/Aider
 * son type-blind; LocAgent/CoSIL son tipados pero con LLM en el loop de ranking.
 */

import type { ContextChunk } from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { AbstractAnchoredStrategy } from "./abstract-anchored-strategy.js";
import type { HybridAnchor } from "../utilities/search/hybrid-anchor-service.js";
import { RELATION_TO_DIM } from "../../domain/dimensions.js";
import { getIntentWeights } from "./helpers/intent-weights.js";
import { breadthFirstTraversal } from "./helpers/graph-traversal.js";
import {
  anchorConfluence,
  type WeightedEdge,
} from "./helpers/anchor-confluence.js";

export interface ConnectorConfig {
  /** Anclas semánticas BM25+ANN. */
  anchorLimit: number;
  /** Top-K final de chunks. */
  chunkLimit: number;
  /** Radio del subgrafo inducido. */
  subgraphMaxHops: number;
  /** Tope de nodos visitados al inducir el subgrafo. */
  bfsMaxNodes: number;
  /** Nº de anclas TOP entre las que se buscan caminos (cota M²·Dijkstra). */
  maxPathAnchors: number;
  /** Decaimiento por longitud del camino en la confluencia. */
  pathDecay: number;
  /** Fuerza de la penalización por grado incidente (hub). 0 = desactivada. */
  hubDampening: number;
  /**
   * Nº de anclas TOP que los conectores nunca pueden desplazar (protege el match
   * semántico fuerte). Los conectores se inyectan por DEBAJO de la ancla número
   * `topAnchorsProtected`, ordenados por confluencia — así se rescata el conector
   * multi-hop SIN sacrificar el gold-ancla (a diferencia del RRF plano, que
   * expulsa las anclas de rango medio).
   */
  topAnchorsProtected: number;
}

export const CONNECTOR_DEFAULT_CONFIG: Readonly<ConnectorConfig> = Object.freeze({
  anchorLimit: 30,
  chunkLimit: 50,
  subgraphMaxHops: 3,
  bfsMaxNodes: 5000,
  maxPathAnchors: 15,
  pathDecay: 0.6,
  hubDampening: 0.5,
  topAnchorsProtected: 3,
});

export class ConnectorStrategy extends AbstractAnchoredStrategy {
  private readonly config: ConnectorConfig;

  constructor(
    db: LaCoCoDatabase,
    lanceDb: LaCoCoLanceDb,
    config?: Partial<ConnectorConfig>,
  ) {
    super(db, lanceDb);
    this.config = { ...CONNECTOR_DEFAULT_CONFIG, ...config };
  }

  protected getAnchorLimit(): number {
    return this.config.anchorLimit;
  }

  protected async expand(anchors: HybridAnchor[], query: SanitizerOutput): Promise<ContextChunk[]> {
    const anchorScore = new Map<string, number>();
    for (const anchor of anchors) anchorScore.set(anchor.nodeId, anchor.score);
    const anchorIds = [...anchorScore.keys()];
    if (anchorIds.length === 0) return [];

    // <2 anclas → no hay pares que conectar; degradar a las anclas (≈ hybrid).
    if (anchorIds.length < 2) {
      return anchors.map((anchor) => this.toChunk(anchor, "CONNECTOR"));
    }

    const weights = getIntentWeights(query.intent, query.dimensions);

    // Subgrafo inducido; aristas con costo tipado (dimensión relevante = más barata).
    const traversal = breadthFirstTraversal(this.db.edgeDao, anchorIds, {
      maxHops: this.config.subgraphMaxHops,
      maxNodes: this.config.bfsMaxNodes,
    });

    if (traversal.edges.length === 0) {
      return anchors.map((anchor) => this.toChunk(anchor, "CONNECTOR"));
    }

    const weightedEdges: WeightedEdge[] = traversal.edges.map((edge) => {
      const dim = RELATION_TO_DIM[edge.relation];
      const relevance = dim ? weights[dim] : 1 / 3;
      return { a: edge.sourceId, b: edge.targetId, weight: 1 / relevance };
    });

    // Grado incidente para amortiguar hubs.
    const degree = new Map<string, number>();
    if (this.config.hubDampening > 0) {
      const nodes = [...traversal.visited];
      for (const row of this.db.edgeDao.getIncidentRelations(nodes)) {
        degree.set(row.nodeId, (degree.get(row.nodeId) ?? 0) + 1);
      }
    }

    // Top-M anclas por score como semillas de caminos.
    const pathAnchors = [...anchorScore.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, this.config.maxPathAnchors)
      .map(([id, score]) => ({ id, score }));

    const confluence = anchorConfluence(weightedEdges, pathAnchors, degree, {
      pathDecay: this.config.pathDecay,
      hubDampening: this.config.hubDampening,
    });

    // Sin conectores internos → degradar a las anclas.
    if (confluence.size === 0) {
      return anchors.map((anchor) => this.toChunk(anchor, "CONNECTOR"));
    }

    // Inyección guardada (NO RRF plano, que expulsa las anclas de rango medio):
    // las anclas conservan su score semántico; los conectores NO-ancla se inyectan
    // por DEBAJO de la ancla `topAnchorsProtected` (cap = su score), escalados por
    // confluencia. Así se rescata el conector multi-hop sin sacrificar el gold-ancla.
    const anchorScoresDesc = [...anchorScore.values()].sort((left, right) => right - left);
    const capIndex = Math.min(this.config.topAnchorsProtected, anchorScoresDesc.length - 1);
    const strongCap = (anchorScoresDesc[capIndex] ?? 0) * 0.999;
    let maxConfluence = 0;
    for (const value of confluence.values()) if (value > maxConfluence) maxConfluence = value;

    const finalScore = new Map<string, number>(anchorScore);
    if (maxConfluence > 0) {
      for (const [id, value] of confluence) {
        if (anchorScore.has(id)) continue; // las anclas ya tienen su score semántico
        finalScore.set(id, strongCap * (value / maxConfluence));
      }
    }

    const ranked = [...finalScore.entries()]
      .filter(([, score]) => score > 0)
      .sort((left, right) => right[1] - left[1])
      .slice(0, this.config.chunkLimit)
      .map(([id]) => id);

    const anchorText = new Map(anchors.map((anchor) => [anchor.nodeId, anchor.text]));
    const needSig = ranked.filter((id) => !anchorText.has(id));
    const sigs = needSig.length > 0 ? this.db.getNodeSignatures(needSig) : new Map<string, string>();

    return ranked.map((id) => ({
      chunkId: id,
      nodeId: id,
      score: finalScore.get(id) ?? 0,
      text: anchorText.get(id) ?? sigs.get(id) ?? id,
      source: anchorScore.has(id) ? "RRF" : "CONNECTOR",
    }));
  }
}
