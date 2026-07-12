import Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import type { ExtractionCallbacks, NodeRow, EdgeRow, EdgeRelation } from "./types.js";

export class SqliteCallbacks implements ExtractionCallbacks {
  private readonly stmtInsertNode: Statement;
  private readonly stmtInsertEdge: Statement;

  nodesWritten = 0;
  edgesWritten = 0;

  constructor(db: Database.Database) {
    this.stmtInsertNode = db.prepare(`
      INSERT INTO nodes
        (id, kind, name, filepath, signature, isDeprecated, startLine, endLine)
      VALUES
        (@id, @kind, @name, @filepath, @signature, @isDeprecated, @startLine, @endLine)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        name = excluded.name,
        filepath = excluded.filepath,
        signature = excluded.signature,
        isDeprecated = excluded.isDeprecated,
        startLine = excluded.startLine,
        endLine = excluded.endLine
    `);

    this.stmtInsertEdge = db.prepare(`
      INSERT OR IGNORE INTO edges (sourceId, targetId, relation)
      VALUES (@sourceId, @targetId, @relation)
    `);
  }

  insertNode(row: NodeRow): void {
    this.stmtInsertNode.run({
      id: row.id,
      kind: row.kind,
      name: row.name,
      filepath: row.filepath,
      signature: row.signature,
      isDeprecated: row.isDeprecated,
      startLine: row.startLine ?? null,
      endLine: row.endLine ?? null,
    });
    this.nodesWritten++;
  }

  insertEdge(sourceId: string, targetId: string, relation: EdgeRelation): void {
    if (sourceId === targetId) return;
    this.stmtInsertEdge.run({ sourceId, targetId, relation } satisfies EdgeRow);
    this.edgesWritten++;
  }
}
