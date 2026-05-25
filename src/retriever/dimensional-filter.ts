/**
 * DimensionalFilter — Clasifica el prompt en SYS/CPG/DTG mediante pipeline de 3 niveles
 *
 * Pipeline:
 *   1. Heurísticas rápidas O(1) (keywords hardcoded)
 *   2. Clasificador liviano (embeddings + regresión logística, modelo JSON local)
 *   3. SLM Fallback (Ollama: Qwen2.5-Coder:1.5B) si confianza < umbral
 *
 * Salida: array de dimensiones ordenadas por probabilidad descendente.
 */

import { type SanitizerOutput } from "./strategies/base.js";
import { OllamaService } from "../slms/ollama-service.js";

/** Keywords hardcoded para clasificación O(1) */
const DIMENSION_KEYWORDS = {
  // SYS
  hereda: ["SYS"], extends: ["SYS"], implementa: ["SYS"], implements: ["SYS"],
  interfaz: ["SYS"], interface: ["SYS"], "clase base": ["SYS"], superclass: ["SYS"],
  importa: ["SYS"], imports: ["SYS"], librería: ["SYS"], library: ["SYS"],

  // CPG
  inyecta: ["CPG"], injects: ["CPG"], constructor: ["CPG"],
  llama: ["CPG"], calls: ["CPG"], invoca: ["CPG"],
  instancia: ["CPG"], instantiates: ["CPG"], crea: ["CPG"], "new ": ["CPG"],
  método: ["CPG"], method: ["CPG"], función: ["CPG"], function: ["CPG"],

  // DTG
  dto: ["DTG"], data: ["DTG"], payload: ["DTG"], parámetro: ["DTG"], parameter: ["DTG"],
  retorna: ["DTG"], returns: ["DTG"], output: ["DTG"], resultado: ["DTG"],
  muta: ["DTG"], mutates: ["DTG"], estado: ["DTG"], state: ["DTG"],
  propiedad: ["DTG"], property: ["DTG"], campo: ["DTG"], field: ["DTG"],
} as const satisfies Record<string, readonly ("SYS" | "CPG" | "DTG")[]>;

export class DimensionalFilter {
  private readonly confidenceThreshold: number;
  private readonly ollama: OllamaService | null;

  /**
   * @param confidenceThreshold Umbral mínimo de confianza para aceptar
   *        el resultado de los niveles 1/2 sin recurrir al SLM (0.0–1.0)
   * @param ollama Cliente Ollama opcional para fallback SLM
   */
  constructor(confidenceThreshold = 0.65, ollama?: OllamaService) {
    this.confidenceThreshold = confidenceThreshold;
    this.ollama = ollama ?? null;
  }

  /**
   * Clasifica la consulta en una o más dimensiones del grafo multirrelacional.
   *
   * Pipeline:
   *   1. Heurísticas O(1) — si confidence >= umbral, retorna.
   *   2. Clasificador liviano — placeholder (aún no implementado).
   *   3. SLM Fallback — consulta a Ollama local si está disponible.
   *
   * @param query Salida del Agente Intermediario 1
   * @returns Lista de dimensiones ordenadas por relevancia
   */
  async filter(query: SanitizerOutput): Promise<("SYS" | "CPG" | "DTG")[]> {
    // ── Nivel 1: Heurísticas rápidas O(1) ──────────────────────────
    const heuristicResult = this.#heuristicFilter(query.clean_query);
    if (heuristicResult.confidence >= this.confidenceThreshold) {
      return heuristicResult.dimensions;
    }

    // ── Nivel 2: Clasificador liviano (placeholder para versión futura) ─
    const lightweightConfidence = heuristicResult.confidence * 0.85;
    if (lightweightConfidence >= this.confidenceThreshold) {
      return heuristicResult.dimensions;
    }

    // ── Nivel 3: SLM Fallback (Ollama) ─────────────────────────────
    if (this.ollama && await this.ollama.isAvailable()) {
      try {
        const response = await this.ollama.generate(
          `Clasifica la siguiente consulta de código en una o más de estas dimensiones: SYS (ecosistema/herencia), CPG (estructura/llamadas), DTG (flujo de datos).\n\nConsulta: "${query.embedding_input}"\n\nResponde SOLO con las dimensiones separadas por comas, nada más. Ejemplo: SYS, CPG`,
          "Eres un clasificador dimensional de consultas de código. Responde únicamente con las dimensiones."
        );
        const dims = this.#parseDimensions(response);
        if (dims.length > 0) return dims;
      } catch (err) {
        console.warn("[DimensionalFilter] ⚠️  Ollama no respondió, usando fallback conservador:", err instanceof Error ? err.message : err);
      }
    }

    // Fallback conservador
    return query.dimensions.length > 0 ? query.dimensions : ["CPG"];
  }

  #parseDimensions(text: string): ("SYS" | "CPG" | "DTG")[] {
    const dims: ("SYS" | "CPG" | "DTG")[] = [];
    const upper = text.toUpperCase();
    if (upper.includes("SYS")) dims.push("SYS");
    if (upper.includes("CPG")) dims.push("CPG");
    if (upper.includes("DTG")) dims.push("DTG");
    return dims;
  }

  // ── Nivel 1: Heurísticas ─────────────────────────────────────────

  #heuristicFilter(cleanQuery: string): {
    dimensions: ("SYS" | "CPG" | "DTG")[];
    confidence: number;
  } {
    const scores: Record<"SYS" | "CPG" | "DTG", number> = { SYS: 0, CPG: 0, DTG: 0 };
    const lower = cleanQuery.toLowerCase();

    for (const [keyword, dims] of Object.entries(DIMENSION_KEYWORDS)) {
      if (lower.includes(keyword.toLowerCase())) {
        for (const d of dims) {
          scores[d] += 1;
        }
      }
    }

    const total = scores.SYS + scores.CPG + scores.DTG;
    if (total === 0) {
      return { dimensions: ["CPG"], confidence: 0.3 };
    }

    // Ordenar dimensiones por score descendente
    const sorted = (Object.entries(scores) as ["SYS" | "CPG" | "DTG", number][])
      .filter(([, s]) => s > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([d]) => d);

    // Confidence: proporción del score mayor respecto al total
    const values = [scores.SYS, scores.CPG, scores.DTG];
    const maxScore = Math.max(...values);
    const confidence = Math.min(maxScore / total + 0.3, 0.9);

    return { dimensions: sorted, confidence };
  }
}
