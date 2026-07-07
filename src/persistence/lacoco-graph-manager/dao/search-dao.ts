import Database from "better-sqlite3";
import {
  parseGraphNode,
  requireNumber,
  requireRecord,
  requireString,
  type GraphNode,
} from "../model/types.js";

export class SearchDao {
  private stmtSearchBM25 : Database.Statement;
  private stmtGetNodesByDimension : Database.Statement;

  constructor(db: Database.Database) {
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
    return this.stmtSearchBM25.all(query, limit).map((value) => {
      const row = requireRecord(value, "Bm25Row");
      return {
        node_id: requireString(row.node_id, "Bm25Row.node_id"),
        score: requireNumber(row.score, "Bm25Row.score"),
      };
    });
  }

  getNodesByDimension(
    dimension: "SYS" | "CPG" | "DTG",
    limit = 100
  ): GraphNode[] {
    return this.stmtGetNodesByDimension.all(dimension, limit).map(parseGraphNode);
  }
}
