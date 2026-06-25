/**
 * RprStrategy (2.8) — Relational Path Retrieval.
 *
 * En generación de código, el significado rara vez está en nodos aislados;
 * está en las secuencias de relaciones que los conectan. La unidad de
 * recuperación deja de ser el nodo y pasa a ser la trayectoria relacional.
 *
 * Algoritmo:
 *   1. Anclas híbridas vía BM25 + ANN + RRF
 *   2. Subgrafo local vía BFS bidireccional (2 hops)
 *   3. Enumeración de caminos desde cada ancla (DFS, solo salientes, depth≤3)
 *   4. Scoring: avgNodeRelevance × uniqueDims
 *   5. Deduplicación por hash de camino, rank, top-K
 *   6. Chunks con trayectoria relacional completa como texto
 */

import {
  type RecoveryStrategy,
  type ContextChunk,
} from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
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

type Dim = "SYS" | "CPG" | "DTG";

interface OutEdge {
  targetId: string;
  relation: string;
  dim: Dim;
}

interface PathData {
  nodes: string[];
  relations: string[];
  dims: Dim[];
}

interface ScoredPath extends PathData {
  score: number;
  hash: string;
}

export interface RprConfig {
  anchorLimit: number;
  subgraphMaxHops: number;
  bfsMaxNodes: number;
  maxDepth: number;
  maxCandidates: number;
  chunkLimit: number;
  decayPerHop: number;
}

const DEFAULT_CONFIG: RprConfig = {
  anchorLimit: 30,
  subgraphMaxHops: 2,
  bfsMaxNodes: 5000,
  maxDepth: 3,
  maxCandidates: 5000,
  chunkLimit: 50,
  decayPerHop: 0.5,
};

export class RprStrategy implements RecoveryStrategy {
  private readonly config: RprConfig;
  private readonly anchors: HybridAnchorService;

  constructor(
    private readonly db: LaCoCoDatabase,
    lanceDb: LaCoCoLanceDb,
    config?: Partial<RprConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.anchors = new HybridAnchorService(db, lanceDb);
  }

  /**
   * Recupera contexto como trayectorias relacionales relevantes.
   *
   * @param query Salida sanitizada del intermediario.
   * @returns Chunks que representan caminos del grafo.
   */
  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    const anchorResults = (await this.anchors.search(query, this.config.anchorLimit))
      .slice(0, this.config.anchorLimit);
    if (anchorResults.length === 0) return [];

    const anchorScores = new Map<string, number>();
    const anchorIds = new Set<string>();
    for (const r of anchorResults) {
      anchorScores.set(r.nodeId, r.score);
      anchorIds.add(r.nodeId);
    }

    const { outgoingEdges, nodeRelevance } = this.#buildSubgraph(
      Array.from(anchorIds),
      anchorScores
    );

    const allNodeIds = new Set(nodeRelevance.keys());
    for (const edges of outgoingEdges.values()) {
      for (const e of edges) allNodeIds.add(e.targetId);
    }

    const paths = this.#enumeratePaths(Array.from(anchorIds), outgoingEdges);

    if (paths.length === 0) {
      const sigs = this.db.getNodeSignatures(Array.from(anchorIds));
      return Array.from(anchorIds).map((id) => ({
        nodeId: id,
        score: anchorScores.get(id) ?? 0.5,
        text: sigs.get(id) ?? id,
        source: "RPR",
      }));
    }

    const scored = this.#scorePaths(paths, nodeRelevance);

    const seen = new Set<string>();
    const ranked = scored
      .sort((a, b) => b.score - a.score)
      .filter((p) => {
        if (seen.has(p.hash)) return false;
        seen.add(p.hash);
        return true;
      })
      .slice(0, this.config.chunkLimit);

    const sigNodes = new Set<string>();
    for (const p of ranked) for (const n of p.nodes) sigNodes.add(n);
    const idArr = Array.from(sigNodes) as string[];
    const sigs = this.db.getNodeSignatures(idArr);

    return ranked.map((p) => {
      const parts: string[] = [];
      for (let i = 0; i < p.nodes.length; i++) {
        const nid = p.nodes[i]!;
        parts.push(sigs.get(nid) ?? nid);
        if (i < p.relations.length) {
          parts.push(` --${p.relations[i]}--> `);
        }
      }
      const uniqueDims = [...new Set(p.dims)];
      const uniqueRels = [...new Set(p.relations)];
      const dimStr = uniqueDims.length > 0
        ? ` | dims: ${uniqueDims.join("\u2192")}`
        : "";
      const relStr = uniqueRels.length > 0
        ? ` | relations: ${uniqueRels.join(", ")}`
        : "";

      return {
        nodeId: p.nodes[p.nodes.length - 1]!,
        score: p.score,
        text: parts.join("") + dimStr + relStr,
        source: "RPR",
      };
    });
  }

  #buildSubgraph(
    anchorIds: string[],
    anchorScores: Map<string, number>
  ): {
    outgoingEdges: Map<string, OutEdge[]>;
    nodeRelevance: Map<string, number>;
  } {
    const rawDb = this.db.getRawDb();
    const outgoingEdges = new Map<string, OutEdge[]>();
    const nodeRelevance = new Map<string, number>();

    for (const id of anchorIds) {
      nodeRelevance.set(id, anchorScores.get(id) ?? 0);
    }

    let frontier = new Set(anchorIds);
    const visited = new Set<string>();

    for (
      let hop = 0;
      hop < this.config.subgraphMaxHops && frontier.size > 0;
      hop++
    ) {
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

        if (!outgoingEdges.has(edge.sourceId)) {
          outgoingEdges.set(edge.sourceId, []);
        }
        outgoingEdges.get(edge.sourceId)!.push({
          targetId: edge.targetId,
          relation: edge.relation,
          dim,
        });

        const srcKnown = nodeRelevance.has(edge.sourceId);
        const tgtKnown = nodeRelevance.has(edge.targetId);
        const decay = this.config.decayPerHop;

        if (srcKnown && !tgtKnown) {
          const newRel = (nodeRelevance.get(edge.sourceId) ?? 0) * decay;
          nodeRelevance.set(
            edge.targetId,
            Math.max(nodeRelevance.get(edge.targetId) ?? 0, newRel)
          );
          if (!anchorIds.includes(edge.targetId)) {
            nextFrontier.add(edge.targetId);
          }
        }

        if (!srcKnown && tgtKnown) {
          const newRel = (nodeRelevance.get(edge.targetId) ?? 0) * decay;
          nodeRelevance.set(
            edge.sourceId,
            Math.max(nodeRelevance.get(edge.sourceId) ?? 0, newRel)
          );
          if (!anchorIds.includes(edge.sourceId)) {
            nextFrontier.add(edge.sourceId);
          }
        }
      }

      for (const id of frontierArr) visited.add(id);
      frontier = new Set(
        Array.from(nextFrontier).filter((id) => !visited.has(id))
      );

      if (nodeRelevance.size + frontier.size > this.config.bfsMaxNodes) break;
    }

    for (const id of anchorIds) {
      if (!outgoingEdges.has(id)) {
        outgoingEdges.set(id, []);
      }
    }

    return { outgoingEdges, nodeRelevance };
  }

  #enumeratePaths(
    anchorIds: string[],
    outgoingEdges: Map<string, OutEdge[]>
  ): PathData[] {
    const paths: PathData[] = [];

    for (const anchor of anchorIds) {
      this.#dfs(
        anchor,
        [anchor],
        [],
        [],
        1,
        outgoingEdges,
        paths
      );
      if (paths.length >= this.config.maxCandidates) break;
    }

    return paths.slice(0, this.config.maxCandidates);
  }

  #dfs(
    current: string,
    nodes: string[],
    relations: string[],
    dims: Dim[],
    depth: number,
    outgoingEdges: Map<string, OutEdge[]>,
    paths: PathData[]
  ): void {
    if (depth > this.config.maxDepth || paths.length >= this.config.maxCandidates)
      return;

    const edges = outgoingEdges.get(current);
    if (!edges) return;

    for (const edge of edges) {
      if (nodes.includes(edge.targetId)) continue;

      const newPath: PathData = {
        nodes: [...nodes, edge.targetId],
        relations: [...relations, edge.relation],
        dims: [...dims, edge.dim],
      };
      paths.push(newPath);

      this.#dfs(
        edge.targetId,
        newPath.nodes,
        newPath.relations,
        newPath.dims,
        depth + 1,
        outgoingEdges,
        paths
      );

      if (paths.length >= this.config.maxCandidates) return;
    }
  }

  #scorePaths(
    paths: PathData[],
    nodeRelevance: Map<string, number>
  ): ScoredPath[] {
    return paths.map((p) => {
      const totalRel = p.nodes.reduce(
        (sum, n) => sum + (nodeRelevance.get(n) ?? 0),
        0
      );
      const avgRel = totalRel / p.nodes.length;
      const uniqueDims = new Set(p.dims).size;
      const score = avgRel * uniqueDims;
      const hash = p.nodes.join("\u2192") + "|" + p.relations.join(",");
      return { ...p, score, hash };
    });
  }
}
