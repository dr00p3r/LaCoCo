import type { GraphEdge } from "../../../persistence/lacoco-graph-manager/model/types.js";

export interface NeighborhoodReader {
  getNeighborhood(
    ids: string[],
    options: { limit: number; relations?: readonly string[] },
  ): GraphEdge[];
}

export interface BfsOptions {
  maxHops: number;
  maxNodes: number;
  relations?: readonly string[];
}

export interface BfsDiscovery {
  from: string;
  nodeId: string;
  depth: number;
  edge: GraphEdge;
}

export interface BfsResult {
  visited: Set<string>;
  edges: GraphEdge[];
  discoveries: BfsDiscovery[];
}

export function breadthFirstTraversal(
  reader: NeighborhoodReader,
  roots: readonly string[],
  options: BfsOptions,
): BfsResult {
  const visited = new Set(roots);
  const discoveries: BfsDiscovery[] = [];
  const edgesByKey = new Map<string, GraphEdge>();
  let frontier = new Set(roots);

  for (let depth = 1; depth <= options.maxHops && frontier.size > 0; depth++) {
    const edges = reader.getNeighborhood([...frontier], {
      limit: options.maxNodes,
      ...(options.relations ? { relations: options.relations } : {}),
    });
    const next = new Set<string>();

    for (const edge of edges) {
      edgesByKey.set(`${edge.sourceId}\0${edge.relation}\0${edge.targetId}`, edge);
      const from = frontier.has(edge.sourceId) ? edge.sourceId : edge.targetId;
      const nodeId = from === edge.sourceId ? edge.targetId : edge.sourceId;
      if (visited.has(nodeId) || visited.size >= options.maxNodes) continue;
      visited.add(nodeId);
      next.add(nodeId);
      discoveries.push({ from, nodeId, depth, edge });
    }
    frontier = next;
  }

  const edges = [...edgesByKey.values()].filter(
    (edge) => visited.has(edge.sourceId) && visited.has(edge.targetId),
  );
  return { visited, edges, discoveries };
}

export interface PrioritizedBfsOptions {
  budget: number;
  priority(nodeId: string, edgeCount: number): number;
}

export function prioritizedBreadthFirstTraversal(
  roots: readonly string[],
  getNeighbors: (nodeId: string) => string[],
  options: PrioritizedBfsOptions,
): Set<string> {
  const visited = new Set(roots);
  const frontier = new Map<string, number>();
  const add = (nodeId: string) => {
    if (!visited.has(nodeId)) frontier.set(nodeId, (frontier.get(nodeId) ?? 0) + 1);
  };

  for (const root of roots) for (const neighbor of getNeighbors(root)) add(neighbor);

  while (visited.size < options.budget && frontier.size > 0) {
    let bestId = "";
    let bestPriority = -Infinity;
    for (const [nodeId, edgeCount] of frontier) {
      const priority = options.priority(nodeId, edgeCount);
      if (priority > bestPriority) {
        bestPriority = priority;
        bestId = nodeId;
      }
    }
    frontier.delete(bestId);
    visited.add(bestId);
    for (const neighbor of getNeighbors(bestId)) add(neighbor);
  }
  return visited;
}
