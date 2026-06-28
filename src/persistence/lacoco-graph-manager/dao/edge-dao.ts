import Database from "better-sqlite3";
import { parseGraphEdge, requireRecord, requireString, type GraphEdge } from "../model/types.js";

export interface EdgeNeighborhoodOptions {
  limit: number;
  relations?: readonly string[];
}

export interface IncidentRelationRow {
  nodeId: string;
  relation: string;
}

export class EdgeDao {
  private stmtInsertEdge: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtInsertEdge = db.prepare(
      `INSERT OR IGNORE INTO edges (sourceId, targetId, relation)
       VALUES (@sourceId, @targetId, @relation)`
    );
  }

  insertEdge(edge: GraphEdge): void {
    this.stmtInsertEdge.run(edge);
  }

  clearAll(): void {
    this.db.prepare("DELETE FROM edges").run();
  }

  getNeighborhood(ids: string[], opts: EdgeNeighborhoodOptions): GraphEdge[] {
    if (ids.length === 0 || opts.limit <= 0) return [];

    const idPlaceholders = ids.map(() => "?").join(",");
    const relationFilter = opts.relations && opts.relations.length > 0
      ? ` AND relation IN (${opts.relations.map(() => "?").join(",")})`
      : "";
    const sql = `
      SELECT sourceId, targetId, relation
      FROM edges
      WHERE (sourceId IN (${idPlaceholders}) OR targetId IN (${idPlaceholders}))
        ${relationFilter}
      LIMIT ?
    `;

    const params = opts.relations && opts.relations.length > 0
      ? [...ids, ...ids, ...opts.relations, opts.limit]
      : [...ids, ...ids, opts.limit];
    return this.db.prepare(sql).all(...params).map(parseGraphEdge);
  }

  getIncidentRelations(ids: string[]): IncidentRelationRow[] {
    if (ids.length === 0) return [];

    const placeholders = ids.map(() => "?").join(",");
    const sql = `
      SELECT nid AS nodeId, relation FROM (
        SELECT sourceId AS nid, relation FROM edges WHERE sourceId IN (${placeholders})
        UNION ALL
        SELECT targetId AS nid, relation FROM edges WHERE targetId IN (${placeholders})
      )
    `;

    return this.db.prepare(sql).all(...ids, ...ids).map((value) => {
      const row = requireRecord(value, "IncidentRelationRow");
      return {
        nodeId: requireString(row.nodeId, "IncidentRelationRow.nodeId"),
        relation: requireString(row.relation, "IncidentRelationRow.relation"),
      };
    });
  }

  getBfsNeighbors(nodeId: string): string[] {
    return this.db.prepare(`
      SELECT targetId AS neighbor FROM edges WHERE sourceId = ?
      UNION
      SELECT sourceId AS neighbor FROM edges WHERE targetId = ?
    `).all(nodeId, nodeId).map((value) => {
      const row = requireRecord(value, "BfsNeighborRow");
      return requireString(row.neighbor, "BfsNeighborRow.neighbor");
    });
  }

  loadBetweenIds(ids: readonly string[]): GraphEdge[] {
    if (ids.length < 2) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT sourceId, targetId, relation FROM edges
       WHERE sourceId IN (${placeholders}) AND targetId IN (${placeholders})`,
    ).all(...ids, ...ids).map(parseGraphEdge);
  }
}
