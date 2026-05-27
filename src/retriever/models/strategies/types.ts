import type { SanitizerOutput } from "../utilities/types.js";

export interface ContextChunk {
  nodeId: string;
  score: number;
  text: string;
  source: string;
}

export interface RecoveryStrategy {
  retrieve(query: SanitizerOutput): Promise<ContextChunk[]>;
}
