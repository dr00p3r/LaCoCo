import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { GraphNode, GraphEdge } from "./model/types.js";
import { NodeDao } from "./dao/node-dao.js";
import { EdgeDao } from "./dao/edge-dao.js";
import { SearchDao } from "./dao/search-dao.js";
import { MigrationDao } from "./dao/migration-dao.js";
import { ConnectionDao } from "./dao/connection-dao.js";
import { MetadataDao } from "./dao/metadata-dao.js";
import { type Dimension } from "../../domain/dimensions.js";

export type { GraphNode, GraphEdge };

export class LaCoCoDatabase {
  readonly nodeDao: NodeDao;
  readonly edgeDao: EdgeDao;
  readonly searchDao: SearchDao;
  readonly migrationDao: MigrationDao;
  readonly connectionDao: ConnectionDao;

  private readonly metadataDao: MetadataDao;
  private readonly db: Database.Database;

  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? this.#defaultDbPath();
    fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });
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
    this.metadataDao = new MetadataDao(this.db);

    console.error(`[LaCoCo] Base de datos conectada → ${resolvedPath}`);
  }

  insertNode(node: GraphNode): void {
    this.nodeDao.insertNode(node);
  }

  insertEdge(edge: GraphEdge): void {
    this.edgeDao.insertEdge(edge);
  }

  deleteNodesByFile(filepath: string): string[] {
    return this.nodeDao.deleteNodesByFile(filepath);
  }

  clearGraph(): void {
    this.edgeDao.clearAll();
    this.nodeDao.clearAll();
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

  getNodesByDimension(dimension: Dimension, limit = 100): GraphNode[] {
    return this.searchDao.getNodesByDimension(dimension, limit);
  }

  transaction(fn: () => void): void {
    this.connectionDao.transaction(fn);
  }

  stats(): { nodes: number; edges: number } {
    return this.connectionDao.stats();
  }

  populateMetadata(): void {
    this.metadataDao.populateAll();
  }

  populateMetadataForNodes(ids: string[]): void {
    this.metadataDao.populateForNodes(ids);
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
