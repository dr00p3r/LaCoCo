import { existsSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export interface GraphLookup {
  path: string;
  findMissingNodeIds(nodeIds: readonly string[]): string[];
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
    close() {
      database.close();
    },
  };
}
