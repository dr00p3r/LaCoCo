import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { prioritizedBreadthFirstTraversal } from "../../retriever/strategies/helpers/graph-traversal.js";
import type { Focus } from "./types.js";

export function expandBfs(
  db: LaCoCoDatabase,
  rootIds: readonly string[],
  budget: number,
  focus: Focus,
): Set<string> {
  const dimensionCache = new Map<string, string | null>();
  const getDimension = (nodeId: string): string | null => {
    if (!dimensionCache.has(nodeId)) {
      dimensionCache.set(nodeId, db.nodeDao.loadNodesByIds([nodeId])[0]?.dim ?? null);
    }
    return dimensionCache.get(nodeId) ?? null;
  };

  return prioritizedBreadthFirstTraversal(
    rootIds,
    (nodeId) => db.edgeDao.getBfsNeighbors(nodeId),
    {
      budget,
      priority: (nodeId, edgeCount) =>
        focusPriority(getDimension(nodeId), focus) + Math.min(edgeCount, 5) * 0.5,
    },
  );
}

function focusPriority(dimension: string | null, focus: Focus): number {
  if (focus === "ALL") return 1;
  if (dimension === focus) return 3;
  if (focus === "SYS" && dimension === "CPG") return 2;
  if (focus === "CPG" && dimension === "SYS") return 2;
  if (focus === "DTG" && dimension === "CPG") return 2;
  return 1;
}
