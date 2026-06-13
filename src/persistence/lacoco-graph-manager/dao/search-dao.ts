import Database from "better-sqlite3";
import type { GraphNode } from "../model/types.js";

export class SearchDao {
  private stmtSearchBM25 : Database.Statement;
  private stmtGetNodesByDimension : Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtSearchBM25 = db.prepare(`
      SELECT node_id, rank as score
      FROM nodes_fts
      WHERE nodes_fts MATCH ?
      ORDER BY rank ASC
      LIMIT ?
    `);

    this.stmtGetNodesByDimension = db.prepare(`
      SELECT n.* FROM nodes n
      INNER JOIN node_metadata m ON n.id = m.node_id
      WHERE m.dimension = ?
      LIMIT ?
    `);
  }

  searchBM25(query: string, limit = 10): { node_id: string; score: number }[] {
    return this.stmtSearchBM25.all(query, limit) as {
      node_id: string;
      score: number;
    }[];
  }

  getNodesByDimension(
    dimension: "SYS" | "CPG" | "DTG",
    limit = 100
  ): GraphNode[] {
    return this.stmtGetNodesByDimension.all(dimension, limit) as GraphNode[];
  }
}
