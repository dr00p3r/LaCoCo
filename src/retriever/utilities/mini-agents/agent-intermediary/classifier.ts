import type { ChatMessage, ChatOptions, LlmClient } from "../../../../slms/llm-client.js";
import { DIMENSIONS } from "../../../../domain/dimensions.js";
import type { IntentTag } from "../../../models/utilities/types.js";
import type { ClassificationResult } from "./types.js";

const ROUTES = ["RAG", "LLM_DIRECT"] as const;
const INTENTS: IntentTag[] = [
  "understand",
  "refactor",
  "create",
  "debug",
  "integrate",
  "unknown",
];
const CLASSIFICATION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    route: { type: "string", enum: [...ROUTES] },
    clean_query: { type: "string" },
    embedding_input: { type: "string", minLength: 1 },
    dimensions: {
      type: "array",
      items: { type: "string", enum: [...DIMENSIONS] },
      uniqueItems: true,
      maxItems: DIMENSIONS.length,
    },
    intent: { type: "string", enum: INTENTS },
    confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: [
    "route",
    "clean_query",
    "embedding_input",
    "dimensions",
    "intent",
    "confidence",
  ],
};
const CLASSIFICATION_OPTIONS: ChatOptions = {
  format: CLASSIFICATION_SCHEMA,
  options: { temperature: 0, seed: 42, num_predict: 256 },
};
const SYSTEM_PROMPT = `Eres el agente intermediario de LaCoCo, un sistema RAG local para repositorios TypeScript/Node.js.

Debes transformar por completo el prompt del usuario. No existe preprocesamiento heurístico posterior: tu salida será utilizada directamente para búsqueda FTS5, embeddings y selección dimensional.

Responde SOLO con un objeto JSON válido, sin markdown ni texto adicional, con exactamente estos campos:

{
  "route": "RAG" | "LLM_DIRECT",
  "clean_query": string,
  "embedding_input": string,
  "dimensions": ("SYS" | "CPG" | "DTG")[],
  "intent": "understand" | "refactor" | "create" | "debug" | "integrate" | "unknown",
  "confidence": number
}

Responsabilidad de cada campo:

1. route
   - RAG cuando la petición depende del repositorio actual o pretende leer, explicar, crear, modificar, depurar o integrar código en él.
   - Toda orden de cambiar implementación, límites, configuración, estrategias, pruebas, comandos o documentación del proyecto es RAG, aunque no mencione un archivo concreto.
   - Referencias como "the strategies", "hybrid", "recovery chunks", "the project" o equivalentes describen artefactos del repositorio y requieren RAG.
   - LLM_DIRECT solo para conversación o conocimiento genérico que no necesita el proyecto.
   - No elijas LLM_DIRECT para una solicitud de refactorización del proyecto ni porque la instrucción sea breve o de alto nivel.
   - Si existe duda, elige RAG.

2. clean_query
   - Para RAG, genera una consulta SQLite FTS5 precisa.
   - Conserva nombres de símbolos, archivos, rutas, métodos, clases, paquetes y términos técnicos relevantes.
   - Combina alternativas con OR y encierra cada término o frase entre comillas dobles.
   - No incluyas instrucciones conversacionales ni sintaxis distinta de frases entre comillas y OR.
   - Para LLM_DIRECT, usa una cadena vacía.

3. embedding_input
   - Para RAG, redacta una consulta semántica breve y autosuficiente que preserve la intención y todos los símbolos relevantes.
   - Para LLM_DIRECT, conserva el significado completo del prompt para el modelo final.

4. dimensions
   - Usa solo la taxonomía canónica definida en src/domain/dimensions.ts.
   - SYS: contratos, herencia, interfaces, módulos y dependencias externas.
   - CPG: estructura, llamadas, instanciación, inyección y flujo de ejecución.
   - DTG: tipos, DTOs, entradas, salidas, producción, consumo y mutación de datos.
   - Puede contener varias dimensiones. Para LLM_DIRECT debe ser [].

5. intent
   - Clasifica la acción principal solicitada.

6. confidence
   - Número entre 0.0 y 1.0 que refleje tu confianza en toda la transformación.

Ejemplos:

Prompt: refactoriza OrderService para usar async/await
Salida: {"route":"RAG","clean_query":"\"OrderService\" OR \"async\" OR \"await\"","embedding_input":"Refactorizar OrderService para usar async/await","dimensions":["CPG"],"intent":"refactor","confidence":0.96}

Prompt: por qué save falla al persistir CreateOrderDto
Salida: {"route":"RAG","clean_query":"\"save\" OR \"CreateOrderDto\"","embedding_input":"Depurar por qué save falla al persistir CreateOrderDto","dimensions":["CPG","DTG"],"intent":"debug","confidence":0.94}

Prompt: modify the recovery chunks of the strategies based on hybrid to be only 20
Salida: {"route":"RAG","clean_query":"\"recovery chunks\" OR \"hybrid\" OR \"strategies\"","embedding_input":"Modify hybrid-based recovery strategies to return only 20 chunks","dimensions":["CPG"],"intent":"refactor","confidence":0.98}

Prompt: qué es TypeScript
Salida: {"route":"LLM_DIRECT","clean_query":"","embedding_input":"Explicar qué es TypeScript","dimensions":[],"intent":"understand","confidence":0.99}

Esquema JSON obligatorio:
${JSON.stringify(CLASSIFICATION_SCHEMA)}`;

export class SlmClassifier {

  constructor(private readonly ollama: LlmClient) {}

  async classify(prompt: string): Promise<ClassificationResult> {
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Prompt: ${JSON.stringify(prompt)}\nSalida:` },
    ];
    const initial = await this.#classifyWithRepair(prompt, messages);

    if (initial.route !== "LLM_DIRECT") return initial;

    return this.#classifyWithRepair(prompt, [
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content:
          "Verifica de forma independiente una propuesta LLM_DIRECT. " +
          "LLM_DIRECT omite todo acceso al repositorio, por lo que solo es correcto si la petición puede resolverse completamente sin leer ni modificar el proyecto actual. " +
          "Devuelve el objeto completo corregido, no una explicación.\n" +
          `Prompt original: ${JSON.stringify(prompt)}\n` +
          `Propuesta a verificar: ${JSON.stringify(initial)}\nSalida final:`,
      },
    ]);
  }

  async #classifyWithRepair(
    prompt: string,
    messages: ChatMessage[],
  ): Promise<ClassificationResult> {
    const response = await this.ollama.chat(messages, CLASSIFICATION_OPTIONS);

    try {
      return this.#parseResponse(response);
    } catch (firstError) {
      const repairedResponse = await this.ollama.chat([
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content:
            `Prompt original: ${JSON.stringify(prompt)}\n` +
            "Tu respuesta anterior no fue JSON válido o incumplió el contrato. " +
            "Genera nuevamente el objeto completo conforme al esquema.\n" +
            `Respuesta inválida: ${JSON.stringify(response)}\nSalida:`,
        },
      ], CLASSIFICATION_OPTIONS);

      try {
        return this.#parseResponse(repairedResponse);
      } catch (secondError) {
        throw new Error(
          "El SLM no produjo una salida JSON válida después de dos intentos",
          { cause: secondError instanceof Error ? secondError : firstError },
        );
      }
    }
  }

  #parseResponse(text: string): ClassificationResult {
    
    const jsonMatch = text.match(/\{[\s\S]*\}/);

    if (!jsonMatch) throw new Error("No se pudo extraer JSON de la respuesta del SLM");

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    if (!ROUTES.includes(parsed.route as (typeof ROUTES)[number])) throw new Error("El SLM devolvió una ruta inválida");
    if (!INTENTS.includes(parsed.intent as IntentTag)) throw new Error("El SLM devolvió una intención inválida");

    if (!Array.isArray(parsed.dimensions) || parsed.dimensions.some(
      (dimension) => !DIMENSIONS.includes(dimension as (typeof DIMENSIONS)[number])
    )) {
      throw new Error("El SLM devolvió dimensiones inválidas");
    }

    if (typeof parsed.clean_query !== "string") throw new Error("El SLM no devolvió clean_query");
    if (typeof parsed.embedding_input !== "string" || parsed.embedding_input.trim().length === 0) throw new Error("El SLM no devolvió embedding_input");
    
    if (
      typeof parsed.confidence !== "number" ||
      !Number.isFinite(parsed.confidence) ||
      parsed.confidence < 0 ||
      parsed.confidence > 1
    ) {
      throw new Error("El SLM devolvió una confianza inválida");
    }

    if (parsed.route === "RAG" && parsed.clean_query.trim().length === 0) throw new Error("El SLM devolvió una clean_query vacía para RAG");
    
    if (
      parsed.route === "LLM_DIRECT" &&
      (parsed.clean_query.length > 0 || parsed.dimensions.length > 0)
    ) {
      throw new Error("El SLM devolvió contexto de retrieval para LLM_DIRECT");
    }

    return {
      route: parsed.route as ClassificationResult["route"],
      clean_query: parsed.clean_query,
      embedding_input: parsed.embedding_input,
      dimensions: parsed.dimensions as ClassificationResult["dimensions"],
      intent: parsed.intent as IntentTag,
      confidence: parsed.confidence,
    };
    
  }
}
