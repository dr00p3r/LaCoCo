/**
 * embedding-config — Configuración del modelo de embeddings.
 *
 * Módulo PURO (sin importar `@xenova/transformers` ni cargar el modelo): sirve
 * para que tanto el generador como el DAO de vectores y el arnés de evaluación
 * consuman la misma configuración de forma barata.
 *
 * Todo es gateado por variable de entorno con defaults idénticos al
 * comportamiento histórico (all-MiniLM-L6-v2, 384 dims, quantizado). Sin las
 * variables seteadas, nada cambia.
 *
 * Para experimentos de retrieval con otro modelo (p. ej. code-aware), setear:
 *   LACOCO_EMBEDDING_MODEL="jinaai/jina-embeddings-v2-base-code"
 *   LACOCO_EMBEDDING_DIM=768
 *   LACOCO_EMBEDDING_QUANTIZED=false
 * en TODOS los procesos que indexan y que recuperan (el query se embebe con el
 * mismo modelo), o el índice y la consulta quedarán en dimensiones distintas.
 */

/** Modelo de embeddings a cargar en transformers.js (pipeline feature-extraction). */
export const EMBEDDING_MODEL =
  process.env.LACOCO_EMBEDDING_MODEL ?? "Xenova/all-MiniLM-L6-v2";

/** Dimensión del vector; debe coincidir con la salida real del modelo. */
export const EMBEDDING_DIM = Number(process.env.LACOCO_EMBEDDING_DIM ?? 384);

/** Si se usan los pesos cuantizados (más ligeros) del modelo. */
export const EMBEDDING_QUANTIZED = process.env.LACOCO_EMBEDDING_QUANTIZED !== "false";
