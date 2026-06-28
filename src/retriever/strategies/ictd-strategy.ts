/**
 * IctdStrategy (2.6) — Intent-Conditioned Tensor Diffusion.
 *
 * La relevancia no depende únicamente de similitud textual sino de la
 * capacidad de un nodo para propagar influencia dentro del tensor
 * multirrelacional de 3 capas (SYS / CPG / DTG).
 *
 * Algoritmo:
 *   1. Anclas híbridas vía BM25 + ANN + RRF
 *   2. Subgrafo local vía BFS bidireccional (máx 2 hops)
 *   3. Vector de calor inicial desde scores RRF
 *   4. Difusión iterativa: cada arista propaga calor ponderado por
 *      la intención de la consulta sobre su dimensión
 *   5. Los nodos con mayor temperatura final forman el contexto
 */

import type { ContextChunk } from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { AbstractAnchoredStrategy } from "./abstract-anchored-strategy.js";
import type { HybridAnchor } from "../utilities/search/hybrid-anchor-service.js";
import { RELATION_TO_DIM, type Dimension } from "../../domain/dimensions.js";
import { getIntentWeights } from "./helpers/intent-weights.js";
import { breadthFirstTraversal } from "./helpers/graph-traversal.js";

export interface IctdConfig {
  anchorLimit: number;
  maxIterations: number;
  restartProb: number;
  epsilon: number;
  chunkLimit: number;
  bfsMaxNodes: number;
  maxHops: number;
}

const DEFAULT_CONFIG: IctdConfig = {
  anchorLimit: 30,
  maxIterations: 10,
  restartProb: 0.2,
  epsilon: 1e-6,
  chunkLimit: 50,
  bfsMaxNodes: 5000,
  maxHops: 2,
};

type Dim = Dimension;

interface DimNeighbors {
  SYS: string[];
  CPG: string[];
  DTG: string[];
}

function emptyNeighbors(): DimNeighbors {
  return { SYS: [], CPG: [], DTG: [] };
}

export class IctdStrategy extends AbstractAnchoredStrategy {
  private readonly config: IctdConfig;

  constructor(
    db: LaCoCoDatabase,
    lanceDb: LaCoCoLanceDb,
    config?: Partial<IctdConfig>
  ) {
    super(db, lanceDb);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  protected getAnchorLimit(): number {
    return this.config.anchorLimit;
  }

  protected async expand(anchorResults: HybridAnchor[], query: SanitizerOutput): Promise<ContextChunk[]> {
    const weights = getIntentWeights(query.intent, query.dimensions);

    const anchorIds = new Set<string>();
    const anchorHeat = new Map<string, number>();
    for (const r of anchorResults) {
      anchorHeat.set(r.nodeId, r.score);
      anchorIds.add(r.nodeId);
    }

    const { outAdj, inDeg } = this.#buildSubgraph(Array.from(anchorIds));

    if (outAdj.size === 0) {
      return anchorResults.map((anchor) =>
        this.toChunk(anchor, "ICTD", anchorHeat.get(anchor.nodeId) ?? 0.5)
      );
    }

    const allIds = Array.from(outAdj.keys());
    let heat = new Map<string, number>();
    const init = new Map<string, number>();
    for (const id of allIds) {
      init.set(id, anchorHeat.get(id) ?? 0);
      heat.set(id, anchorHeat.get(id) ?? 0);
    }

    const alpha = this.config.restartProb;
    for (let iter = 0; iter < this.config.maxIterations; iter++) {
      const next = new Map<string, number>();
      for (const id of allIds) next.set(id, 0);

      for (const [src, dims] of outAdj) {
        const hSrc = heat.get(src) ?? 0;
        for (const dim of ["SYS", "CPG", "DTG"] as Dim[]) {
          const tgts = dims[dim];
          if (tgts.length === 0) continue;
          const w = weights[dim];

          if (hSrc > 0) {
            const contrib = (hSrc * w) / tgts.length;
            for (const tgt of tgts) {
              next.set(tgt, (next.get(tgt) ?? 0) + contrib);
            }
          }

          for (const tgt of tgts) {
            const hTgt = heat.get(tgt) ?? 0;
            if (hTgt <= 0) continue;
            const deg = inDeg.get(tgt)?.[dim] ?? 1;
            const contrib = (hTgt * w) / deg;
            next.set(src, (next.get(src) ?? 0) + contrib);
          }
        }
      }

      for (const id of allIds) {
        const val = next.get(id) ?? 0;
        next.set(id, val * (1 - alpha) + (init.get(id) ?? 0) * alpha);
      }

      let maxDiff = 0;
      for (const id of allIds) {
        const diff = Math.abs((next.get(id) ?? 0) - (heat.get(id) ?? 0));
        if (diff > maxDiff) maxDiff = diff;
      }

      heat = next;
      if (maxDiff < this.config.epsilon) break;
    }

    const ranked = allIds
      .filter((id) => (heat.get(id) ?? 0) > 0.001)
      .sort((a, b) => (heat.get(b) ?? 0) - (heat.get(a) ?? 0))
      .slice(0, this.config.chunkLimit);

    const sigs = this.db.getNodeSignatures(ranked);

    return ranked.map((id) => ({
      nodeId: id,
      score: heat.get(id) ?? 0,
      text: sigs.get(id) ?? id,
      source: "ICTD",
    }));
  }

  #buildSubgraph(
    anchorIds: string[]
  ): {
    outAdj: Map<string, DimNeighbors>;
    inDeg: Map<string, { SYS: number; CPG: number; DTG: number }>;
  } {
    const outAdj = new Map<string, DimNeighbors>();
    const inDeg = new Map<string, { SYS: number; CPG: number; DTG: number }>();

    const traversal = breadthFirstTraversal(this.db.edgeDao, anchorIds, {
      maxHops: this.config.maxHops,
      maxNodes: this.config.bfsMaxNodes,
    });

    for (const edge of traversal.edges) {
        const dim = RELATION_TO_DIM[edge.relation];
        if (!dim) continue;

        if (!outAdj.has(edge.sourceId)) {
          outAdj.set(edge.sourceId, emptyNeighbors());
        }
        outAdj.get(edge.sourceId)![dim].push(edge.targetId);

        const currentIn = inDeg.get(edge.targetId) ?? { SYS: 0, CPG: 0, DTG: 0 };
        currentIn[dim]++;
        inDeg.set(edge.targetId, currentIn);

    }

    for (const id of traversal.visited) {
      if (!outAdj.has(id)) {
        outAdj.set(id, emptyNeighbors());
      }
      if (!inDeg.has(id)) {
        inDeg.set(id, { SYS: 0, CPG: 0, DTG: 0 });
      }
    }

    return { outAdj, inDeg };
  }
}
