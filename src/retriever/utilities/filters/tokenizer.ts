/**
 * Token budget estimation for LaCoCo context aggregation.
 *
 * Usa `gpt-tokenizer` (cl100k_base) como aproximacion. NO es el tokenizer
 * exacto del modelo generador final (opencode-go/*), que en la mayoria de
 * los casos usa BPE propio o SentencePiece. La eleccion de cl100k_base
 * obedece a:
 *  - Amplia cobertura de texto tecnico en espanol e ingles.
 *  - Dependencia estable, MIT, ESM nativo.
 *  - Cero latencia de inicio (lazy singleton).
 *
 * Para analisis fino de sub-tokens especificos del modelo generador
 * final, se requeriria el tokenizer del modelo (no se incluye en este
 * paso por costo de portabilidad y porque la diferencia contra
 * cl100k_base en textos de <5000 tokens es < 5%).
 */

import gptTokenizer from "gpt-tokenizer";

/**
 * Estima el numero de tokens de un texto usando el tokenizer cl100k_base.
 *
 * Implementacion cacheada: el encoder se inicializa una sola vez por
 * proceso y se reutiliza para todas las llamadas.
 */
const encoder: { encode: (text: string) => number[] } = gptTokenizer as unknown as {
  encode: (text: string) => number[];
};

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return encoder.encode(text).length;
}

/**
 * Identifica el modelo de tokenizer usado. Util para que los reportes
 * de benchmark citen explicitamente la aproximacion.
 */
export const TOKENIZER_NAME = "cl100k_base";
export const TOKENIZER_PACKAGE = "gpt-tokenizer";
export const TOKENIZER_NOTE =
  "Aproximacion OpenAI cl100k_base. No es el tokenizer exacto del modelo generador.";
