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
 *   2. BFS sobre la capa primaria (dominante, 2 hops) desde anclas BM25
 *   3. Cascade hacia las otras 2 dimensiones (1 hop c/u)
 *   4. Cross-layer score: contar en cuántas dimensiones participa cada nodo
 *   5. Boost = 1 + λ × (layerCount − 1), λ = 0.25
 *   6. Top-K por score final
 */

import {
  type RecoveryStrategy,
  type ContextChunk,
} from "../models/strategies/types.js";
import type { SanitizerOutput, IntentTag } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";

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

const DIM_RELATIONS: Record<Dim, string[]> = {
  SYS: ["EXTENDS", "IMPLEMENTS", "IMPORTS_EXTERNAL"],
  CPG: ["INJECTS", "CALLS", "INSTANTIATES"],
  DTG: ["CONSUMES_DATA", "PRODUCES", "MUTATES_STATE"],
};

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

type Dim = "SYS" | "CPG" | "DTG";
const ALL_DIMS: Dim[] = ["SYS", "CPG", "DTG"];

interface Edge {
  sourceId: string;
  targetId: string;
  relation: string;
}

export class ClcrStrategy implements RecoveryStrategy {
  private readonly config: ClcrConfig;

  constructor(
    private readonly db: LaCoCoDatabase,
    config?: Partial<ClcrConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    const dominant = this.#computeDominant(query.intent, query.dimensions);
    const cascadeDims = ALL_DIMS.filter((d) => d !== dominant);

    const anchorResults = this.db.searchBM25(
      query.clean_query,
      this.config.anchorLimit
    );
    if (anchorResults.length === 0) return [];

    const rawDb = this.db.getRawDb();

    const baseScore = new Map<string, number>();
    const anchorSet = new Set<string>();
    let maxBm25 = 0;
    for (const r of anchorResults) {
      const s = Math.max(0, 1 - Math.abs(r.score));
      baseScore.set(r.node_id, s);
      anchorSet.add(r.node_id);
      if (s > maxBm25) maxBm25 = s;
    }
    if (maxBm25 > 0) {
      for (const [id, s] of baseScore) baseScore.set(id, s / maxBm25);
    }

    const anchorIds = Array.from(anchorSet);

    const primarySet = new Set(anchorIds);
    let frontier = new Set(anchorIds);

    for (let hop = 0; hop < this.config.primaryHops && frontier.size > 0; hop++) {
      const relations = DIM_RELATIONS[dominant];
      const rPlaceholders = relations.map(() => "?").join(",");
      const frontierArr = Array.from(frontier);
      const fPlaceholders = frontierArr.map(() => "?").join(",");

      const sql = `
        SELECT sourceId, targetId, relation
        FROM edges
        WHERE (sourceId IN (${fPlaceholders}) OR targetId IN (${fPlaceholders}))
          AND relation IN (${rPlaceholders})
        LIMIT 5000
      `;

      const params = [
        ...frontierArr,
        ...frontierArr,
        ...relations,
      ];
      const edges = rawDb.prepare(sql).all(...params) as Edge[];

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
      const sigs = this.db.getNodeSignatures(anchorIds);
      return anchorResults.map((r) => ({
        nodeId: r.node_id,
        score: baseScore.get(r.node_id) ?? 0.5,
        text: sigs.get(r.node_id) ?? r.node_id,
        source: "CLCR",
      }));
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
        const rPlaceholders = relations.map(() => "?").join(",");
        const frontierArr = Array.from(frontier);
        const fPlaceholders = frontierArr.map(() => "?").join(",");

        const sql = `
          SELECT sourceId, targetId, relation
          FROM edges
          WHERE (sourceId IN (${fPlaceholders}) OR targetId IN (${fPlaceholders}))
            AND relation IN (${rPlaceholders})
          LIMIT 5000
        `;

        const params = [
          ...frontierArr,
          ...frontierArr,
          ...relations,
        ];
        const edges = rawDb.prepare(sql).all(...params) as Edge[];

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
      const placeholders = allIds.map(() => "?").join(",");
      const edgeCountSql = `
        SELECT nid, relation FROM (
          SELECT sourceId AS nid, relation FROM edges WHERE sourceId IN (${placeholders})
          UNION ALL
          SELECT targetId AS nid, relation FROM edges WHERE targetId IN (${placeholders})
        )
      `;
      const edgeRows = rawDb
        .prepare(edgeCountSql)
        .all(...allIds) as { nid: string; relation: string }[];

      const dimsPerNode = new Map<string, Set<Dim>>();
      for (const row of edgeRows) {
        const dim = DIM_MAP[row.relation];
        if (!dim) continue;
        if (!dimsPerNode.has(row.nid)) dimsPerNode.set(row.nid, new Set());
        dimsPerNode.get(row.nid)!.add(dim);
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
