import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface GraphLookup {
  path: string;
  findMissingNodeIds(nodeIds: readonly string[]): string[];
  hasNode(nodeId: string): boolean;
  /**
   * Undirected BFS shortest-path distances (in edges) from `anchorId` to every
   * reachable node. The anchor itself maps to 0; unreachable nodes are absent.
   * Returns an empty map when the anchor node has no edges.
   */
  distancesFrom(anchorId: string): Map<string, number>;
  close(): void;
}

export function findGraphDatabase(
  runDirectory: string | undefined,
  indexesDirectory: string,
  repoId: string,
  graphDbName: string,
): string | null {
  const candidates = [
    ...(runDirectory === undefined
      ? []
      : [join(runDirectory, "indexes", repoId, graphDbName)]),
    join(indexesDirectory, repoId, graphDbName),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function openGraphLookup(path: string): GraphLookup {
  const database = new Database(path, { readonly: true, fileMustExist: true });
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'nodes'")
    .get();
  if (table === undefined) {
    database.close();
    throw new Error(`SQLite database does not contain a nodes table: ${path}`);
  }
  let adjacency: Map<string, Set<string>> | null = null;
  const buildAdjacency = (): Map<string, Set<string>> => {
    if (adjacency !== null) return adjacency;
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string): void => {
      let set = map.get(a);
      if (set === undefined) {
        set = new Set<string>();
        map.set(a, set);
      }
      set.add(b);
    };
    for (const row of database.prepare("SELECT sourceId, targetId FROM edges").all()) {
      if (typeof row !== "object" || row === null) continue;
      const source = (row as Record<string, unknown>).sourceId;
      const target = (row as Record<string, unknown>).targetId;
      if (typeof source !== "string" || typeof target !== "string") continue;
      add(source, target);
      add(target, source);
    }
    adjacency = map;
    return map;
  };

  return {
    path,
    findMissingNodeIds(nodeIds) {
      const unique = [...new Set(nodeIds)];
      if (unique.length === 0) return [];
      const placeholders = unique.map(() => "?").join(",");
      const rows = database.prepare(`SELECT id FROM nodes WHERE id IN (${placeholders})`).all(...unique);
      const found = new Set(rows.flatMap((value) => {
        if (typeof value !== "object" || value === null || !("id" in value)) return [];
        return typeof value.id === "string" ? [value.id] : [];
      }));
      return unique.filter((nodeId) => !found.has(nodeId));
    },
    hasNode(nodeId) {
      return database.prepare("SELECT 1 FROM nodes WHERE id = ? LIMIT 1").get(nodeId) !== undefined;
    },
    distancesFrom(anchorId) {
      const adj = buildAdjacency();
      const distances = new Map<string, number>([[anchorId, 0]]);
      const queue: string[] = [anchorId];
      for (let head = 0; head < queue.length; head += 1) {
        const current = queue[head]!;
        const distance = distances.get(current)!;
        for (const neighbor of adj.get(current) ?? []) {
          if (!distances.has(neighbor)) {
            distances.set(neighbor, distance + 1);
            queue.push(neighbor);
          }
        }
      }
      return distances;
    },
    close() {
      database.close();
    },
  };
}
