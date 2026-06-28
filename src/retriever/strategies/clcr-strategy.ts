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
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { AbstractAnchoredStrategy } from "./abstract-anchored-strategy.js";
import type { HybridAnchor } from "../utilities/search/hybrid-anchor-service.js";
import { DIMENSIONS, RELATION_TO_DIM, type Dimension } from "../../domain/dimensions.js";
import { getDominantDimension } from "./helpers/intent-weights.js";
import { breadthFirstTraversal } from "./helpers/graph-traversal.js";

type Dim = Dimension;
const ALL_DIMS: Dim[] = [...DIMENSIONS];

const DIM_RELATIONS = Object.entries(RELATION_TO_DIM).reduce<Record<Dim, string[]>>(
  (relationsByDim, [relation, dimension]) => {
    relationsByDim[dimension].push(relation);
    return relationsByDim;
  },
  { SYS: [], CPG: [], DTG: [] },
);

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
    const dominant = getDominantDimension(query.intent, query.dimensions);
    const cascadeDims = ALL_DIMS.filter((d) => d !== dominant);

    const baseScore = new Map<string, number>();
    const anchorSet = new Set<string>();
    for (const r of anchorResults) {
      baseScore.set(r.nodeId, r.score);
      anchorSet.add(r.nodeId);
    }

    const anchorIds = Array.from(anchorSet);

    const primary = breadthFirstTraversal(this.db.edgeDao, anchorIds, {
      maxHops: this.config.primaryHops,
      maxNodes: this.config.bfsMaxNodes,
      relations: DIM_RELATIONS[dominant],
    });
    const primarySet = primary.visited;
    for (const discovery of primary.discoveries) {
      const propagated = (baseScore.get(discovery.from) ?? 0)
        * Math.pow(0.5, discovery.depth);
      baseScore.set(
        discovery.nodeId,
        Math.max(baseScore.get(discovery.nodeId) ?? 0, propagated),
      );
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
      const cascade = breadthFirstTraversal(this.db.edgeDao, [...primarySet], {
        maxHops: this.config.cascadeHops,
        maxNodes: this.config.bfsMaxNodes,
        relations: DIM_RELATIONS[cascadeDim],
      });
      for (const edge of cascade.edges) {
        for (const nodeId of [edge.sourceId, edge.targetId]) {
          if (!reachedBy.has(nodeId)) reachedBy.set(nodeId, new Set());
          reachedBy.get(nodeId)!.add(cascadeDim);
        }
      }
      for (const discovery of cascade.discoveries) {
        if (!baseScore.has(discovery.nodeId)) {
          baseScore.set(discovery.nodeId, (baseScore.get(discovery.from) ?? 0) * 0.7);
        }
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

}
