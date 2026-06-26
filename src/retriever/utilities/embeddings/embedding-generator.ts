/**
 * EmbeddingGenerator — Motor de embeddings local vía transformers.js
 *
 * Carga lazy el modelo `all-MiniLM-L6-v2` (~80MB) de Xenova.
 * Genera vectores de 384 dimensiones para indexación en LanceDB.
 */

import { pipeline } from "@xenova/transformers";

export const EMBEDDING_DIM = 384;

/** Tipo opaco del pipeline de feature-extraction */
type EmbeddingPipeline = Awaited<ReturnType<typeof pipeline>>;

export class EmbeddingGenerator {
  private modelPromise: Promise<EmbeddingPipeline> | null = null;

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
        "Xenova/all-MiniLM-L6-v2",
        { quantized: true }
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

    const model = await this.getModel();
    const output = await (model as unknown as (text: string, opts: Record<string, unknown>) => Promise<unknown>)(
      text, { pooling: "mean", normalize: true }
    );
    // output.data es un TypedArray; lo convertimos explícitamente
    return new Float32Array((output as { data: number[] }).data);
  }

  /**
   * Genera embeddings en batch para múltiples textos.
   * Más eficiente que llamadas individuales en bucle.
   *
   * @param texts Array de textos a vectorizar
   * @returns Array de Float32Array, uno por entrada
   */
  async generateBatch(texts: string[]): Promise<Float32Array[]> {
    if (process.env.LACOCO_TEST_EMBEDDINGS === "1") {
      return texts.map(deterministicTestEmbedding);
    }

    const model = await this.getModel();
    const modelFn = model as unknown as (text: string, opts: Record<string, unknown>) => Promise<unknown>;
    const results = await Promise.allSettled(
      texts.map((t) => modelFn(t, { pooling: "mean", normalize: true }))
    );
    const embeddings: Float32Array[] = [];
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      if (result.status === "fulfilled") {
        embeddings.push(new Float32Array((result.value as { data: number[] }).data));
      } else {
        console.error(
          `[EmbeddingGenerator] Fallo en embedding ${i}:`,
          result.reason instanceof Error ? result.reason.message : result.reason,
        );
      }
    }
    return embeddings;
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
