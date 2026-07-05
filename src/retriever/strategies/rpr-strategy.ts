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
 *   5. Rank, deduplicación por nodo terminal conservando el mejor camino, top-K
 *   6. Chunks con trayectoria relacional completa como texto
 */

import type { ContextChunk } from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { AbstractAnchoredStrategy } from "./abstract-anchored-strategy.js";
import type { HybridAnchor } from "../utilities/search/hybrid-anchor-service.js";
import { RELATION_TO_DIM, type Dimension } from "../../domain/dimensions.js";
import { breadthFirstTraversal } from "./helpers/graph-traversal.js";

type Dim = Dimension;

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

interface RankedPath {
  path: ScoredPath;
  duplicateCount: number;
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

export const RPR_DEFAULT_CONFIG: Readonly<RprConfig> = Object.freeze({
  anchorLimit: 30,
  subgraphMaxHops: 2,
  bfsMaxNodes: 5000,
  maxDepth: 3,
  maxCandidates: 5000,
  chunkLimit: 50,
  decayPerHop: 0.5,
});

export class RprStrategy extends AbstractAnchoredStrategy {
  private readonly config: RprConfig;

  constructor(
    db: LaCoCoDatabase,
    lanceDb: LaCoCoLanceDb,
    config?: Partial<RprConfig>
  ) {
    super(db, lanceDb);
    this.config = { ...RPR_DEFAULT_CONFIG, ...config };
  }

  protected getAnchorLimit(): number {
    return this.config.anchorLimit;
  }

  protected async expand(anchorResults: HybridAnchor[], _query: SanitizerOutput): Promise<ContextChunk[]> {
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
      return anchorResults.map((anchor) =>
        this.toChunk(anchor, "RPR", anchorScores.get(anchor.nodeId) ?? 0.5)
      );
    }

    const scored = this.#scorePaths(paths, nodeRelevance);

    const bestByNode = new Map<string, RankedPath>();
    for (const path of scored.sort((a, b) => b.score - a.score)) {
      const nodeId = path.nodes[path.nodes.length - 1]!;
      const existing = bestByNode.get(nodeId);
      if (existing) {
        existing.duplicateCount++;
      } else {
        bestByNode.set(nodeId, { path, duplicateCount: 0 });
      }
    }
    const ranked = Array.from(bestByNode.values()).slice(0, this.config.chunkLimit);

    const sigNodes = new Set<string>();
    for (const { path } of ranked) for (const n of path.nodes) sigNodes.add(n);
    const idArr = Array.from(sigNodes) as string[];
    const sigs = this.db.getNodeSignatures(idArr);

    return ranked.map(({ path: p, duplicateCount }) => {
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
        chunkId: `RPR:${p.hash}`,
        nodeId: p.nodes[p.nodes.length - 1]!,
        score: p.score,
        text: parts.join("") + dimStr + relStr,
        source: "RPR",
        path: {
          nodes: [...p.nodes],
          relations: [...p.relations],
          dimensions: [...p.dims],
        },
        diagnostics: { duplicateCount },
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
    const outgoingEdges = new Map<string, OutEdge[]>();
    const nodeRelevance = new Map<string, number>();

    for (const id of anchorIds) {
      nodeRelevance.set(id, anchorScores.get(id) ?? 0);
    }

    const traversal = breadthFirstTraversal(this.db.edgeDao, anchorIds, {
      maxHops: this.config.subgraphMaxHops,
      maxNodes: this.config.bfsMaxNodes,
    });

    for (const edge of traversal.edges) {
        const dim = RELATION_TO_DIM[edge.relation];
        if (!dim) continue;

        if (!outgoingEdges.has(edge.sourceId)) {
          outgoingEdges.set(edge.sourceId, []);
        }
        outgoingEdges.get(edge.sourceId)!.push({
          targetId: edge.targetId,
          relation: edge.relation,
          dim,
        });

    }

    for (const discovery of traversal.discoveries) {
      const relevance = (nodeRelevance.get(discovery.from) ?? 0)
        * this.config.decayPerHop;
      nodeRelevance.set(
        discovery.nodeId,
        Math.max(nodeRelevance.get(discovery.nodeId) ?? 0, relevance),
      );
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
