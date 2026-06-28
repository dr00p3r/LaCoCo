import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { InspectEdge, InspectNode, InspectStats } from "./types.js";

export function findRootNodes(db: LaCoCoDatabase, name: string): string[] {
  return db.nodeDao.getNodeIdsBySymbol(name, 100);
}

export function loadNodes(db: LaCoCoDatabase, ids: ReadonlySet<string>): InspectNode[] {
  return db.nodeDao.loadNodesByIds([...ids]);
}

export function loadEdges(db: LaCoCoDatabase, ids: ReadonlySet<string>): InspectEdge[] {
  return db.edgeDao.loadBetweenIds([...ids]);
}

export function computeStats(
  nodes: InspectNode[],
  edges: InspectEdge[],
  anchors: ReadonlyMap<string, number>,
): InspectStats {
  const byDim: Record<string, number> = {};
  const byKind: Record<string, number> = {};
  for (const node of nodes) {
    const dimension = node.dim ?? "unknown";
    byDim[dimension] = (byDim[dimension] ?? 0) + 1;
    byKind[node.kind] = (byKind[node.kind] ?? 0) + 1;
  }
  return {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    byDim,
    byKind,
    anchorCount: anchors.size,
  };
}
