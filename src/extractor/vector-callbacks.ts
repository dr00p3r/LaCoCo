import type { ExtractionCallbacks, NodeRow, EdgeRelation } from "./types.js";
import type { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { NodeEmbeddingRecord } from "../persistence/lacoco-vectors-manager/model/types.js";
import { KIND_TO_DIM, type Dimension } from "../domain/dimensions.js";

type VectorEmbeddingWriter = Pick<LaCoCoLanceDb, "replaceBatch">;

function inferKind(node: NodeRow): Dimension {
  return KIND_TO_DIM[node.kind] ?? "DTG";
}

export class VectorCallbacks implements ExtractionCallbacks {
  private readonly pending: NodeRow[] = [];
  private readonly batchSize: number;
  private flushChain: Promise<void> = Promise.resolve();
  private flushScheduled = false;
  nodesWritten = 0;

  constructor(
    private readonly lanceDb: VectorEmbeddingWriter,
    private readonly generateEmbedding: (text: string) => Promise<Float32Array>,
    private readonly inferDimension: (node: NodeRow) => Dimension = inferKind,
    batchSize = 32
  ) {
    this.batchSize = batchSize;
  }

  insertNode(row: NodeRow): void {
    this.pending.push(row);
    this.nodesWritten++;
    if (this.pending.length >= this.batchSize) {
      void this.#scheduleFlush().catch((err: unknown) => {
        console.error(
          "[VectorCallbacks] Error en flush programado:",
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  /** Fuerza el vaciado del lote pendiente */
  async flush(): Promise<void> {
    await this.flushChain;
    while (this.pending.length > 0) {
      await this.#flushNow();
    }
  }

  insertEdge(_sourceId: string, _targetId: string, _relation: EdgeRelation): void {
    // VectorsIndexer no persiste aristas
  }

  #scheduleFlush(): Promise<void> {
    if (this.flushScheduled) return this.flushChain;

    this.flushScheduled = true;
    this.flushChain = this.flushChain
      .then(async () => {
        while (this.pending.length >= this.batchSize) {
          await this.#flushNow();
        }
      })
      .catch((err: unknown) => {
        this.flushChain = Promise.resolve();
        console.error(
          "[VectorCallbacks] Error en cadena de flush:",
          err instanceof Error ? err.message : err,
        );
      })
      .finally(() => {
        this.flushScheduled = false;
      });
    return this.flushChain;
  }

  async #flushNow(): Promise<void> {
    const batch = this.pending.splice(0, this.batchSize);
    const records: NodeEmbeddingRecord[] = [];

    for (const node of batch) {
      const text = `${node.name} ${node.signature}`;
      const embedding = await this.generateEmbedding(text);
      const dimension = this.inferDimension(node);
      records.push({
        node_id: node.id,
        embedding,
        dimension,
        sub_type: node.kind.toLowerCase(),
        file_path: node.filepath,
      });
    }

    await this.lanceDb.replaceBatch(records);
  }
}
