/**
 * ConsensusStrategy — Structural Consensus Retrieval.
 *
 * Las estrategias de grafo previas (ictd/clcr/rpr) convergen al hybrid por un
 * defecto ARQUITECTÓNICO: puntúan cada nodo expandido como
 * `score_ancla × decay < score_ancla`, y como `anchorLimit ≈ chunkLimit`, las
 * anclas semánticas copan la cabeza del ranking y la expansión solo rellena la
 * cola con nodos decaídos. Nunca pueden RESCATAR un nodo relevante que el
 * anclaje no vio — justo donde el grafo debería ganar: el caller / clase base /
 * hermano / consumidor de datos que es léxicamente mudo pero estructuralmente
 * central al cambio.
 *
 * Consensus ataca eso desacoplando la relevancia-de-grafo del decay-de-ancla:
 *   1. Ancla con BM25 + ANN + RRF (como hoy).
 *   2. Mira la vecindad 1-hop de TODAS las anclas, priorizando aristas ENTRANTES
 *      (`vecino -> ancla`: el caller/subclase/consumidor, donde suele vivir el fix).
 *   3. Puntúa cada vecino por CONSENSO: suma de los scores de las anclas
 *      INDEPENDIENTES que lo señalan, ponderada por dirección (entrante > saliente)
 *      y por relación×intent. Un nodo señalado por varias anclas es central al
 *      cambio aunque no comparta léxico con la query.
 *   4. Penaliza hubs (grado incidente alto = utilidad genérica, no específica).
 *   5. Fusiona anclas + nodos-consenso en UN solo ranking: un nodo de consenso
 *      alto PUEDE superar a un ancla débil. Ese interleave es el cambio clave que
 *      las estrategias actuales no hacen (su expansión siempre queda bajo el ancla).
 */

import type { ContextChunk } from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { AbstractAnchoredStrategy } from "./abstract-anchored-strategy.js";
import type { HybridAnchor } from "../utilities/search/hybrid-anchor-service.js";
import { RELATION_TO_DIM } from "../../domain/dimensions.js";
import { getIntentWeights } from "./helpers/intent-weights.js";

export interface ConsensusConfig {
  /** Anclas semánticas BM25+ANN. */
  anchorLimit: number;
  /** Top-K final de chunks. */
  chunkLimit: number;
  /** Tope de aristas a traer de la vecindad. */
  neighborhoodLimit: number;
  /** Peso de aristas ENTRANTES (caller/subclase/consumidor → donde suele estar el fix). */
  incomingWeight: number;
  /** Peso de aristas salientes (callee/dependencia). */
  outgoingWeight: number;
  /** Escala global del score de consenso frente al de las anclas. */
  consensusWeight: number;
  /** Bonus por cada ancla EXTRA que señala un nodo (centralidad estructural). */
  multiAnchorBonus: number;
  /** Fuerza de la penalización por grado incidente (hub). 0 = desactivada. */
  hubDampening: number;
  /**
   * Mínimo de anclas independientes que deben señalar un nodo para que pueda
   * INTERLEAVE entre las anclas. Con menos, su evidencia es débil (una sola
   * ancla) y se le capa a la cola. El rescate multi-hop viene del consenso ≥ este umbral.
   */
  interleaveMinAnchors: number;
  /**
   * Nº de anclas TOP que el consenso nunca puede desplazar (protege el match
   * semántico más fuerte para no degradar MRR en casos single-hop donde el gold
   * YA es un ancla). El consenso interleava por DEBAJO de ellas, alcanzando
   * rango 2..K — suficiente para rescatar el gold multi-hop en EditSiteHit@K.
   */
  topAnchorsProtected: number;
}

export const CONSENSUS_DEFAULT_CONFIG: Readonly<ConsensusConfig> = Object.freeze({
  anchorLimit: 30,
  chunkLimit: 50,
  neighborhoodLimit: 5000,
  incomingWeight: 1.0,
  outgoingWeight: 0.4,
  consensusWeight: 1.0,
  multiAnchorBonus: 0.5,
  hubDampening: 0.5,
  interleaveMinAnchors: 2,
  topAnchorsProtected: 1,
});

export class ConsensusStrategy extends AbstractAnchoredStrategy {
  private readonly config: ConsensusConfig;

  constructor(
    db: LaCoCoDatabase,
    lanceDb: LaCoCoLanceDb,
    config?: Partial<ConsensusConfig>,
  ) {
    super(db, lanceDb);
    this.config = { ...CONSENSUS_DEFAULT_CONFIG, ...config };
  }

  protected getAnchorLimit(): number {
    return this.config.anchorLimit;
  }

  protected async expand(anchors: HybridAnchor[], query: SanitizerOutput): Promise<ContextChunk[]> {
    const anchorScore = new Map<string, number>();
    for (const anchor of anchors) anchorScore.set(anchor.nodeId, anchor.score);
    const anchorIds = [...anchorScore.keys()];
    if (anchorIds.length === 0) return [];

    const weights = getIntentWeights(query.intent, query.dimensions);

    // Vecindad 1-hop de todas las anclas (con dirección en cada arista).
    const edges = this.db.edgeDao.getNeighborhood(anchorIds, { limit: this.config.neighborhoodLimit });

    // Consenso: acumula por vecino la contribución de cada ancla que lo señala.
    const consensus = new Map<string, number>();
    const anchorsHit = new Map<string, Set<string>>();
    for (const edge of edges) {
      const srcIsAnchor = anchorScore.has(edge.sourceId);
      const tgtIsAnchor = anchorScore.has(edge.targetId);
      let neighbor: string;
      let anchor: string;
      let dirWeight: number;
      if (tgtIsAnchor && !srcIsAnchor) {
        // `vecino(source) -> ancla(target)`: ENTRANTE al ancla (caller/subclase/consumidor).
        neighbor = edge.sourceId;
        anchor = edge.targetId;
        dirWeight = this.config.incomingWeight;
      } else if (srcIsAnchor && !tgtIsAnchor) {
        // `ancla(source) -> vecino(target)`: saliente (callee/dependencia).
        neighbor = edge.targetId;
        anchor = edge.sourceId;
        dirWeight = this.config.outgoingWeight;
      } else {
        continue; // ambos anclas o ninguno: no aporta consenso
      }
      const dim = RELATION_TO_DIM[edge.relation];
      const relWeight = dim ? weights[dim] : 1 / 3;
      const contribution = (anchorScore.get(anchor) ?? 0) * dirWeight * relWeight;
      consensus.set(neighbor, (consensus.get(neighbor) ?? 0) + contribution);
      if (!anchorsHit.has(neighbor)) anchorsHit.set(neighbor, new Set());
      anchorsHit.get(neighbor)!.add(anchor);
    }

    // Sin vecindad útil → degradar a las anclas (equivalente a hybrid).
    if (consensus.size === 0) {
      return anchors.map((anchor) => this.toChunk(anchor, "CONSENSUS"));
    }

    // Grado incidente de los candidatos, para penalizar hubs.
    const consensusIds = [...consensus.keys()];
    const degree = new Map<string, number>();
    if (this.config.hubDampening > 0) {
      for (const row of this.db.edgeDao.getIncidentRelations(consensusIds)) {
        degree.set(row.nodeId, (degree.get(row.nodeId) ?? 0) + 1);
      }
    }

    // Techos de interleave. Consenso débil (< interleaveMinAnchors) → cola (bajo la
    // peor ancla). Consenso fuerte → puede interleavar PERO nunca por encima de las
    // `topAnchorsProtected` anclas top (protege el match semántico fuerte del single-hop).
    const anchorScoresDesc = [...anchorScore.values()].sort((left, right) => right - left);
    const weakCap = (anchorScoresDesc.at(-1) ?? 0) * 0.99;
    const strongCap = anchorScoresDesc[
      Math.min(this.config.topAnchorsProtected, anchorScoresDesc.length - 1)
    ] ?? 0;

    // Score de consenso: contribución × (1 + bonus·(anclas−1)) / dampening(grado).
    const finalScore = new Map<string, number>(anchorScore);
    for (const id of consensusIds) {
      const raw = consensus.get(id) ?? 0;
      const hits = anchorsHit.get(id)?.size ?? 1;
      const bonus = 1 + this.config.multiAnchorBonus * (hits - 1);
      const damp = this.config.hubDampening > 0
        ? 1 + this.config.hubDampening * Math.log2(1 + (degree.get(id) ?? 0))
        : 1;
      let score = (this.config.consensusWeight * raw * bonus) / damp;
      score = Math.min(score, hits < this.config.interleaveMinAnchors ? weakCap : strongCap);
      // Interleave por debajo de las anclas protegidas; nunca subordinado al decay.
      finalScore.set(id, Math.max(finalScore.get(id) ?? 0, score));
    }

    const ranked = [...finalScore.entries()]
      .filter(([, score]) => score > 0)
      .sort((left, right) => right[1] - left[1])
      .slice(0, this.config.chunkLimit)
      .map(([id]) => id);

    // Texto: las anclas ya lo traen; los nodos de consenso vía firmas.
    const anchorText = new Map(anchors.map((anchor) => [anchor.nodeId, anchor.text]));
    const needSig = ranked.filter((id) => !anchorText.has(id));
    const sigs = needSig.length > 0 ? this.db.getNodeSignatures(needSig) : new Map<string, string>();

    return ranked.map((id) => ({
      chunkId: id,
      nodeId: id,
      score: finalScore.get(id) ?? 0,
      text: anchorText.get(id) ?? sigs.get(id) ?? id,
      source: anchorScore.has(id) ? "RRF" : "CONSENSUS",
    }));
  }
}
