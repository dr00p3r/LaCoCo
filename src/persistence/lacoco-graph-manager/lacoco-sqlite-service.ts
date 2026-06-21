import Database from "better-sqlite3";
import path from "node:path";
import type { GraphNode, GraphEdge } from "./model/types.js";
import { NodeDao } from "./dao/node-dao.js";
import { EdgeDao } from "./dao/edge-dao.js";
import { SearchDao } from "./dao/search-dao.js";
import { MigrationDao } from "./dao/migration-dao.js";
import { ConnectionDao } from "./dao/connection-dao.js";

export type { GraphNode, GraphEdge };

export class LaCoCoDatabase {
  readonly nodeDao: NodeDao;
  readonly edgeDao: EdgeDao;
  readonly searchDao: SearchDao;
  readonly migrationDao: MigrationDao;
  readonly connectionDao: ConnectionDao;

  private readonly db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? this.#defaultDbPath();
    this.db = new Database(resolvedPath);

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.migrationDao = new MigrationDao(this.db);
    this.migrationDao.initSchema();
    this.migrationDao.runMigrations();

    this.nodeDao = new NodeDao(this.db);
    this.edgeDao = new EdgeDao(this.db);
    this.searchDao = new SearchDao(this.db);
    this.connectionDao = new ConnectionDao(this.db);

    console.log(`[LaCoCo] Base de datos conectada → ${resolvedPath}`);
  }

  insertNode(node: GraphNode): void {
    this.nodeDao.insertNode(node);
  }

  insertEdge(edge: GraphEdge): void {
    this.edgeDao.insertEdge(edge);
  }

  deleteNodesByFile(filepath: string): void {
    this.nodeDao.deleteNodesByFile(filepath);
  }

  getNodesByFile(filepath: string): GraphNode[] {
    return this.nodeDao.getNodesByFile(filepath);
  }

  getNodeSignatures(ids: string[]): Map<string, string> {
    return this.nodeDao.getNodeSignatures(ids);
  }

  searchBM25(query: string, limit = 50): { node_id: string; score: number }[] {
    return this.searchDao.searchBM25(query, limit);
  }

  getNodesByDimension(
    dimension: "SYS" | "CPG" | "DTG",
    limit = 100
  ): GraphNode[] {
    return this.searchDao.getNodesByDimension(dimension, limit);
  }

  transaction(fn: () => void): void {
    this.connectionDao.transaction(fn);
  }

  stats(): { nodes: number; edges: number } {
    return this.connectionDao.stats();
  }

  populateMetadata(): void {
    const rawDb = this.getRawDb();

    const insertStmt = rawDb.prepare(
      `INSERT OR REPLACE INTO node_metadata (node_id, dimension, sub_type)
       VALUES (?, ?, ?)`,
    );

    const edgesStmt = rawDb.prepare(
      "SELECT relation FROM edges WHERE sourceId = ? OR targetId = ?",
    );

    const nodes = rawDb
      .prepare("SELECT id, kind FROM nodes")
      .all() as { id: string; kind: string }[];

    const kindToSubType: Record<string, string> = {
      CLASS: "class",
      METHOD: "method",
      FUNCTION: "function",
      ARROW_FUNCTION: "arrow_function",
      VARIABLE: "variable",
      INTERFACE: "interface",
      TYPE: "type_alias",
      ENUM: "enum",
      ENUM_MEMBER: "enum_member",
      PROPERTY: "property",
      ACCESSOR: "accessor",
      EXTERNAL_LIB: "package",
    };

    const tx = rawDb.transaction(() => {
      for (const node of nodes) {
        const edges = edgesStmt.all(node.id, node.id) as { relation: string }[];
        let sys = 0, cpg = 0, dtg = 0;
        for (const e of edges) {
          if (e.relation === "EXTENDS" || e.relation === "IMPLEMENTS") sys++;
          if (["INJECTS", "CALLS", "INSTANTIATES"].includes(e.relation)) cpg++;
          if (
            ["CONSUMES_DATA", "PRODUCES", "MUTATES_STATE"].includes(e.relation)
          )
            dtg++;
        }
        if (sys === 0 && cpg === 0 && dtg === 0) {
          if (node.kind === "CLASS" || node.kind === "INTERFACE") sys = 1;
          else if (
            node.kind === "METHOD" ||
            node.kind === "FUNCTION" ||
            node.kind === "ARROW_FUNCTION"
          )
            cpg = 1;
          else if (node.kind === "PROPERTY" || node.kind === "VARIABLE") dtg = 1;
        }

        const max = Math.max(sys, cpg, dtg);
        const dim =
          max === sys ? "SYS" : max === cpg ? "CPG" : "DTG";
        const subType = kindToSubType[node.kind] ?? "unknown";

        insertStmt.run(node.id, dim, subType);
      }
    });
    tx();

    console.log(`[LaCoCo] ✅ Metadatos poblados para ${nodes.length} nodos.`);
  }

  close(): void {
    this.connectionDao.close();
  }

  getRawDb(): Database.Database {
    return this.connectionDao.getRawDb();
  }

  #defaultDbPath(): string {
    return path.join(process.cwd(), "tensor.sqlite");
  }
}
