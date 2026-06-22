import * as lancedb from "@lancedb/lancedb";
import type { NodeEmbeddingRecord } from "../model/types.js";

export class EmbeddingDao {
  async insertBatch(table: lancedb.Table, records: NodeEmbeddingRecord[]): Promise<void> {
    if (records.length === 0) return;
    await table.add(records as unknown as Record<string, unknown>[]);
  }

  async deleteByNodeId(table: lancedb.Table, nodeId: string): Promise<void> {
    await table.delete(`node_id = '${this.#escapeLiteral(nodeId)}'`);
  }

  async deleteByFilePath(table: lancedb.Table, filePath: string): Promise<void> {
    await table.delete(`file_path = '${this.#escapeLiteral(filePath)}'`);
  }

  async clear(table: lancedb.Table): Promise<void> {
    await table.delete("node_id IS NOT NULL");
  }

  #escapeLiteral(value: string): string {
    return value.replaceAll("'", "''");
  }
}
