import type { SanitizerOutput } from "../utilities/types.js";

export interface ContextChunk {
  chunkId: string;
  nodeId: string;
  score: number;
  text: string;
  source: string;
  path?: {
    nodes: string[];
    relations: string[];
    dimensions: string[];
  };
  diagnostics?: {
    duplicateCount?: number;
  };
}

export interface RecoveryStrategy {
  retrieve(query: SanitizerOutput): Promise<ContextChunk[]>;
}
