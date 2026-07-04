import * as lancedb from "@lancedb/lancedb";

export class ConnectionDao {
  async connect(dbPath: string): Promise<{ db: lancedb.Connection; table: lancedb.Table }> {
    const db = await lancedb.connect(dbPath);
    const existingTables = await db.tableNames();

    if (!existingTables.includes("node_embeddings")) {
      const dummyRecord = {
        node_id: "__schema_init__",
        embedding: new Float32Array(384),
        dimension: "CPG" as const,
        sub_type: "dummy",
        file_path: "/dev/null",
        package_name: "",
        package_version: "",
      };
      const table = await db.createTable("node_embeddings", [dummyRecord]);
      await table.delete("node_id = '__schema_init__'");
      return { db, table };
    }

    const table = await db.openTable("node_embeddings");
    return { db, table };
  }

  async close(connection: lancedb.Connection): Promise<void> {
    await connection.close();
  }

  async buildIndex(table: lancedb.Table): Promise<void> {
    await table.createIndex("embedding", {
      config: lancedb.Index.hnswSq({
        distanceType: "cosine",
        numPartitions: 1,
      }),
      name: "embedding_hnsw",
      replace: true,
      waitTimeoutSeconds: 60,
    });
  }

  async optimize(
    table: lancedb.Table,
    cleanupOlderThan: Date,
  ): Promise<lancedb.OptimizeStats> {
    return table.optimize({ cleanupOlderThan, deleteUnverified: false });
  }

  async stats(table: lancedb.Table): Promise<lancedb.TableStatistics> {
    return table.stats();
  }

  async unindexedRows(table: lancedb.Table, indexName: string): Promise<number> {
    return (await table.indexStats(indexName))?.numUnindexedRows ?? 0;
  }
}
