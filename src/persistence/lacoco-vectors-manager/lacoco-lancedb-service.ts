import * as lancedb from "@lancedb/lancedb";
import type { NodeEmbeddingRecord } from "./model/types.js";
import { ConnectionDao } from "./dao/connection-dao.js";
import { EmbeddingDao } from "./dao/embedding-dao.js";
import { SearchDao } from "./dao/search-dao.js";

export type { NodeEmbeddingRecord };

export class LaCoCoLanceDb {
  private db: lancedb.Connection | null = null;
  private table: lancedb.Table | null = null;

  private readonly connectionDao: ConnectionDao;
  private readonly embeddingDao: EmbeddingDao;
  private readonly searchDao: SearchDao;

  constructor(private readonly dbPath: string = "./lancedb") {
    this.connectionDao = new ConnectionDao();
    this.embeddingDao = new EmbeddingDao();
    this.searchDao = new SearchDao();
  }

  async connect(): Promise<void> {
    const { db, table } = await this.connectionDao.connect(this.dbPath);
    this.db = db;
    this.table = table;
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.connectionDao.close(this.db);
      this.db = null;
      this.table = null;
    }
  }

  async insertBatch(records: NodeEmbeddingRecord[]): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    await this.embeddingDao.insertBatch(this.table, records);
  }

  async search(
    queryEmbedding: Float32Array,
    filter?: string,
    topK = 50
  ): Promise<{ node_id: string; score: number }[]> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    return this.searchDao.search(this.table, queryEmbedding, filter, topK);
  }

  async deleteByNodeId(nodeId: string): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    await this.embeddingDao.deleteByNodeId(this.table, nodeId);
  }

  async buildIndex(): Promise<void> {
    if (!this.table) throw new Error("LanceDB no conectado. Llame a connect() primero.");
    await this.connectionDao.buildIndex(this.table);
  }
}
