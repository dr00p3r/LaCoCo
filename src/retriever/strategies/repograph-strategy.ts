/**
 * RepographStrategy — baseline de ego-graph plano.
 *
 * Reimplementa el mecanismo genérico de los rankers de grafo publicados
 * (RepoGraph y similares): expandir el vecindario a K saltos desde las anclas y
 * puntuar cada nodo por PURA PROXIMIDAD estructural, sin dirección de arista, sin
 * dimensión, sin intención y sin penalización de hubs. Es `clcr` despojado del
 * filtro de dimensión dominante y del boost cross-layer.
 *
 * Su papel es de LÍNEA BASE (piso) para el experimento de aislamiento del
 * consenso (`docs/posicionamiento-novedad.md`): si `consensus` lo bate, demuestra
 * que no basta con "tener el grafo" — la ponderación importa. Deliberadamente
 * agnóstico a la query más allá de las anclas semilla.
 */

import type { ContextChunk } from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { AbstractAnchoredStrategy } from "./abstract-anchored-strategy.js";
import type { HybridAnchor } from "../utilities/search/hybrid-anchor-service.js";
import { breadthFirstTraversal } from "./helpers/graph-traversal.js";
import { decayScore } from "./helpers/score-decay.js";

export interface RepographConfig {
  /** Anclas semánticas BM25+ANN. */
  anchorLimit: number;
  /** Top-K final de chunks. */
  chunkLimit: number;
  /** Radio de expansión del ego-graph (saltos). */
  maxHops: number;
  /** Tope de nodos visitados en la BFS. */
  bfsMaxNodes: number;
  /** Decaimiento por salto de la relevancia propagada. */
  decay: number;
}

export const REPOGRAPH_DEFAULT_CONFIG: Readonly<RepographConfig> = Object.freeze({
  anchorLimit: 30,
  chunkLimit: 50,
  maxHops: 2,
  bfsMaxNodes: 5000,
  decay: 0.5,
});

export class RepographStrategy extends AbstractAnchoredStrategy {
  private readonly config: RepographConfig;

  constructor(
    db: LaCoCoDatabase,
    lanceDb: LaCoCoLanceDb,
    config?: Partial<RepographConfig>,
  ) {
    super(db, lanceDb);
    this.config = { ...REPOGRAPH_DEFAULT_CONFIG, ...config };
  }

  protected getAnchorLimit(): number {
    return this.config.anchorLimit;
  }

  protected async expand(anchors: HybridAnchor[], _query: SanitizerOutput): Promise<ContextChunk[]> {
    const baseScore = new Map<string, number>();
    for (const anchor of anchors) baseScore.set(anchor.nodeId, anchor.score);
    const anchorIds = [...baseScore.keys()];
    if (anchorIds.length === 0) return [];

    // Ego-graph plano: TODAS las relaciones por igual (sin filtro dimensional).
    const traversal = breadthFirstTraversal(this.db.edgeDao, anchorIds, {
      maxHops: this.config.maxHops,
      maxNodes: this.config.bfsMaxNodes,
    });

    // Sin vecindad útil → degradar a las anclas (equivalente a hybrid).
    if (traversal.discoveries.length === 0) {
      return anchors.map((anchor) => this.toChunk(anchor, "REPOGRAPH"));
    }

    // Propaga por proximidad: cada nodo toma el mejor camino desde un ancla.
    for (const discovery of traversal.discoveries) {
      const propagated = decayScore(baseScore.get(discovery.from) ?? 0, this.config.decay, discovery.depth);
      baseScore.set(
        discovery.nodeId,
        Math.max(baseScore.get(discovery.nodeId) ?? 0, propagated),
      );
    }

    const ranked = [...baseScore.entries()]
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
      score: baseScore.get(id) ?? 0,
      text: anchorText.get(id) ?? sigs.get(id) ?? id,
      source: "REPOGRAPH",
    }));
  }
}
