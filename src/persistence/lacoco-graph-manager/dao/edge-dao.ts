import Database from "better-sqlite3";
import type { GraphEdge } from "../model/types.js";

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
}
