import type { SanitizerOutput } from "../utilities/types.js";

export interface ContextChunk {
  chunkId: string;
  nodeId: string;
  score: number;
  text: string;
  source: string;
  /**
   * Localización del símbolo en el working tree cuando `text` contiene el CUERPO
   * (template v2, poblado por ChunkBodyResolver). Ausente = `text` es la firma.
   */
  location?: {
    filepath: string;
    startLine: number;
    endLine: number;
    truncated: boolean;
  };
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
