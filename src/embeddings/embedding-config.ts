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

/**
 * Nº de textos por pasada del modelo al indexar vectores. El modelo pad-ea el
 * batch a la longitud del texto más largo, así que con firmas grandes (p. ej.
 * repos como prettier) un batch de 32 puede disparar el pico de memoria y morir
 * por OOM. Bajarlo (p. ej. 4) acota el pico sin cambiar los embeddings.
 * Default 32 (comportamiento histórico).
 */
export const EMBEDDING_BATCH_SIZE = (() => {
  const raw = Number(process.env.LACOCO_EMBEDDING_BATCH_SIZE ?? 32);
  return Number.isInteger(raw) && raw > 0 ? raw : 32;
})();

/**
 * Cap de caracteres del texto a embeber (`name + signature`). El modelo pad-ea el
 * batch al texto más largo; un solo nodo con firma gigante (p. ej. un object-literal
 * de ~80k chars en prettier) dispara OOM. Capar acota el pico sin afectar a los
 * nodos normales (avg ~200-800 chars). Default alto (efectivamente sin cap) para
 * preservar el comportamiento histórico; setéalo (p. ej. 2000) al re-indexar repos
 * con firmas patológicas. La cabeza del texto conserva name + inicio de la firma.
 */
export const EMBEDDING_MAX_CHARS = (() => {
  const raw = Number(process.env.LACOCO_EMBEDDING_MAX_CHARS ?? 1_000_000);
  return Number.isInteger(raw) && raw > 0 ? raw : 1_000_000;
})();
