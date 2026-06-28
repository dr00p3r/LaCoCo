import * as lancedb from "@lancedb/lancedb";
import type { NodeEmbeddingRecord } from "../model/types.js";

export class EmbeddingDao {
  async insertBatch(table: lancedb.Table, records: NodeEmbeddingRecord[]): Promise<void> {
    if (records.length === 0) return;
    await table.add(records as unknown as Record<string, unknown>[]);
  }

  async replaceBatch(table: lancedb.Table, records: NodeEmbeddingRecord[]): Promise<void> {
    const uniqueRecords = this.#deduplicateByNodeId(records);
    if (uniqueRecords.length === 0) return;

    await table
      .mergeInsert("node_id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(uniqueRecords as unknown as Record<string, unknown>[]);
  }

  async deleteByNodeId(table: lancedb.Table, nodeId: string): Promise<void> {
    await table.delete(`node_id = '${this.#escapeLiteral(nodeId)}'`);
  }

  async deleteByNodeIds(table: lancedb.Table, nodeIds: string[]): Promise<void> {
    const uniqueNodeIds = Array.from(new Set(nodeIds));
    if (uniqueNodeIds.length === 0) return;

    const values = uniqueNodeIds
      .map((nodeId) => `'${this.#escapeLiteral(nodeId)}'`)
      .join(", ");
    await table.delete(`node_id IN (${values})`);
  }

  async deleteByFilePath(table: lancedb.Table, filePath: string): Promise<void> {
    await table.delete(`file_path = '${this.#escapeLiteral(filePath)}'`);
  }

  async clear(table: lancedb.Table): Promise<void> {
    await table.delete("node_id IS NOT NULL");
  }

  #escapeLiteral(value: string): string {
    if (!/^[a-zA-Z0-9_\-#\.\/:' ]+$/.test(value)) {
      throw new Error(`Valor inseguro para filtro LanceDB: ${JSON.stringify(value)}`);
    }
    return value.replaceAll("'", "''");
  }

  #deduplicateByNodeId(records: NodeEmbeddingRecord[]): NodeEmbeddingRecord[] {
    return Array.from(
      records.reduce((byNodeId, record) => {
        byNodeId.set(record.node_id, record);
        return byNodeId;
      }, new Map<string, NodeEmbeddingRecord>()).values(),
    );
  }
}
