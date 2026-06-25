import {
  type RecoveryStrategy,
  type ContextChunk,
} from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { HybridAnchorService } from "../utilities/search/hybrid-anchor-service.js";

export class HybridStrategy implements RecoveryStrategy {

  private readonly anchors: HybridAnchorService;

  constructor(
    db: LaCoCoDatabase,
    lanceDb: LaCoCoLanceDb,
  ) {
    this.anchors = new HybridAnchorService(db, lanceDb);
  }

  /**
   * Recupera contexto mediante fusión híbrida de rankings.
   *
   * @param query Salida sanitizada del intermediario
   * @returns Chunks fusionados y ordenados por score RRF
   */
  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    const anchors = await this.anchors.search(query, 20);
    return anchors.map(({ nodeId, score, text }) => ({
      nodeId,
      score,
      text,
      source: "RRF",
    }));
  }

}
