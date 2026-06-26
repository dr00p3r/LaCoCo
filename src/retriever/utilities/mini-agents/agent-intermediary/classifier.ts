import type { LlmClient } from "../../../../slms/llm-client.js";
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
   - LLM_DIRECT solo para conversación o conocimiento genérico que no necesita el proyecto.
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

Prompt: qué es TypeScript
Salida: {"route":"LLM_DIRECT","clean_query":"","embedding_input":"Explicar qué es TypeScript","dimensions":[],"intent":"understand","confidence":0.99}`;

export class SlmClassifier {

  constructor(private readonly ollama: LlmClient) {}

  async classify(prompt: string): Promise<ClassificationResult> {

    const messages = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Prompt: ${JSON.stringify(prompt)}\nSalida:` },
    ] as const;

    const response = await this.ollama.chat([...messages], { format: "json" });

    try {

      return this.#parseResponse(response);

    } catch (firstError) {

      const repairedResponse = await this.ollama.chat(
        [
          { role: "system", content: SYSTEM_PROMPT },
          {
            role: "user",
            content:
              `Prompt original: ${JSON.stringify(prompt)}\n` +
              "Tu respuesta anterior no fue JSON válido o incumplió el contrato. " +
              "Genera nuevamente el objeto completo.\n" +
              `Respuesta inválida: ${JSON.stringify(response)}\nSalida:`,
          },
        ],
        { format: "json" }
      );

      try {

        return this.#parseResponse(repairedResponse);

      } catch (secondError) {
        
        throw new Error(
          "El SLM no produjo una salida JSON válida después de dos intentos",
          { cause: secondError instanceof Error ? secondError : firstError }
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
