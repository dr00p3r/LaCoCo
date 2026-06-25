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

import {
  type RecoveryStrategy,
  type ContextChunk,
} from "../models/strategies/types.js";
import type { SanitizerOutput, IntentTag } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { HybridAnchorService } from "../utilities/search/hybrid-anchor-service.js";

const DIM_MAP: Record<string, "SYS" | "CPG" | "DTG"> = {
  EXTENDS: "SYS",
  IMPLEMENTS: "SYS",
  IMPORTS_EXTERNAL: "SYS",
  INJECTS: "CPG",
  CALLS: "CPG",
  INSTANTIATES: "CPG",
  CONSUMES_DATA: "DTG",
  PRODUCES: "DTG",
  MUTATES_STATE: "DTG",
};

const INTENT_WEIGHTS: Record<IntentTag, { SYS: number; CPG: number; DTG: number }> = {
  debug:      { SYS: 0.30, CPG: 0.40, DTG: 0.30 },
  refactor:   { SYS: 0.40, CPG: 0.40, DTG: 0.20 },
  create:     { SYS: 0.50, CPG: 0.30, DTG: 0.20 },
  integrate:  { SYS: 0.30, CPG: 0.20, DTG: 0.50 },
  understand: { SYS: 0.35, CPG: 0.35, DTG: 0.30 },
  unknown:    { SYS: 0.34, CPG: 0.33, DTG: 0.33 },
};

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

type Dim = "SYS" | "CPG" | "DTG";

interface DimNeighbors {
  SYS: string[];
  CPG: string[];
  DTG: string[];
}

function emptyNeighbors(): DimNeighbors {
  return { SYS: [], CPG: [], DTG: [] };
}

export class IctdStrategy implements RecoveryStrategy {
  private readonly config: IctdConfig;
  private readonly anchors: HybridAnchorService;

  constructor(
    private readonly db: LaCoCoDatabase,
    lanceDb: LaCoCoLanceDb,
    config?: Partial<IctdConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.anchors = new HybridAnchorService(db, lanceDb);
  }

  /**
   * Recupera contexto aplicando difusión tensorial condicionada por intención.
   *
   * @param query Salida sanitizada del intermediario.
   * @returns Chunks ordenados por temperatura final de difusión.
   */
  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    const weights = this.#computeWeights(query.intent, query.dimensions);

    const anchorResults = (await this.anchors.search(query, this.config.anchorLimit))
      .slice(0, this.config.anchorLimit);
    if (anchorResults.length === 0) return [];

    const anchorIds = new Set<string>();
    const anchorHeat = new Map<string, number>();
    for (const r of anchorResults) {
      anchorHeat.set(r.nodeId, r.score);
      anchorIds.add(r.nodeId);
    }

    const { outAdj, inDeg } = this.#buildSubgraph(Array.from(anchorIds));

    if (outAdj.size === 0) {
      const sigs = this.db.getNodeSignatures(Array.from(anchorIds));
      return anchorResults.map((r) => ({
        nodeId: r.nodeId,
        score: anchorHeat.get(r.nodeId) ?? 0.5,
        text: sigs.get(r.nodeId) ?? r.nodeId,
        source: "ICTD",
      }));
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

  #computeWeights(
    intent: IntentTag,
    dimensions: ("SYS" | "CPG" | "DTG")[]
  ): { SYS: number; CPG: number; DTG: number } {
    const base = { ...INTENT_WEIGHTS[intent] };

    if (dimensions.length > 0 && dimensions.length < 3) {
      for (const dim of dimensions) {
        base[dim] *= 1.5;
      }
    }

    const total = base.SYS + base.CPG + base.DTG;
    if (total > 0) {
      base.SYS /= total;
      base.CPG /= total;
      base.DTG /= total;
    }

    return base;
  }

  #buildSubgraph(
    anchorIds: string[]
  ): {
    outAdj: Map<string, DimNeighbors>;
    inDeg: Map<string, { SYS: number; CPG: number; DTG: number }>;
  } {
    const rawDb = this.db.getRawDb();
    const outAdj = new Map<string, DimNeighbors>();
    const inDeg = new Map<string, { SYS: number; CPG: number; DTG: number }>();

    let frontier = new Set(anchorIds);
    const visited = new Set<string>();

    for (let hop = 0; hop < this.config.maxHops && frontier.size > 0; hop++) {
      const frontierArr = Array.from(frontier);
      const placeholders = frontierArr.map(() => "?").join(",");

      const sql = `
        SELECT sourceId, targetId, relation
        FROM edges
        WHERE sourceId IN (${placeholders}) OR targetId IN (${placeholders})
        LIMIT 5000
      `;

      const params = [...frontierArr, ...frontierArr];
      const edges = rawDb.prepare(sql).all(...params) as {
        sourceId: string;
        targetId: string;
        relation: string;
      }[];

      const nextFrontier = new Set<string>();

      for (const edge of edges) {
        const dim = DIM_MAP[edge.relation];
        if (!dim) continue;

        if (!outAdj.has(edge.sourceId)) {
          outAdj.set(edge.sourceId, emptyNeighbors());
        }
        outAdj.get(edge.sourceId)![dim].push(edge.targetId);

        const currentIn = inDeg.get(edge.targetId) ?? { SYS: 0, CPG: 0, DTG: 0 };
        currentIn[dim]++;
        inDeg.set(edge.targetId, currentIn);

        if (!anchorIds.includes(edge.sourceId) && !visited.has(edge.sourceId)) {
          nextFrontier.add(edge.sourceId);
        }
        if (!anchorIds.includes(edge.targetId) && !visited.has(edge.targetId)) {
          nextFrontier.add(edge.targetId);
        }
      }

      for (const id of frontierArr) visited.add(id);
      frontier = new Set(
        Array.from(nextFrontier).filter((id) => !visited.has(id))
      );

      if (outAdj.size + frontier.size > this.config.bfsMaxNodes) break;
    }

    for (const id of anchorIds) {
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
