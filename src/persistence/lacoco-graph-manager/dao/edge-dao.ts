import Database from "better-sqlite3";
import type { GraphEdge } from "../model/types.js";

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
    return this.db.prepare(sql).all(...params) as GraphEdge[];
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

    return this.db.prepare(sql).all(...ids, ...ids) as IncidentRelationRow[];
  }
}
