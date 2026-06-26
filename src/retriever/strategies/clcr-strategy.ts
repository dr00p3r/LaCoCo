/**
 * ClcrStrategy (2.7) — Cross-Layer Cascade Retrieval.
 *
 * La información más útil suele encontrarse en nodos que conectan múltiples
 * dimensiones del tensor. Los puntos donde convergen estructura (SYS), flujo
 * de datos (DTG) y control (CPG) representan dependencias críticas que un
 * retrieval textual no detecta.
 *
 * Algoritmo:
 *   1. Determinar dimensión dominante según intent de la consulta
 *   2. BFS sobre la capa primaria desde anclas híbridas BM25 + ANN + RRF
 *   3. Cascade hacia las otras 2 dimensiones (1 hop c/u)
 *   4. Cross-layer score: contar en cuántas dimensiones participa cada nodo
 *   5. Boost = 1 + λ × (layerCount − 1), λ = 0.25
 *   6. Top-K por score final
 */

import type { ContextChunk } from "../models/strategies/types.js";
import type { SanitizerOutput, IntentTag } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { AbstractAnchoredStrategy } from "./abstract-anchored-strategy.js";
import type { HybridAnchor } from "../utilities/search/hybrid-anchor-service.js";
import { DIMENSIONS, RELATION_TO_DIM, type Dimension } from "../../domain/dimensions.js";

type Dim = Dimension;
const ALL_DIMS: Dim[] = [...DIMENSIONS];

const DIM_RELATIONS = Object.entries(RELATION_TO_DIM).reduce<Record<Dim, string[]>>(
  (relationsByDim, [relation, dimension]) => {
    relationsByDim[dimension].push(relation);
    return relationsByDim;
  },
  { SYS: [], CPG: [], DTG: [] },
);

const INTENT_WEIGHTS: Record<IntentTag, { SYS: number; CPG: number; DTG: number }> = {
  debug:      { SYS: 0.30, CPG: 0.40, DTG: 0.30 },
  refactor:   { SYS: 0.40, CPG: 0.40, DTG: 0.20 },
  create:     { SYS: 0.50, CPG: 0.30, DTG: 0.20 },
  integrate:  { SYS: 0.30, CPG: 0.20, DTG: 0.50 },
  understand: { SYS: 0.35, CPG: 0.35, DTG: 0.30 },
  unknown:    { SYS: 0.34, CPG: 0.33, DTG: 0.33 },
};

export interface ClcrConfig {
  anchorLimit: number;
  primaryHops: number;
  cascadeHops: number;
  chunkLimit: number;
  bfsMaxNodes: number;
  lambda: number;
}

const DEFAULT_CONFIG: ClcrConfig = {
  anchorLimit: 30,
  primaryHops: 2,
  cascadeHops: 1,
  chunkLimit: 50,
  bfsMaxNodes: 5000,
  lambda: 0.25,
};

interface Edge {
  sourceId: string;
  targetId: string;
  relation: string;
}

export class ClcrStrategy extends AbstractAnchoredStrategy {
  private readonly config: ClcrConfig;

  constructor(
    db: LaCoCoDatabase,
    lanceDb: LaCoCoLanceDb,
    config?: Partial<ClcrConfig>
  ) {
    super(db, lanceDb);
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  protected getAnchorLimit(): number {
    return this.config.anchorLimit;
  }

  protected async expand(anchorResults: HybridAnchor[], query: SanitizerOutput): Promise<ContextChunk[]> {
    const dominant = this.#computeDominant(query.intent, query.dimensions);
    const cascadeDims = ALL_DIMS.filter((d) => d !== dominant);

    const baseScore = new Map<string, number>();
    const anchorSet = new Set<string>();
    for (const r of anchorResults) {
      baseScore.set(r.nodeId, r.score);
      anchorSet.add(r.nodeId);
    }

    const anchorIds = Array.from(anchorSet);

    const primarySet = new Set(anchorIds);
    let frontier = new Set(anchorIds);

    for (let hop = 0; hop < this.config.primaryHops && frontier.size > 0; hop++) {
      const relations = DIM_RELATIONS[dominant];
      const frontierArr = Array.from(frontier);
      const edges = this.db.edgeDao.getNeighborhood(frontierArr, {
        limit: this.config.bfsMaxNodes,
        relations,
      }) as Edge[];

      const nextFrontier = new Set<string>();
      for (const edge of edges) {
        const otherId = frontier.has(edge.sourceId)
          ? edge.targetId
          : edge.sourceId;
        if (primarySet.has(otherId)) continue;

        primarySet.add(otherId);
        nextFrontier.add(otherId);

        const srcScore = baseScore.get(
          frontier.has(edge.sourceId) ? edge.sourceId : edge.targetId
        ) ?? 0;
        const decay = Math.pow(0.5, hop + 1);
        const propagated = srcScore * decay;
        baseScore.set(
          otherId,
          Math.max(baseScore.get(otherId) ?? 0, propagated)
        );
      }

      frontier = nextFrontier;

      if (primarySet.size + nextFrontier.size > this.config.bfsMaxNodes) break;
    }

    if (primarySet.size === 0) {
      return anchorResults.map((anchor) =>
        this.toChunk(anchor, "CLCR", baseScore.get(anchor.nodeId) ?? 0.5)
      );
    }

    const reachedBy = new Map<string, Set<Dim>>();
    for (const id of primarySet) {
      reachedBy.set(id, new Set([dominant]));
    }

    for (const cascadeDim of cascadeDims) {
      frontier = primarySet;
      for (
        let hop = 0;
        hop < this.config.cascadeHops && frontier.size > 0;
        hop++
      ) {
        const relations = DIM_RELATIONS[cascadeDim];
        const frontierArr = Array.from(frontier);
        const edges = this.db.edgeDao.getNeighborhood(frontierArr, {
          limit: this.config.bfsMaxNodes,
          relations,
        }) as Edge[];

        const nextFrontier = new Set<string>();
        for (const edge of edges) {
          const otherId = frontier.has(edge.sourceId)
            ? edge.targetId
            : edge.sourceId;

          if (!reachedBy.has(otherId)) {
            reachedBy.set(otherId, new Set());
          }
          reachedBy.get(otherId)!.add(cascadeDim);

          if (!primarySet.has(otherId) && !nextFrontier.has(otherId)) {
            nextFrontier.add(otherId);
          }

          if (!baseScore.has(otherId)) {
            const srcScore = baseScore.get(
              frontier.has(edge.sourceId) ? edge.sourceId : edge.targetId
            ) ?? 0;
            baseScore.set(otherId, Math.max(baseScore.get(otherId) ?? 0, srcScore * 0.7));
          }
        }

        frontier = nextFrontier;

        if (
          primarySet.size + reachedBy.size + nextFrontier.size >
          this.config.bfsMaxNodes
        )
          break;
      }
    }

    const allIds = Array.from(
      new Set([...baseScore.keys(), ...reachedBy.keys()])
    );

    const layerCounts = new Map<string, number>();
    if (allIds.length > 0) {
      const edgeRows = this.db.edgeDao.getIncidentRelations(allIds);

      const dimsPerNode = new Map<string, Set<Dim>>();
      for (const row of edgeRows) {
        const dim = RELATION_TO_DIM[row.relation];
        if (!dim) continue;
        if (!dimsPerNode.has(row.nodeId)) dimsPerNode.set(row.nodeId, new Set());
        dimsPerNode.get(row.nodeId)!.add(dim);
      }

      for (const id of allIds) {
        const fromEdges = dimsPerNode.get(id);
        const fromCascade = reachedBy.get(id);
        const combined = new Set<Dim>();
        if (fromEdges) for (const d of fromEdges) combined.add(d);
        if (fromCascade) for (const d of fromCascade) combined.add(d);
        layerCounts.set(id, Math.max(combined.size, 1));
      }
    }

    const idx = allIds
      .filter((id) => (baseScore.get(id) ?? 0) > 0)
      .sort((a, b) => {
        const layersA = layerCounts.get(a) ?? 1;
        const layersB = layerCounts.get(b) ?? 1;
        const boostA = 1 + this.config.lambda * (layersA - 1);
        const boostB = 1 + this.config.lambda * (layersB - 1);
        const scoreA = (baseScore.get(a) ?? 0) * boostA;
        const scoreB = (baseScore.get(b) ?? 0) * boostB;
        return scoreB - scoreA;
      })
      .slice(0, this.config.chunkLimit);

    const sigs = this.db.getNodeSignatures(idx);

    return idx.map((id) => {
      const raw = baseScore.get(id) ?? 0;
      const layers = layerCounts.get(id) ?? 1;
      const boost = 1 + this.config.lambda * (layers - 1);
      return {
        nodeId: id,
        score: raw * boost,
        text: sigs.get(id) ?? id,
        source: "CLCR",
      };
    });
  }

  #computeDominant(
    intent: IntentTag,
    dimensions: ("SYS" | "CPG" | "DTG")[]
  ): Dim {
    const base = { ...INTENT_WEIGHTS[intent] };

    if (dimensions.length > 0 && dimensions.length < 3) {
      for (const dim of dimensions) {
        base[dim] *= 1.5;
      }
    }

    let best: Dim = "CPG";
    let bestVal = 0;
    for (const dim of ALL_DIMS) {
      if (base[dim] > bestVal) {
        bestVal = base[dim];
        best = dim;
      }
    }
    return best;
  }
}
