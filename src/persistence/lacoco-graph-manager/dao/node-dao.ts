import Database from "better-sqlite3";
import type { GraphNode } from "../model/types.js";

export class NodeDao {
  private stmtInsertNode: Database.Statement;
  private stmtDeleteEdgesByTarget: Database.Statement;
  private stmtDeleteNodesByFile: Database.Statement;
  private stmtGetNodeIdsByFile: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.stmtInsertNode = db.prepare(
      `INSERT INTO nodes
         (id, kind, name, filepath, signature, isDeprecated)
       VALUES
         (@id, @kind, @name, @filepath, @signature, @isDeprecated)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind,
         name = excluded.name,
         filepath = excluded.filepath,
         signature = excluded.signature,
         isDeprecated = excluded.isDeprecated`
    );

    this.stmtDeleteEdgesByTarget = db.prepare(
      `DELETE FROM edges WHERE targetId = ?`
    );

    this.stmtDeleteNodesByFile = db.prepare(
      `DELETE FROM nodes WHERE filepath = ?`
    );

    this.stmtGetNodeIdsByFile = db.prepare(
      `SELECT id FROM nodes WHERE filepath = ?`
    );
  }

  insertNode(node: GraphNode): void {
    this.stmtInsertNode.run(node);
  }

  deleteNodesByFile(filepath: string): string[] {
    const nodeIds = (
      this.stmtGetNodeIdsByFile.all(filepath) as { id: string }[]
    ).map((r) => r.id);

    if (nodeIds.length === 0) return [];

    this.db.transaction(() => {
      for (const id of nodeIds) {
        this.stmtDeleteEdgesByTarget.run(id);
      }
      this.stmtDeleteNodesByFile.run(filepath);
    })();

    return nodeIds;
  }

  getNodesByFile(filepath: string): GraphNode[] {
    return this.db
      .prepare(`SELECT * FROM nodes WHERE filepath = ?`)
      .all(filepath) as GraphNode[];
  }

  getNodeIdsBySymbol(name: string, limit = 10): string[] {
    const rows = this.db
      .prepare("SELECT id FROM nodes WHERE name = ? LIMIT ?")
      .all(name, limit) as { id: string }[];
    return rows.map((row) => row.id);
  }

  getExternalLibraryIds(pkg: string, version?: string, limit = 10): string[] {
    const sql = version
      ? "SELECT id FROM nodes WHERE kind = 'EXTERNAL_LIB' AND name LIKE ? AND name LIKE ? LIMIT ?"
      : "SELECT id FROM nodes WHERE kind = 'EXTERNAL_LIB' AND name LIKE ? LIMIT ?";
    const params = version ? [`%${pkg}%`, `%${version}%`, limit] : [`%${pkg}%`, limit];
    const rows = this.db.prepare(sql).all(...params) as { id: string }[];
    return rows.map((row) => row.id);
  }

  getNodeSignatures(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT id, COALESCE(signature, name) AS text FROM nodes WHERE id IN (${placeholders})`)
      .all(...ids) as { id: string; text: string }[];
    const map = new Map<string, string>();
    for (const r of rows) {
      map.set(r.id, r.text);
    }
    return map;
  }
}
