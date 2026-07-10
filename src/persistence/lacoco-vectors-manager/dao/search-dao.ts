import * as lancedb from "@lancedb/lancedb";
import type { Dimension } from "../../../domain/dimensions.js";

export interface AnnSearchResult {
  node_id: string;
  score: number;
  /** Dimension almacenada en la fila (`SYS|CPG|DTG`). `undefined` en indices
   *  antiguos que no la persistieron; los consumidores deben tolerarlo. */
  dimension: Dimension | undefined;
}

export class SearchDao {

  async search(
    table: lancedb.Table,
    queryEmbedding: Float32Array,
    filter?: string,
    topK = 50
  ): Promise<AnnSearchResult[]> {

    let query = table.query().nearestTo(queryEmbedding).limit(topK);

    if (filter) query = query.where(filter);

    const results = await query.toArray();

    return results.map((r: Record<string, unknown>) => ({
      node_id: r.node_id as string,
      score: typeof r._distance === "number" ? 1 - r._distance : 0,
      dimension: (r.dimension as Dimension | undefined) ?? undefined,
    }));
  }

}
