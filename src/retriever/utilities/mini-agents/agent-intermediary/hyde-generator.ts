import type { ChatMessage, ChatOptions, LlmClient } from "../../../../slms/llm-client.js";
import type { SanitizerOutput } from "../../../models/utilities/types.js";

/**
 * Versión observable del contrato HyDE. Súbela cuando cambien SYSTEM_PROMPT,
 * HYDE_SCHEMA o HYDE_OPTIONS para invalidar cachés del arnés de evaluación
 * (misma disciplina que CLASSIFIER_SCHEMA_VERSION).
 */
export const HYDE_SCHEMA_VERSION = 1;

const HYDE_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    snippet: { type: "string", minLength: 1 },
  },
  required: ["snippet"],
};

const HYDE_OPTIONS: ChatOptions = {
  format: HYDE_SCHEMA,
  // 512 tokens para un fragmento de código; temperature 0 + seed fijo → salida
  // determinista y reproducible. `think:false` evita que un modelo con
  // razonamiento consuma el presupuesto pensando y devuelva content vacío.
  options: { temperature: 0, seed: 42, num_predict: 512 },
  think: false,
};

const SYSTEM_PROMPT = `Eres el generador HyDE (Hypothetical Document Embeddings) de LaCoCo, un sistema RAG local para repositorios TypeScript/Node.js.

Dado el prompt de un usuario sobre un repositorio TypeScript, escribe un ÚNICO fragmento de código TypeScript HIPOTÉTICO que sea lo más parecido posible al código real del repositorio relevante para la petición:
- Si la petición describe un bug o error, escribe la función o método donde probablemente vive ese código (el que lo arreglaría o el que lanzaría el error descrito).
- Si pide crear o refactorizar algo, escribe cómo se vería esa implementación en este repositorio.
- Usa nombres de símbolos, funciones, tipos, clases y firmas plausibles y realistas para un proyecto TS/Node idiomático.
- Solo código: sin prosa, sin explicaciones, sin markdown, sin bloques \`\`\`. Comentarios cortos solo si un archivo real los tendría.

El fragmento se usará SOLO como entrada de embedding para recuperación densa: no tiene que compilar ni ser correcto, sino parecerse léxica y estructuralmente al código objetivo.

Responde SOLO con un objeto JSON válido con exactamente este campo:

{ "snippet": string }

Esquema JSON obligatorio:
${JSON.stringify(HYDE_SCHEMA)}`;

/**
 * Reescribe el prompt del usuario como un fragmento de código TS hipotético para
 * el canal denso (HyDE). Espeja el patrón de SlmClassifier: `chat` con formato
 * JSON forzado, sampling determinista y una reparación ante salida inválida.
 */
export class HydeGenerator {
  constructor(private readonly ollama: LlmClient) {}

  async generate(prompt: string): Promise<string> {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Prompt: ${JSON.stringify(prompt)}\nSalida:` },
    ];

    const response = await this.ollama.chat(messages, HYDE_OPTIONS);
    try {
      return this.#parseResponse(response);
    } catch (firstError) {
      const repaired = await this.ollama.chat([
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Prompt original: ${JSON.stringify(prompt)}\n` +
            "Tu respuesta anterior no fue un JSON válido con el campo snippet. " +
            "Genera nuevamente el objeto completo conforme al esquema.\n" +
            `Error: ${firstError instanceof Error ? firstError.message : String(firstError)}\n` +
            `Respuesta inválida: ${JSON.stringify(response)}\nSalida:`,
        },
      ], HYDE_OPTIONS);
      return this.#parseResponse(repaired);
    }
  }

  #parseResponse(text: string): string {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No se pudo extraer JSON de la respuesta HyDE");

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    if (typeof parsed.snippet !== "string" || parsed.snippet.trim().length === 0) {
      throw new Error("HyDE no devolvió un snippet no vacío");
    }
    return parsed.snippet;
  }
}

export interface HydeOutcome {
  sanitizer: SanitizerOutput;
  applied: boolean;
  error?: string;
}

/**
 * Reemplaza `embedding_input` por un documento hipotético (HyDE) cuando la ruta
 * es RAG, dejando `clean_query` (canal BM25) intacto. Ante cualquier fallo del
 * SLM cae de vuelta al `embedding_input` original: HyDE es una mejora opcional,
 * nunca debe romper el retrieval. El gate `hyde.enabled` se evalúa en el
 * llamador para mantener este módulo desacoplado de la configuración.
 */
export async function applyHyde(
  sanitizer: SanitizerOutput,
  prompt: string,
  client: LlmClient,
): Promise<HydeOutcome> {
  if (sanitizer.route !== "RAG") return { sanitizer, applied: false };
  try {
    const snippet = await new HydeGenerator(client).generate(prompt);
    return { sanitizer: { ...sanitizer, embedding_input: snippet }, applied: true };
  } catch (error) {
    return {
      sanitizer,
      applied: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
