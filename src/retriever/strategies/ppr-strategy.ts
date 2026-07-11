/**
 * PprStrategy — baseline de PageRank Personalizado (la receta del repo-map de Aider).
 *
 * Centralidad multi-hop sobre el subgrafo inducido por las anclas, con el vector
 * de personalización sesgado hacia las anclas (query-hits). La caminata con
 * reinicio propaga la señal de las anclas a K saltos con decaimiento, alcanzando el
 * helper interno que ninguna búsqueda directa toca. Es exactamente PageRank
 * personalizado sobre aristas del compilador (no imports de texto).
 *
 * Su papel es de LÍNEA BASE FUERTE para el aislamiento del consenso
 * (`docs/posicionamiento-novedad.md`): es un ranker de grafo ponderado por
 * centralidad pero AGNÓSTICO A LA INTENCIÓN (todas las aristas pesan igual). Si
 * `consensus` lo bate, el delta atribuible es la ponderación por dimensión-de-
 * intención — la contribución defendible. También es la propuesta C3
 * (`docs/propuestas-innovadoras.md`); aquí se evalúa en su forma de baseline puro
 * (ranking por PPR directo, sin fusión RRF, para no contaminar la comparación).
 */

import type { ContextChunk } from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { AbstractAnchoredStrategy } from "./abstract-anchored-strategy.js";
import type { HybridAnchor } from "../utilities/search/hybrid-anchor-service.js";
import { breadthFirstTraversal } from "./helpers/graph-traversal.js";
import { personalizedPageRank } from "./helpers/pagerank.js";

export interface PprConfig {
  /** Anclas semánticas BM25+ANN (semillas de personalización). */
  anchorLimit: number;
  /** Top-K final de chunks. */
  chunkLimit: number;
  /** Radio del subgrafo inducido sobre el que corre PPR. */
  subgraphMaxHops: number;
  /** Tope de nodos visitados al inducir el subgrafo. */
  bfsMaxNodes: number;
  /** Factor de amortiguación de PageRank (canónico 0.85). */
  damping: number;
  /** Tope de iteraciones de la caminata de potencia. */
  iterations: number;
  /** Corte por convergencia L1. */
  tolerance: number;
}

export const PPR_DEFAULT_CONFIG: Readonly<PprConfig> = Object.freeze({
  anchorLimit: 30,
  chunkLimit: 50,
  subgraphMaxHops: 3,
  bfsMaxNodes: 5000,
  damping: 0.85,
  iterations: 40,
  tolerance: 1e-6,
});

export class PprStrategy extends AbstractAnchoredStrategy {
  private readonly config: PprConfig;

  constructor(
    db: LaCoCoDatabase,
    lanceDb: LaCoCoLanceDb,
    config?: Partial<PprConfig>,
  ) {
    super(db, lanceDb);
    this.config = { ...PPR_DEFAULT_CONFIG, ...config };
  }

  protected getAnchorLimit(): number {
    return this.config.anchorLimit;
  }

  protected async expand(anchors: HybridAnchor[], _query: SanitizerOutput): Promise<ContextChunk[]> {
    const anchorScore = new Map<string, number>();
    for (const anchor of anchors) anchorScore.set(anchor.nodeId, anchor.score);
    const anchorIds = [...anchorScore.keys()];
    if (anchorIds.length === 0) return [];

    // Subgrafo inducido: nodos + aristas internas alcanzables desde las anclas.
    const traversal = breadthFirstTraversal(this.db.edgeDao, anchorIds, {
      maxHops: this.config.subgraphMaxHops,
      maxNodes: this.config.bfsMaxNodes,
    });

    // Sin vecindad útil → degradar a las anclas (equivalente a hybrid).
    if (traversal.edges.length === 0) {
      return anchors.map((anchor) => this.toChunk(anchor, "PPR"));
    }

    // Personalización = score de las anclas (el helper la normaliza a suma 1).
    const scores = personalizedPageRank(
      [...traversal.visited],
      traversal.edges,
      anchorScore,
      {
        damping: this.config.damping,
        iterations: this.config.iterations,
        tolerance: this.config.tolerance,
      },
    );

    const ranked = [...scores.entries()]
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
      score: scores.get(id) ?? 0,
      text: anchorText.get(id) ?? sigs.get(id) ?? id,
      source: "PPR",
    }));
  }
}
