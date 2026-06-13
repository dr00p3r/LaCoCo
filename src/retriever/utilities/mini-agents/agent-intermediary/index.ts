import { type SanitizerOutput, type IntentTag } from "../../../models/utilities/types.js";
import { SlmClassifier } from "./classifier.js";
import { logClassification } from "./logger.js";

const STOP_WORDS = new Set([
  "el","la","los","las","un","una","unos","unas",
  "de","en","para","por","con","sin","sobre","tras",
  "ante","bajo","hasta","desde","entre","mediante",
  "y","e","o","a","que","ni","pero","aunque","sino",
  "lo","se","le","me","te","nos","os","sus",
  "este","esta","estos","estas","ese","esa","esos","esas",
  "explica","dime","dame","haz","hace","hacer","di",
  "datos","dato","flujo","clase","tipo","forma","parte","linea",
  "valor","lista","orden","nuevo","primer","segundo","siguiente",
  "anterior","actual","simple","comun","normal","basico","medio",
  "rapido","lento","nuevo","antiguo","simple","unico","publico",
  "privado","libre","ocupado","activo","local","global","interno",
  "externo","propio","general","especifico","logico","fisico",
  "importante","necesario","posible","seguro","cierto","falso",
  "verdadero","correcto","exacto","vacio","lleno","completo",
  "distinto","diferente","igual","parecido","similar","contrario",
  "positivo","negativo","claro","oscuro","suave","duro",
  "nombre","palabra","texto","numero","entero","decimal",
  "funcion","ejemplo","codigo","archivo","salida","entrada",
  "parametro","metodo","objeto","proceso","sistema","estructura",
  "programa","proyecto","problema","solucion","resultado","producto",
  "motivo","razon","causa","efecto","proposito","objetivo","meta",
  "manera","modo","medio","forma","paso","etapa","fase",
  "trabajo","tarea","accion","evento","caso","ejemplo","prueba",
  "detalle","resumen","total","parcial","final","inicial",
  "nuestro","propio","ajeno","personal","publico","privado",
  "crear","crea","anade","agrega","incluye","define","muestra",
  "qué","cómo","cuándo","dónde","cuál","cuales","quien","quienes",
  "más","menos","muy","mucho","bien","mal","tan","como",
  "que","como","donde","cuando","cual","mas",
  "todo","nada","algo","cada","si","no",
  "del","al","porque","sino","sea","era",
  "the","a","an","and","or","in","on","at","to",
  "for","of","with","by","is","are","was","were",
  "be","been","has","have","had","do","does","did",
  "will","would","can","could","should","may","might",
  "this","that","these","those","it","its",
  "you","your","we","our","they","them","their",
  "what","when","where","how","why","which","who","whom",
  "tell","show","give","find","need","want","use",
  "about","into","than","then","also","just","not",
]);

const CONFIDENCE_THRESHOLD = 0.65;

export class AgentIntermediary1 {
  private readonly classifier: SlmClassifier;

  constructor() {
    this.classifier = new SlmClassifier();
  }

  async sanitize(prompt: string): Promise<SanitizerOutput> {
    
    const trimmed = prompt.trim();
    const keywords = this.#extractKeywords(trimmed);
    const cleanQuery = this.#toFts5Query(keywords);
    const embeddingInput = keywords.join(" ") || trimmed;

    if (keywords.length === 0) {
      return {
        route: "LLM_DIRECT",
        clean_query: trimmed.toLowerCase(),
        embedding_input: trimmed,
        dimensions: [],
        intent: "unknown" as IntentTag,
        confidence: 1.0,
      };
    }

    // Clasificación vía SLM
    let route: "RAG" | "LLM_DIRECT" = "RAG";
    let intent: IntentTag = "unknown";
    let dimensions: ("SYS" | "CPG" | "DTG")[] = ["CPG"];
    let confidence = 0.3;

    try {
      const result = await this.classifier.classify(trimmed);
      route = result.route;
      intent = result.intent;
      dimensions = result.dimensions.length > 0 ? result.dimensions : ["CPG"];
      confidence = result.confidence;
    } catch (err) {
      console.warn(
        "[AgentIntermediary1] ⚠️  SLM falló, usando fallback conservador:",
        err instanceof Error ? err.message : err
      );
    }

    // Fallback conservador: si confianza baja, preferir RAG
    if (confidence < CONFIDENCE_THRESHOLD && route === "LLM_DIRECT") {
      route = "RAG";
      confidence = Math.max(confidence, 0.3);
    }

    const output: SanitizerOutput = {
      route,
      clean_query: cleanQuery,
      embedding_input: embeddingInput,
      dimensions,
      intent,
      confidence,
    };

    logClassification(trimmed, output);

    return output;
  }

  #extractKeywords(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9áéíóúüñ\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 2 || /^[a-z]{2}$/.test(token))
      .filter((token) => !STOP_WORDS.has(token));
  }

  #toFts5Query(keywords: string[]): string {
    if (keywords.length === 0) return "";
    return keywords.join(" OR ");
  }
}
