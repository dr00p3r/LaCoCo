import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { ContextChunk, RecoveryStrategy } from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import { HybridAnchorService, type HybridAnchor } from "../utilities/search/hybrid-anchor-service.js";

export abstract class AbstractAnchoredStrategy implements RecoveryStrategy {
  private readonly anchors: HybridAnchorService;

  protected constructor(
    protected readonly db: LaCoCoDatabase,
    lanceDb: LaCoCoLanceDb,
  ) {
    this.anchors = new HybridAnchorService(db, lanceDb);
  }

  /**
   * Recupera anclas híbridas y delega la expansión específica a la estrategia.
   *
   * @param query Salida sanitizada del intermediario.
   * @returns Chunks ordenados por la estrategia concreta.
   */
  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    const anchors = await this.anchor(query, this.getAnchorLimit());
    if (anchors.length === 0) return [];
    return this.expand(anchors, query);
  }

  protected async anchor(query: SanitizerOutput, limit: number): Promise<HybridAnchor[]> {
    return (await this.anchors.search(query, limit)).slice(0, limit);
  }

  protected toChunk(anchor: HybridAnchor, source: string, score = anchor.score): ContextChunk {
    return {
      chunkId: anchor.nodeId,
      nodeId: anchor.nodeId,
      score,
      text: anchor.text,
      source,
    };
  }

  protected abstract getAnchorLimit(): number;

  protected abstract expand(
    anchors: HybridAnchor[],
    query: SanitizerOutput,
  ): Promise<ContextChunk[]>;
}
