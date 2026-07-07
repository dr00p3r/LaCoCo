import type { ChatOptions, LlmClient } from "../slms/llm-client.js";
import { SEMANTIC_DOMAINS, type DeterministicTerm, type EnrichedTerm, type SemanticAlias, type SemanticDomainScore } from "./types.js";

export const SEMANTIC_ENRICHMENT_PROMPT_VERSION = 1;
// Cada término enriquecido ocupa ~100-180 tokens (hasta 8 alias + dominios +
// descripción de 240 chars). El contrato exige devolver el lote completo en una
// sola respuesta, acotada por num_predict. Si la respuesta se trunca, el JSON
// queda sin cerrar y falla el parseo. En qwen2.5-coder:1.5b un lote de 10 aún
// rebasa 4096 tokens; con lote de 5 y presupuesto de 8192 hay holgura de sobra y
// la verificación estricta de longitud se mantiene fiable.
const BATCH_SIZE = 5;
const MAX_ALIASES = 8;
const ENRICHMENT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    terms: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          aliases: {
            type: "array",
            maxItems: MAX_ALIASES,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                value: { type: "string", minLength: 1 },
                language: { type: "string", enum: ["es", "en", "unknown"] },
                confidence: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["value", "language", "confidence"],
            },
          },
          domains: {
            type: "array",
            minItems: 1,
            maxItems: 3,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: "string", enum: [...SEMANTIC_DOMAINS] },
                score: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["name", "score"],
            },
          },
          description: { type: "string", minLength: 1, maxLength: 240 },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["id", "aliases", "domains", "description", "confidence"],
      },
    },
  },
  required: ["terms"],
};
const OPTIONS: ChatOptions = {
  format: ENRICHMENT_SCHEMA,
  options: { temperature: 0, seed: 42, num_predict: 8192 },
  // Sin razonamiento: un modelo con `thinking` (p. ej. gemma4) consume
  // `num_predict` en su bloque de pensamiento y devuelve `content` vacío ("El
  // enriquecedor no devolvió JSON"). El enriquecimiento es una tarea de formato,
  // no de deliberación → desactivarlo preserva el presupuesto para el JSON.
  think: false,
};
const SYSTEM_PROMPT = `Eres el enriquecedor semántico de LaCoCo.
Recibirás evidencias determinísticas de un proyecto TypeScript/Node.js.
No inventes, elimines ni cambies IDs o términos canónicos.
Genera hasta ocho alias concretos para recuperación. Incluye alias útiles en español e inglés cuando la traducción sea fiable; evita palabras genéricas aisladas.
Asigna entre uno y tres dominios canónicos con score. Los dominios son: ${SEMANTIC_DOMAINS.join(", ")}.
Los alias son vocabulario de búsqueda, no símbolos que existan en el código.
Devuelve únicamente JSON válido conforme al esquema.`;

export class SemanticTermEnricher {
  constructor(private readonly llm: LlmClient) {}

  async enrich(terms: readonly DeterministicTerm[]): Promise<EnrichedTerm[]> {
    const enriched: EnrichedTerm[] = [];
    for (let offset = 0; offset < terms.length; offset += BATCH_SIZE) {
      enriched.push(...await this.#enrichBatch(terms.slice(offset, offset + BATCH_SIZE)));
    }
    return enriched;
  }

  async #enrichBatch(terms: readonly DeterministicTerm[]): Promise<EnrichedTerm[]> {
    // Primera pasada sobre el lote completo. Se recoge por id lo que el SLM haya
    // enriquecido de forma válida, ignorando ids inventados o duplicados.
    const byId = new Map<string, EnrichedTerm>();
    this.#collectInto(byId, await this.#requestEnrichment(terms), terms);

    // Con temperature 0 y seed fijo, reintentar el MISMO lote da la misma salida.
    // Por eso la reparación pide SOLO los términos que faltan: una entrada más
    // pequeña y distinta produce una decodificación fresca con mayor probabilidad
    // de cumplir el contrato de completitud.
    const missing = terms.filter((term) => !byId.has(term.id));
    if (missing.length > 0) {
      this.#collectInto(byId, await this.#requestEnrichment(missing), missing);
    }

    // Cualquier término que el SLM siga omitiendo recibe un enriquecimiento
    // mínimo (sin alias/dominios) en lugar de abortar el perfil entero: el término
    // sigue disponible para grounding por su forma canónica.
    return terms.map((term) => byId.get(term.id) ?? minimalEnrichment(term));
  }

  async #requestEnrichment(terms: readonly DeterministicTerm[]): Promise<string> {
    const input = terms.map((term) => ({
      id: term.id,
      canonical_term: term.canonicalTerm,
      kind: term.kind,
      path: term.path,
      dimensions: term.dimensions,
      evidence: term.evidence,
    }));
    return this.llm.chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Entrada:\n${JSON.stringify(input)}\nSalida:` },
    ], OPTIONS);
  }

  /** Vuelca en `target` los términos válidos de una respuesta; los ids ajenos o
   * repetidos se ignoran (nunca lanza: la completitud la garantiza el fallback). */
  #collectInto(
    target: Map<string, EnrichedTerm>,
    text: string,
    source: readonly DeterministicTerm[],
  ): void {
    const sourceById = new Map(source.map((term) => [term.id, term]));
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return;
    }
    const rawTerms = (parsed as Record<string, unknown>)?.terms;
    if (!Array.isArray(rawTerms)) return;
    for (const value of rawTerms) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      const origin = typeof record.id === "string" ? sourceById.get(record.id) : undefined;
      if (!origin || target.has(origin.id)) continue;
      target.set(origin.id, {
        ...origin,
        aliases: parseAliases(record.aliases),
        domains: parseDomains(record.domains),
        description: coerceDescription(record.description, origin.canonicalTerm),
        confidence: coerceConfidence(record.confidence, 0.5),
      });
    }
  }
}

function minimalEnrichment(term: DeterministicTerm): EnrichedTerm {
  return { ...term, aliases: [], domains: [], description: term.canonicalTerm, confidence: 0 };
}

// Los alias son vocabulario de búsqueda: cualquier entrada mal formada (valor
// vacío, idioma o confianza inválidos, clave extra) se descarta sin abortar. Se
// deduplica por valor normalizado y se recorta a MAX_ALIASES.
function parseAliases(value: unknown): SemanticAlias[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const aliases: SemanticAlias[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.value !== "string" || record.value.trim().length === 0) continue;
    if (record.language !== "es" && record.language !== "en" && record.language !== "unknown") continue;
    const confidence = tryConfidence(record.confidence);
    if (confidence === null) continue;
    const normalized = record.value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push({ value: record.value.trim(), language: record.language, confidence });
    if (aliases.length >= MAX_ALIASES) break;
  }
  return aliases;
}

// Dominios no canónicos, con score inválido o duplicados se descartan; se recorta
// a tres. Un término sin dominios válidos queda sin dominios (aceptable): el
// grounding sigue funcionando por término canónico y aliases.
function parseDomains(value: unknown): SemanticDomainScore[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const domains: SemanticDomainScore[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    if (typeof record.name !== "string" || !SEMANTIC_DOMAINS.includes(record.name as (typeof SEMANTIC_DOMAINS)[number])) continue;
    const score = tryConfidence(record.score);
    if (score === null) continue;
    if (seen.has(record.name)) continue;
    seen.add(record.name);
    domains.push({ name: record.name as SemanticDomainScore["name"], score });
    if (domains.length >= 3) break;
  }
  return domains;
}

/** Confianza válida en [0,1] o `null` si el SLM la emitió mal formada. */
function tryConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** Confianza válida o el `fallback` neutro cuando el SLM la emite mal formada. */
function coerceConfidence(value: unknown, fallback: number): number {
  return tryConfidence(value) ?? fallback;
}

/** Descripción recortada a 240 chars; usa `fallback` (término canónico) si viene vacía. */
function coerceDescription(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  const base = text.length > 0 ? text : fallback;
  return base.length > 240 ? base.slice(0, 240) : base;
}
