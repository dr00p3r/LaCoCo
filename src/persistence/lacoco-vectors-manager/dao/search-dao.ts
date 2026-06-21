import * as lancedb from "@lancedb/lancedb";

export class SearchDao {

  async search(
    table: lancedb.Table,
    queryEmbedding: Float32Array,
    filter?: string,
    topK = 50
  ): Promise<{ node_id: string; score: number }[]> {

    let query = table.query().nearestTo(queryEmbedding).limit(topK);

    if (filter) query = query.where(filter);

    const results = await query.toArray();

    return results.map((r: Record<string, unknown>) => ({
      node_id: r.node_id as string,
      score: typeof r._distance === "number" ? 1 - r._distance : 0,
    }));
  }

}
