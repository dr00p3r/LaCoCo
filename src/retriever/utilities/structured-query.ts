/**
 * Validación de una clasificación estructurada provista externamente (por el LLM
 * de un agente en modo tool, o por un payload determinista del arnés eval) hacia
 * un `SanitizerOutput` congelado. Cuando se acepta una clasificación válida, el
 * pipeline SALTA el clasificador SLM — el mismo régimen que ya se mide en
 * `eval/scripts/deterministic-retrieve.ts`.
 */

import { DIMENSIONS, type Dimension } from "../../domain/dimensions.js";
import type { IntentTag, SanitizerOutput } from "../models/utilities/types.js";

export const INTENT_TAGS = [
  "understand",
  "refactor",
  "create",
  "debug",
  "integrate",
  "unknown",
] as const satisfies readonly IntentTag[];

const INTENTS = new Set<string>(INTENT_TAGS);
const DIMENSION_SET = new Set<string>(DIMENSIONS);

/** Campos que un agente/arnés puede aportar para saltarse el clasificador SLM. */
export interface StructuredQueryInput {
  clean_query?: unknown;
  embedding_input?: unknown;
  intent?: unknown;
  dimensions?: unknown;
  confidence?: unknown;
}

/**
 * Construye un `SanitizerOutput` congelado (route RAG) desde una clasificación
 * del agente. Semántica de tres vías:
 *  - Ningún/parcial campo de clasificación → `null` (el llamador cae al SLM).
 *  - Los 4 campos presentes y válidos → `SanitizerOutput` (sin SLM).
 *  - Algún campo presente pero con valor inválido → lanza error claro.
 */
export function buildFrozenSanitizer(input: StructuredQueryInput): SanitizerOutput | null {
  const provided =
    input.clean_query !== undefined ||
    input.embedding_input !== undefined ||
    input.intent !== undefined ||
    input.dimensions !== undefined;
  if (!provided) return null;

  const complete =
    input.clean_query !== undefined &&
    input.embedding_input !== undefined &&
    input.intent !== undefined &&
    input.dimensions !== undefined;
  // Clasificación parcial: no es un error del agente, simplemente delega al SLM.
  if (!complete) return null;

  return assertRagSanitizer({
    route: "RAG",
    clean_query: input.clean_query,
    embedding_input: input.embedding_input,
    intent: input.intent,
    dimensions: input.dimensions,
    confidence: input.confidence ?? 0.9,
  });
}

/**
 * Valida un objeto crudo como `SanitizerOutput` de route RAG, lanzando mensajes
 * accionables. Lo reusa el arnés determinista y el modo tool (MCP).
 */
export function assertRagSanitizer(record: Record<string, unknown>): SanitizerOutput {
  if (record.route !== "RAG") {
    throw new Error("la clasificación estructurada debe tener route 'RAG'");
  }
  if (typeof record.clean_query !== "string" || record.clean_query.trim().length === 0) {
    throw new Error("clean_query debe ser un string no vacío (query FTS5)");
  }
  if (typeof record.embedding_input !== "string" || record.embedding_input.trim().length === 0) {
    throw new Error("embedding_input debe ser un string no vacío");
  }
  if (typeof record.intent !== "string" || !INTENTS.has(record.intent)) {
    throw new Error(`intent inválido: ${String(record.intent)} (usa ${INTENT_TAGS.join(", ")})`);
  }
  if (
    !Array.isArray(record.dimensions) ||
    record.dimensions.length === 0 ||
    record.dimensions.some((d) => typeof d !== "string" || !DIMENSION_SET.has(d))
  ) {
    throw new Error(`dimensions debe contener solo ${DIMENSIONS.join(", ")}`);
  }
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence)) {
    throw new Error("confidence debe ser un número finito");
  }

  return {
    route: "RAG",
    clean_query: record.clean_query,
    embedding_input: record.embedding_input,
    intent: record.intent as IntentTag,
    dimensions: record.dimensions as Dimension[],
    confidence: record.confidence,
  };
}
