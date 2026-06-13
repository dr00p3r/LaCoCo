import type { ExtractionCallbacks, NodeRow, EdgeRelation } from "./types.js";
import type { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { NodeEmbeddingRecord } from "../persistence/lacoco-vectors-manager/model/types.js";

function inferKind(node: NodeRow): "SYS" | "CPG" | "DTG" {
  if (node.kind === "CLASS" || node.kind === "INTERFACE") return "SYS";
  if (node.kind === "METHOD" || node.kind === "FUNCTION" || node.kind === "ARROW_FUNCTION") return "CPG";
  return "DTG";
}

export class VectorCallbacks implements ExtractionCallbacks {
  private readonly pending: NodeRow[] = [];
  private readonly batchSize: number;
  nodesWritten = 0;

  constructor(
    private readonly lanceDb: LaCoCoLanceDb,
    private readonly generateEmbedding: (text: string) => Promise<Float32Array>,
    private readonly inferDimension: (node: NodeRow) => "SYS" | "CPG" | "DTG" = inferKind,
    batchSize = 32
  ) {
    this.batchSize = batchSize;
  }

  insertNode(row: NodeRow): void {
    this.pending.push(row);
    this.nodesWritten++;
    if (this.pending.length >= this.batchSize) {
      void this.#flush();
    }
  }

  /** Fuerza el vaciado del lote pendiente */
  async flush(): Promise<void> {
    if (this.pending.length > 0) {
      await this.#flushNow();
    }
  }

  insertEdge(_sourceId: string, _targetId: string, _relation: EdgeRelation): void {
    // VectorsIndexer no persiste aristas
  }

  #flush(): Promise<void> {
    return this.#flushNow();
  }

  async #flushNow(): Promise<void> {
    const batch = this.pending.splice(0, this.batchSize);
    const records: NodeEmbeddingRecord[] = [];

    for (const node of batch) {
      const text = `${node.name} ${node.signature}`;
      const [embedding, dimension] = await Promise.all([
        this.generateEmbedding(text),
        this.inferDimension(node),
      ]);
      records.push({
        node_id: node.id,
        embedding,
        dimension,
        sub_type: node.kind.toLowerCase(),
        file_path: node.filepath,
      });
    }

    await this.lanceDb.insertBatch(records);
  }
}
