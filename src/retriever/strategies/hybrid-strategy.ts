import type { ContextChunk } from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { AbstractAnchoredStrategy } from "./abstract-anchored-strategy.js";
import type { HybridAnchor } from "../utilities/search/hybrid-anchor-service.js";

export interface HybridConfig {
  anchorLimit: number;
}

export const HYBRID_DEFAULT_CONFIG: Readonly<HybridConfig> = Object.freeze({
  anchorLimit: 20,
});

export class HybridStrategy extends AbstractAnchoredStrategy {
  private readonly config: HybridConfig;

  constructor(
    db: LaCoCoDatabase,
    lanceDb: LaCoCoLanceDb,
    config?: Partial<HybridConfig>,
  ) {
    super(db, lanceDb);
    this.config = { ...HYBRID_DEFAULT_CONFIG, ...config };
  }

  protected getAnchorLimit(): number {
    return this.config.anchorLimit;
  }

  protected async expand(anchors: HybridAnchor[], _query: SanitizerOutput): Promise<ContextChunk[]> {
    return anchors.map((anchor) => this.toChunk(anchor, "RRF"));
  }

}
