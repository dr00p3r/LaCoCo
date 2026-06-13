import { OllamaService } from "../../../../slms/ollama-service.js";
import type { ClassificationResult } from "./types.js";

const SYSTEM_PROMPT = `Eres un clasificador de consultas de código para LaCoCo, un sistema RAG local que recupera contexto de repositorios TypeScript/Node.js.

Tu tarea es clasificar la consulta del usuario en los siguientes campos, respondiendo SOLO con JSON válido, sin texto adicional ni markdown.

### Campos del JSON de salida:

1. "route": "RAG" | "LLM_DIRECT"
   - "RAG": la consulta necesita recuperar código del repositorio actual. Incluye referencias a clases, funciones, métodos, variables, archivos, o cualquier símbolo del código (incluso escritos en minúsculas o español).
   - "LLM_DIRECT": la consulta es genérica, no depende del código del proyecto. Preguntas conceptuales sobre programación, saludos, agradecimientos.

2. "intent": "understand" | "refactor" | "create" | "debug" | "integrate" | "unknown"

3. "dimensions": ["SYS"] | ["CPG"] | ["DTG"] | combinaciones | []

4. "confidence": número entre 0.0 y 1.0

### Reglas importantes (léelas con atención):

1. **CUALQUIER mención a un posible símbolo de código es RAG**, incluso si está en minúsculas y sin PascalCase. Los usuarios escriben "hybrid strategy" para referirse a la clase HybridStrategy, "order service" para OrderService, "user repository" para UserRepository, etc. No asumas que es un concepto genérico.

2. **Si hay duda entre RAG y LLM_DIRECT, prefiere SIEMPRE RAG.** Un falso positivo (enviar algo genérico al RAG) solo añade contexto innecesario. Un falso negativo (no recuperar código cuando sí se necesita) produce alucinaciones.

3. **"qué hace X", "cómo funciona X", "explica X" con un nombre específico (aunque sea lowercase) es RAG.** Si X suena a clase, función, método, endpoint, servicio, repositorio, controlador, etc. → RAG.

4. **LLM_DIRECT solo cuando es EVIDENTE** que no hay referencia a código: preguntas conceptuales ("qué es async/await", "cómo funciona TypeScript"), saludos, agradecimientos.

### Ejemplos:

Consulta: "refactoriza OrderService para async/await"
Salida: {"route":"RAG","intent":"refactor","dimensions":["CPG"],"confidence":0.95}

Consulta: "qué hace UserRepository"
Salida: {"route":"RAG","intent":"understand","dimensions":["CPG","DTG"],"confidence":0.90}

Consulta: "qué hace "X" módulo"
Salida: {"route":"RAG","intent":"understand","dimensions":["CPG"],"confidence":0.85}

Consulta: "explica order service"
Salida: {"route":"RAG","intent":"understand","dimensions":["CPG"],"confidence":0.80}

Consulta: "cómo funciona el daemon"
Salida: {"route":"RAG","intent":"understand","dimensions":["CPG"],"confidence":0.85}

Consulta: "qué es TypeScript"
Salida: {"route":"LLM_DIRECT","intent":"understand","dimensions":[],"confidence":0.95}

Consulta: "gracias"
Salida: {"route":"LLM_DIRECT","intent":"unknown","dimensions":[],"confidence":1.0}

Consulta: "crea un endpoint POST /orders"
Salida: {"route":"RAG","intent":"create","dimensions":["DTG","CPG"],"confidence":0.90}`;

export class SlmClassifier {

  constructor(private readonly ollama : OllamaService = new OllamaService()) {}

  async classify(prompt : string) : Promise<ClassificationResult> {
    const response = await this.ollama.chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Consulta: "${prompt}"\n\nSalida:` },
    ]);

    return this.#parseResponse(response);
  }

  #parseResponse(text : string) : ClassificationResult {

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error("No se pudo extraer JSON de la respuesta del SLM");

    const parsed = JSON.parse(jsonMatch[0]);

    const route = parsed.route === "LLM_DIRECT" ? "LLM_DIRECT" : "RAG";

    const intent = ["understand", "refactor", "create", "debug", "integrate", "unknown"].includes(parsed.intent)
      ? parsed.intent
      : "unknown";

    const dimensions: ("SYS" | "CPG" | "DTG")[] = Array.isArray(parsed.dimensions)
      ? parsed.dimensions.filter((d: string) => ["SYS", "CPG", "DTG"].includes(d))
      : [];
      
    const confidence = typeof parsed.confidence === "number"
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.3;

    return { route, intent, dimensions, confidence };
  }
}
