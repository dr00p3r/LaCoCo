/**
 * AgentIntermediary1 — Clasificador + Sanitizador del prompt de entrada
 *
 * Responsabilidades:
 *   1. Decidir si el prompt necesita RAG (referencia al codebase) o va directo al LLM.
 *   2. Sanitizar la query: minúsculas, quitar puntuación irrelevante, normalizar espacios.
 *   3. Generar `embedding_input` (versión semántica, sin normalizar).
 *   4. Clasificar intent del usuario por heurísticas + similitud con ejemplos.
 *   5. Asignar `confidence` (0.0–1.0) basado en claridad de la intención.
 *
 * No requiere SLM: todo es determinístico o basado en embeddings simples.
 */

import {
  type SanitizerOutput,
  type IntentTag,
} from "./strategies/base.js";

/** Prompts que claramente NO necesitan RAG (genéricos, sin referencia al proyecto) */
const RAG_BLOCKLIST = new Set([
  "hola", "buenos días", "gracias", "adiós",
  "explica", "qué es", "cómo funciona", "tutorial",
]);

/** Heurísticas rápidas para detectar intención sin embeddings */
const INTENT_KEYWORDS: Record<IntentTag, string[]> = {
  understand: ["qué hace", "cómo funciona", "para qué sirve", "explica", "entender"],
  refactor: ["refactoriza", "renombra", "extrae", "simplifica", "optimiza", "mueve"],
  create: ["crea", "genera", "añade", "nuevo", "implementa", "escribe"],
  debug: ["falla", "error", "bug", "por qué no", "exception", "trace"],
  integrate: ["usa la librería", "integra", "conecta con", "llama a"],
  unknown: [],
};

export class AgentIntermediary1 {
  /**
   * Clasifica y sanitiza un prompt de usuario.
   *
   * @param prompt Texto crudo del usuario
   * @returns SanitizerOutput con route, query limpia, dimensiones sugeridas, intent y confianza
   */
  sanitize(prompt: string): SanitizerOutput {
    const trimmed = prompt.trim();

    // ── 1. Decidir route ─────────────────────────────────────────────
    const needsRag = this.#needsRag(trimmed);
    if (!needsRag) {
      return {
        route: "LLM_DIRECT",
        clean_query: trimmed.toLowerCase(),
        embedding_input: trimmed,
        dimensions: [],
        intent: "unknown",
        confidence: 1.0,
      };
    }

    // ── 2. Sanitizar query para BM25 ─────────────────────────────────
    const cleanQuery = this.#normalizeForBM25(trimmed);

    // ── 3. Generar embedding_input (semántico, sin normalizar) ──────
    const embeddingInput = trimmed;

    // ── 4. Detectar intent por heurísticas ───────────────────────────
    const { intent, confidence } = this.#detectIntent(trimmed);

    // ── 5. Sugerir dimensiones (básico, sin embeddings aún) ──────────
    const dimensions = this.#hintDimensions(trimmed);

    return {
      route: "RAG",
      clean_query: cleanQuery,
      embedding_input: embeddingInput,
      dimensions,
      intent,
      confidence,
    };
  }

  // ── Privados ───────────────────────────────────────────────────────

  /** Detecta si el prompt menciona código/símbolos del proyecto. */
  #needsRag(prompt: string): boolean {
    const lower = prompt.toLowerCase();

    // Si contiene palabras bloqueadas puras → directo
    const words = lower.split(/\s+/);
    if (words.every((w) => RAG_BLOCKLIST.has(w))) return false;

    // Si menciona símbolos de código (camelCase, PascalCase, rutas, extensiones, palabras clave)
    const hasCodeSymbols =
      /[A-Z][a-zA-Z0-9]*\.[a-zA-Z]+|\.ts|\.js|node_modules|class\s+|function\s+|interface\s+|funci[oó]n\s+|m[eé]todo\s+|clase\s+|[a-z][a-zA-Z0-9]*[A-Z]/.test(prompt);

    // Si pide refactor, crear, debug, entender sobre el proyecto
    const hasTaskKeywords =
      /refactor(iza|)|crea|implementa|debug|arregla|corrige|añade|falla|error|qu[eé] hace|c[oó]mo|para qu[eé]/.test(lower);

    return hasCodeSymbols || hasTaskKeywords;
  }

  /** Normaliza texto para BM25: minúsculas, quita puntuación irrelevante, espacios extra. */
  #normalizeForBM25(text: string): string {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9áéíóúüñ\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  /** Heurística rápida O(1) para clasificar intención del usuario. */
  #detectIntent(prompt: string): { intent: IntentTag; confidence: number } {
    const lower = prompt.toLowerCase();
    let bestIntent: IntentTag = "unknown";
    let bestScore = 0;

    for (const [tag, keywords] of Object.entries(INTENT_KEYWORDS) as [IntentTag, string[]][]) {
      if (tag === "unknown") continue;
      const hits = keywords.filter((kw) => lower.includes(kw)).length;
      if (hits > bestScore) {
        bestScore = hits;
        bestIntent = tag;
      }
    }

    // Confidence: más keywords coinciden → más confianza, max 1.0
    const confidence = Math.min(bestScore * 0.25 + 0.4, 0.95);
    return { intent: bestIntent, confidence };
  }

  /** Sugiere dimensiones basado en keywords rápidas (hint, no filtro final). */
  #hintDimensions(prompt: string): ("SYS" | "CPG" | "DTG")[] {
    const lower = prompt.toLowerCase();
    const dims: ("SYS" | "CPG" | "DTG")[] = [];

    if (/hereda|extends|implementa|interface|clase base|superclase/.test(lower)) dims.push("SYS");
    if (/inyecta|constructor|llama|instancia|crea|new\s+/.test(lower)) dims.push("CPG");
    if (/dto|retorna|muta|status|data|payload|parámetro|input|output/.test(lower)) dims.push("DTG");

    // Si ninguna keyword específica, asumimos CPG como default (estructura)
    if (dims.length === 0) dims.push("CPG");

    return dims;
  }
}
