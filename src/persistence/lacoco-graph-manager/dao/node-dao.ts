import Database from "better-sqlite3";
import {
  parseGraphNode,
  requireRecord,
  requireString,
  type GraphNode,
  type GraphNodeWithMetadata,
} from "../model/types.js";

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

  clearAll(): void {
    this.db.prepare("DELETE FROM nodes").run();
  }

  deleteNodesByFile(filepath: string): string[] {
    const nodeIds = this.stmtGetNodeIdsByFile.all(filepath).map((value) => {
      const row = requireRecord(value, "NodeIdRow");
      return requireString(row.id, "NodeIdRow.id");
    });

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
      .all(filepath)
      .map(parseGraphNode);
  }

  getNodeIdsBySymbol(name: string, limit = 10): string[] {
    const rows = this.db
      .prepare("SELECT id FROM nodes WHERE name = ? LIMIT ?")
      .all(name, limit);
    return rows.map((value) => {
      const row = requireRecord(value, "NodeIdRow");
      return requireString(row.id, "NodeIdRow.id");
    });
  }

  getExternalLibraryIds(pkg: string, version?: string, limit = 10): string[] {
    const sql = version
      ? "SELECT id FROM nodes WHERE kind = 'EXTERNAL_LIB' AND name LIKE ? AND name LIKE ? LIMIT ?"
      : "SELECT id FROM nodes WHERE kind = 'EXTERNAL_LIB' AND name LIKE ? LIMIT ?";
    const params = version ? [`%${pkg}%`, `%${version}%`, limit] : [`%${pkg}%`, limit];
    const rows = this.db.prepare(sql).all(...params);
    return rows.map((value) => {
      const row = requireRecord(value, "ExternalLibraryRow");
      return requireString(row.id, "ExternalLibraryRow.id");
    });
  }

  getNodeSignatures(ids: string[]): Map<string, string> {
    if (ids.length === 0) return new Map();
    const placeholders = ids.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT id, COALESCE(signature, name) AS text FROM nodes WHERE id IN (${placeholders})`)
      .all(...ids);
    const map = new Map<string, string>();
    for (const value of rows) {
      const row = requireRecord(value, "NodeSignatureRow");
      map.set(
        requireString(row.id, "NodeSignatureRow.id"),
        requireString(row.text, "NodeSignatureRow.text"),
      );
    }
    return map;
  }

  loadNodesByIds(ids: readonly string[]): GraphNodeWithMetadata[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(",");
    return this.db.prepare(
      `SELECT n.id, n.kind, n.name, n.filepath,
              COALESCE(n.signature, '') AS signature, n.isDeprecated,
              m.dimension AS dim, m.sub_type
       FROM nodes n
       LEFT JOIN node_metadata m ON n.id = m.node_id
       WHERE n.id IN (${placeholders})`,
    ).all(...ids).map((value) => {
      const row = requireRecord(value, "GraphNodeWithMetadata");
      return {
        ...parseGraphNode(row),
        dim: row.dim === null ? null : requireString(row.dim, "GraphNodeWithMetadata.dim"),
        sub_type: row.sub_type === null
          ? null
          : requireString(row.sub_type, "GraphNodeWithMetadata.sub_type"),
      };
    });
  }
}
