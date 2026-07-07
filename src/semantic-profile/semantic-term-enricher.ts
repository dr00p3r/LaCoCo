import type { ChatMessage, ChatOptions, LlmClient } from "../slms/llm-client.js";
import { SEMANTIC_DOMAINS, type DeterministicTerm, type EnrichedTerm, type SemanticAlias, type SemanticDomainScore } from "./types.js";

export const SEMANTIC_ENRICHMENT_PROMPT_VERSION = 1;
const BATCH_SIZE = 50;
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
  options: { temperature: 0, seed: 42, num_predict: 4096 },
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
    const input = terms.map((term) => ({
      id: term.id,
      canonical_term: term.canonicalTerm,
      kind: term.kind,
      path: term.path,
      dimensions: term.dimensions,
      evidence: term.evidence,
    }));
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Entrada:\n${JSON.stringify(input)}\nSalida:` },
    ];
    const first = await this.llm.chat(messages, OPTIONS);
    try {
      return this.#parse(first, terms);
    } catch (error) {
      const repaired = await this.llm.chat([
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `La respuesta anterior incumplió el contrato: ${formatError(error)}\n` +
            `Entrada original:\n${JSON.stringify(input)}\n` +
            `Respuesta inválida:\n${JSON.stringify(first)}\nDevuelve el lote completo corregido:`,
        },
      ], OPTIONS);
      return this.#parse(repaired, terms);
    }
  }

  #parse(text: string, source: readonly DeterministicTerm[]): EnrichedTerm[] {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) throw new Error("El enriquecedor no devolvió JSON");
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    assertExactKeys(parsed, ["terms"], "respuesta del enriquecedor");
    if (!Array.isArray(parsed.terms) || parsed.terms.length !== source.length) {
      throw new Error("El enriquecedor debe devolver exactamente todos los términos del lote");
    }
    const sourceById = new Map(source.map((term) => [term.id, term]));
    const seen = new Set<string>();
    return parsed.terms.map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("Término enriquecido inválido");
      }
      const record = value as Record<string, unknown>;
      assertExactKeys(record, ["id", "aliases", "domains", "description", "confidence"], "término enriquecido");
      if (typeof record.id !== "string" || !sourceById.has(record.id) || seen.has(record.id)) {
        throw new Error(`ID enriquecido inesperado o duplicado: ${String(record.id)}`);
      }
      seen.add(record.id);
      const aliases = parseAliases(record.aliases);
      const domains = parseDomains(record.domains);
      if (typeof record.description !== "string" || record.description.trim().length === 0 || record.description.length > 240) {
        throw new Error(`Descripción inválida para ${record.id}`);
      }
      const confidence = parseConfidence(record.confidence, `confidence de ${record.id}`);
      return {
        ...sourceById.get(record.id)!,
        aliases,
        domains,
        description: record.description.trim(),
        confidence,
      };
    });
  }
}

function parseAliases(value: unknown): SemanticAlias[] {
  if (!Array.isArray(value) || value.length > MAX_ALIASES) throw new Error("aliases inválidos");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("alias inválido");
    const record = entry as Record<string, unknown>;
    assertExactKeys(record, ["value", "language", "confidence"], "alias");
    if (typeof record.value !== "string" || record.value.trim().length === 0) throw new Error("alias vacío");
    if (record.language !== "es" && record.language !== "en" && record.language !== "unknown") {
      throw new Error("idioma de alias inválido");
    }
    const normalized = record.value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
    if (seen.has(normalized)) throw new Error(`alias duplicado: ${record.value}`);
    seen.add(normalized);
    return {
      value: record.value.trim(),
      language: record.language,
      confidence: parseConfidence(record.confidence, "confidence de alias"),
    };
  });
}

function parseDomains(value: unknown): SemanticDomainScore[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) throw new Error("domains inválidos");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("domain inválido");
    const record = entry as Record<string, unknown>;
    assertExactKeys(record, ["name", "score"], "domain");
    if (typeof record.name !== "string" || !SEMANTIC_DOMAINS.includes(record.name as (typeof SEMANTIC_DOMAINS)[number])) {
      throw new Error(`domain no canónico: ${String(record.name)}`);
    }
    if (seen.has(record.name)) throw new Error(`domain duplicado: ${record.name}`);
    seen.add(record.name);
    return {
      name: record.name as SemanticDomainScore["name"],
      score: parseConfidence(record.score, "score de domain"),
    };
  });
}

function parseConfidence(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} inválido`);
  }
  return value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertExactKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const expected = [...allowed].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`${label} contiene propiedades inválidas`);
  }
}
