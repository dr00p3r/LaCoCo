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
    const model = await this.getModel();
    const modelFn = model as unknown as (text: string, opts: Record<string, unknown>) => Promise<unknown>;
    const outputs = await Promise.all(
      texts.map((t) => modelFn(t, { pooling: "mean", normalize: true }))
    );
    return outputs.map((o) => new Float32Array((o as { data: number[] }).data));
  }
}
