/**
 * Tipos base del pipeline RAG — compartidos entre todos los módulos de retrieval.
 *
 * Ninguna implementación concreta debe depender de detalles de storage aquí.
 * Estos tipos son la interfaz pública del sistema.
 */

/** Etiqueta de intención detectada por el Agente Intermediario 1 */
export type IntentTag =
  | "understand"    // "¿qué hace esta función?"
  | "refactor"      // "refactoriza X para que..."
  | "create"        // "crea un endpoint que..."
  | "debug"         // "por qué falla X"
  | "integrate"     // "usa la librería X para..."
  | "unknown";      // fallback

/** Salida del sanitizador / clasificador */
export interface SanitizerOutput {
  route: "RAG" | "LLM_DIRECT";
  clean_query: string;              // normalizado para BM25/FTS5
  embedding_input: string;          // semántico para LanceDB
  dimensions: ("SYS" | "CPG" | "DTG")[];  // puede ser múltiple
  intent: IntentTag;
  confidence: number;               // 0.0–1.0, umbral recomendado: 0.65
}

/** Chunk de contexto recuperado para inyección en el prompt */
export interface ContextChunk {
  nodeId: string;
  score: number;
  text: string;       // firma o contenido relevante del nodo
  source: string;     // "BM25" | "ANN" | "AGENTIC" | "RRF"
}

/** Interfaz común de todas las estrategias de recuperación */
export interface RecoveryStrategy {
  /**
   * Recupera chunks de contexto relevantes para la consulta dada.
   *
   * @param query Salida sanitizada del Agente Intermediario 1
   * @returns Lista ordenada de chunks por relevancia descendente
   */
  retrieve(query: SanitizerOutput): Promise<ContextChunk[]>;
}
