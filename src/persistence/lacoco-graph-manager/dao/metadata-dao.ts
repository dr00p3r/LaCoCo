import type Database from "better-sqlite3";
import { KIND_TO_DIM, KIND_TO_SUBTYPE, RELATION_TO_DIM, type Dimension } from "../../../domain/dimensions.js";

export class MetadataDao {
  private readonly insertStmt: Database.Statement;
  private readonly edgesStmt: Database.Statement;
  private readonly kindStmt: Database.Statement;
  private readonly allIdsStmt: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.insertStmt = db.prepare(
      `INSERT OR REPLACE INTO node_metadata (node_id, dimension, sub_type)
       VALUES (?, ?, ?)`,
    );
    this.edgesStmt = db.prepare(
      "SELECT relation FROM edges WHERE sourceId = ? OR targetId = ?",
    );
    this.kindStmt = db.prepare(
      "SELECT id, kind FROM nodes WHERE id = ?",
    );
    this.allIdsStmt = db.prepare("SELECT id FROM nodes");
  }

  populateAll(): void {
    const nodes = this.allIdsStmt.all() as { id: string }[];
    this.populateForNodes(nodes.map((n) => n.id));
  }

  populateForNodes(ids: string[]): void {
    if (ids.length === 0) return;

    const tx = this.db.transaction(() => {
      for (const nodeId of ids) {
        const node = this.kindStmt.get(nodeId) as
          | { id: string; kind: string }
          | undefined;
        if (!node) continue;

        const edges = this.edgesStmt.all(node.id, node.id) as { relation: string }[];
        const counts = { SYS: 0, CPG: 0, DTG: 0 };
        for (const e of edges) {
          const dimension = RELATION_TO_DIM[e.relation];
          if (dimension) counts[dimension]++;
        }
        if (counts.SYS === 0 && counts.CPG === 0 && counts.DTG === 0) {
          const fallbackDimension = KIND_TO_DIM[node.kind];
          if (fallbackDimension) counts[fallbackDimension] = 1;
        }

        const max = Math.max(counts.SYS, counts.CPG, counts.DTG);
        const dim =
          max === counts.SYS ? "SYS" : max === counts.CPG ? "CPG" : "DTG";
        const subType = KIND_TO_SUBTYPE[node.kind] ?? "unknown";

        this.insertStmt.run(node.id, dim, subType);
      }
    });
    tx();

    console.error(
      `[LaCoCo] ✅ Metadatos poblados para ${ids.length} nodos.`,
    );
  }
}
