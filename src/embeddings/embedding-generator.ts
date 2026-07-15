/**
 * EmbeddingGenerator — Motor de embeddings local vía transformers.js
 *
 * Carga lazy el modelo `all-MiniLM-L6-v2` (~80MB) de Xenova.
 * Genera vectores de 384 dimensiones para indexación en LanceDB.
 */

import { pipeline, env } from "@xenova/transformers";
import { EMBEDDING_MODEL, EMBEDDING_DIM, EMBEDDING_QUANTIZED } from "./embedding-config.js";
import { EmbeddingCache, isEmbeddingCacheEnabled } from "./embedding-cache.js";

// Modo offline opt-in (entornos sandbox/CI donde huggingface.co responde 403 y la
// revalidación remota de transformers.js cuelga). Con LACOCO_EMBEDDINGS_OFFLINE=1 se
// deshabilita la carga remota: el modelo DEBE existir en env.localModelPath. No altera
// el comportamiento por defecto (online) cuando la variable no está.
if (process.env.LACOCO_EMBEDDINGS_OFFLINE === "1") {
  env.allowRemoteModels = false;
}

// Re-exportado por compatibilidad con importadores actuales. La fuente de verdad
// es embedding-config.
export { EMBEDDING_DIM };

/** Tipo opaco del pipeline de feature-extraction */
type EmbeddingPipeline = Awaited<ReturnType<typeof pipeline>>;

export class EmbeddingGenerator {
  private modelPromise: Promise<EmbeddingPipeline> | null = null;
  private readonly cache: EmbeddingCache | null;

  constructor(cache: EmbeddingCache | null = isEmbeddingCacheEnabled()
    ? new EmbeddingCache()
    : null) {
    this.cache = cache;
  }

  dispose(): void {
    this.modelPromise = null;
  }

  /**
   * Carga lazy del modelo. La primera llamada descarga y cachea el modelo.
   * Subsecuentes llamadas reutilizan la instancia en memoria.
   */
  private async getModel(): Promise<EmbeddingPipeline> {
    if (!this.modelPromise) {
      this.modelPromise = pipeline(
        "feature-extraction",
        EMBEDDING_MODEL,
        { quantized: EMBEDDING_QUANTIZED }
      );
    }
    return this.modelPromise;
  }

  /**
   * Genera un embedding de 384 dimensiones para un texto individual.
   *
   * @param text Texto a vectorizar (ej. firma de función, nombre de clase)
   * @returns Float32Array de longitud 384, normalizado L2
   */
  async generate(text: string): Promise<Float32Array> {
    if (process.env.LACOCO_TEST_EMBEDDINGS === "1") {
      return deterministicTestEmbedding(text);
    }

    const cached = this.cache?.get(text);
    if (cached !== null && cached !== undefined) {
      return cached;
    }

    const model = await this.getModel();
    const output = await (model as unknown as (text: string, opts: Record<string, unknown>) => Promise<unknown>)(
      text, { pooling: "mean", normalize: true }
    );
    // output.data es un TypedArray; lo convertimos explícitamente
    const vector = new Float32Array((output as { data: number[] }).data);
    this.cache?.set(text, vector);
    return vector;
  }

  /**
   * Genera embeddings en batch para múltiples textos.
   *
   * Realiza UNA sola llamada al modelo con todos los textos faltantes
   * (después de filtrar los hits de cache). El runtime de transformers.js
   * acepta `string[]` nativamente y aplica mean-pooling + L2 normalization
   * sobre todo el batch en una sola inferencia → ~30% wall time menos en CPU
   * comparado con N llamadas individuales. El output del modelo es un tensor
   * con `data` flat y `dims: [batch, hidden_size]`; se extrae cada embedding
   * del slice correspondiente y se cachea.
   *
   * @param texts Array de textos a vectorizar
   * @returns Array de Float32Array, uno por entrada, en el mismo orden
   */
  async generateBatch(texts: string[]): Promise<Float32Array[]> {
    if (process.env.LACOCO_TEST_EMBEDDINGS === "1") {
      return texts.map(deterministicTestEmbedding);
    }

    const embeddings: (Float32Array | undefined)[] = new Array(texts.length);
    const missingIndices: number[] = [];
    for (let i = 0; i < texts.length; i++) {
      const text = texts[i]!;
      const cached = this.cache?.get(text);
      if (cached !== null && cached !== undefined) {
        embeddings[i] = cached;
      } else {
        missingIndices.push(i);
      }
    }

    if (missingIndices.length === 0) {
      return embeddings as Float32Array[];
    }

    const model = await this.getModel();
    const modelFn = model as unknown as (
      input: string | string[],
      opts: Record<string, unknown>,
    ) => Promise<{ data: ArrayLike<number>; dims?: number[] }>;
    const missingTexts = missingIndices.map((i) => texts[i]!);

    let output: { data: ArrayLike<number>; dims?: number[] };
    try {
      output = await modelFn(missingTexts, { pooling: "mean", normalize: true });
    } catch (err) {
      console.error(
        `[EmbeddingGenerator] Fallo en batch de ${missingIndices.length} embeddings:`,
        err instanceof Error ? err.message : String(err),
      );
      // Devolver lo cacheado; los textos faltantes quedan con vector vacío
      // para no romper al consumidor (las inserciones vacías son detectables
      // y descartables aguas abajo si se desea).
      for (const idx of missingIndices) {
        if (embeddings[idx] === undefined) embeddings[idx] = new Float32Array(0);
      }
      return embeddings as Float32Array[];
    }

    const dims = output.dims;
    if (!dims || dims.length !== 2 || dims[0] !== missingTexts.length) {
      console.error(
        `[EmbeddingGenerator] Output dims inesperado: ${JSON.stringify(dims)} ` +
          `(esperaba [${missingTexts.length}, hidden]). Cayendo a embeddings vacíos.`,
      );
      for (const idx of missingIndices) {
        if (embeddings[idx] === undefined) embeddings[idx] = new Float32Array(0);
      }
      return embeddings as Float32Array[];
    }
    const hiddenSize = dims[1]!;
    const data = output.data;
    for (let k = 0; k < missingIndices.length; k++) {
      const slice = new Float32Array(hiddenSize);
      for (let j = 0; j < hiddenSize; j++) {
        slice[j] = data[k * hiddenSize + j]!;
      }
      const originalIndex = missingIndices[k]!;
      embeddings[originalIndex] = slice;
      this.cache?.set(missingTexts[k]!, slice);
    }
    return embeddings as Float32Array[];
  }
}

function deterministicTestEmbedding(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIM);
  for (let index = 0; index < text.length; index++) {
    const vectorIndex = index % EMBEDDING_DIM;
    vector[vectorIndex] = (vector[vectorIndex] ?? 0) + text.charCodeAt(index) / 255;
  }

  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;

  for (let index = 0; index < vector.length; index++) {
    vector[index] = vector[index]! / norm;
  }
  return vector;
}

