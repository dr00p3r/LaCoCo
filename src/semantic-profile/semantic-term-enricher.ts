import type { ChatOptions, LlmClient } from "../slms/llm-client.js";
import { SEMANTIC_DOMAINS, type DeterministicTerm, type EnrichedTerm, type SemanticAlias, type SemanticDomainScore } from "./types.js";

export const SEMANTIC_ENRICHMENT_PROMPT_VERSION = 2;
// Cada término enriquecido ocupa ~80-160 tokens (hasta 4 alias + 2 dominios +
// descripción de ~180 chars). Lotes de 3 caben holgados en `num_ctx: 8192` sin
// `memory_seq_rm` por batch; `num_predict: 2048` cubre el peor caso observado
// (~1700 tokens en Qwen3-4B) con margen. Si se trunca, el JSON queda sin cerrar
// y falla el parseo; `coerceAliases/Domains/Description` aplican el cap duro y
// `minimalEnrichment` cubre los huecos sin abortar el perfil.
const BATCH_SIZE = 3;
export const MAX_ALIASES = 4;
export const MAX_DOMAINS = 2;
// Qwen3-4B produce descripciones de 130-180 chars naturalmente (en ES/EN). El
// cap de 120 fuerza a la SLM a truncar y rompe la validación estricta de Ollama
// (HTTP 500 "output does not match peg-native format"). 240 deja holgura para
// la salida natural del 4B; `coerceDescription` aplica el cap duro en cualquier
// caso para storage/prompt.
export const MAX_DESCRIPTION_LENGTH = 240;
// El schema refleja la salida natural del 4B (test empírico 2026-07-08):
// `aliases` como strings planos (no objetos con metadata) y `domains` con la
// clave `domain` (no `name`). El parser en este archivo se encarga de
// transformar al formato interno `SemanticAlias` y `SemanticDomainScore`.
// El strict `format: ENRICHMENT_SCHEMA` aún rechaza trailing commas o alias
// que excedan `maxItems: 4`; la retry logic en `#enrichBatch` cubre esos casos
// transitorios sin abortar el build.
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
            items: { type: "string" },
          },
          domains: {
            type: "array",
            minItems: 0,
            maxItems: MAX_DOMAINS,
            items: {
              type: "object",
              additionalProperties: false,
              properties: {
                domain: { type: "string", enum: [...SEMANTIC_DOMAINS] },
                score: { type: "number", minimum: 0, maximum: 1 },
              },
              required: ["domain", "score"],
            },
          },
          description: { type: "string", minLength: 1, maxLength: MAX_DESCRIPTION_LENGTH },
        },
        required: ["aliases", "domains", "description"],
      },
    },
  },
  required: ["terms"],
};
const OPTIONS: ChatOptions = {
  format: ENRICHMENT_SCHEMA,
  options: { temperature: 0, seed: 42, num_predict: 2048, num_ctx: 8192 },
  // Sin razonamiento: un modelo con `thinking` (p. ej. gemma4) consume
  // `num_predict` en su bloque de pensamiento y devuelve `content` vacío ("El
  // enriquecedor no devolvió JSON"). El enriquecimiento es una tarea de formato,
  // no de deliberación → desactivarlo preserva el presupuesto para el JSON.
  think: false,
  // El build encadena cientos/miles de llamadas. Sin `keep_alive` Ollama puede
  // descargar el modelo entre llamadas y pagar la recarga cada vez. "5m" cubre
  // los huecos sin fijarlo para siempre. Solo controla residencia, no el
  // sampling → no altera la salida ni la línea base del A/B.
  keep_alive: "5m",
};

// Los lotes se cortan en orden fijo y son independientes entre sí, y cada
// request lleva `temperature:0, seed:42`. Correr K lotes a la vez y reensamblar
// por índice de entrada produce la misma salida por-lote: solo cambia el orden de
// ejecución. Default 1 = comportamiento secuencial idéntico al previo.
const DEFAULT_ENRICH_CONCURRENCY = 1;
const SYSTEM_PROMPT = `Eres el enriquecedor semántico de LaCoCo.
Recibirás evidencias determinísticas de un proyecto TypeScript/Node.js.
No inventes, elimines ni cambies IDs o términos canónicos.

Devuelve JSON con esta estructura exacta:
{
  "terms": [
    {
      "id": "<id original de la entrada>",
      "aliases": ["alias1", "alias2", "alias3", "alias4"],
      "domains": [{"domain": "ui-components", "score": 0.9}],
      "description": "descripción corta en español o inglés (≤ 240 chars)"
    }
  ]
}

Reglas:
- "aliases" es un array de hasta ${MAX_ALIASES} strings (palabras o frases cortas de
  búsqueda, en español o inglés). Evita palabras genéricas aisladas.
- "domains" es un array de hasta ${MAX_DOMAINS} objetos con "domain" (uno de los dominios
  válidos) y "score" (número entre 0 y 1). Si no aplica, devuelve [].
- "description" resume el término en ≤ ${MAX_DESCRIPTION_LENGTH} caracteres.
- "id" debe ser exactamente el "id" que recibiste en la entrada.
- Devuelve solo el JSON, sin markdown, sin explicaciones.

Dominios válidos: ${SEMANTIC_DOMAINS.join(", ")}.`;

export class SemanticTermEnricher {
  readonly #concurrency: number;

  constructor(private readonly llm: LlmClient, concurrency: number = DEFAULT_ENRICH_CONCURRENCY) {
    this.#concurrency = Math.max(1, Math.floor(concurrency) || 1);
  }

  async enrich(terms: readonly DeterministicTerm[]): Promise<EnrichedTerm[]> {
    const batches: DeterministicTerm[][] = [];
    for (let offset = 0; offset < terms.length; offset += BATCH_SIZE) {
      batches.push(terms.slice(offset, offset + BATCH_SIZE));
    }

    // Pool acotado: K workers toman índices de lote de un contador compartido y
    // escriben en `results[index]`. El incremento `next++` es seguro porque el
    // event loop es single-thread y ocurre antes de cualquier `await`. Reensamblar
    // por índice preserva el orden de entrada → salida idéntica a la secuencial.
    const results = new Array<EnrichedTerm[]>(batches.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = next++;
        if (index >= batches.length) return;
        results[index] = await this.#enrichBatch(batches[index]!);
      }
    };
    const workerCount = Math.min(this.#concurrency, batches.length || 1);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    return results.flat();
  }

  async #enrichBatch(terms: readonly DeterministicTerm[]): Promise<EnrichedTerm[]> {
    // Primera pasada sobre el lote completo, con retry defensivo. La 4B con
    // `format: ENRICHMENT_SCHEMA` rechaza ocasionalmente (trailing commas,
    // descripciones > 240 chars, alias > MAX_ALIASES) con HTTP 500. Aunque
    // `temp: 0, seed: 42` es determinista, las causas son estocásticas entre
    // batches (carga de slots, estado de cache), así que reintentar suele
    // recuperar la respuesta. Si tras 3 intentos el batch sigue fallando,
    // degradamos a `minimalEnrichment` para todos los términos del batch en
    // lugar de abortar el perfil entero.
    const byId = new Map<string, EnrichedTerm>();
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        this.#collectInto(byId, await this.#requestEnrichment(terms), terms);
        break;
      } catch (error) {
        if (attempt === MAX_ATTEMPTS) {
          // Degradación controlada: no abortar el perfil. Los términos de este
          // batch quedan con `minimalEnrichment` (sin aliases/dominios pero con
          // canonical_term y description, así el grounder los puede usar como
          // candidatos por su forma canónica).
          return terms.map(minimalEnrichment);
        }
        // Backoff corto entre reintentos para que la SLM libere slots.
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }

    // Repair pass: si la SLM omitió algunos ids, pedir SOLO los faltantes (no
    // el lote entero). Una entrada más pequeña y distinta produce una
    // decodificación fresca con mayor probabilidad de cubrir los huecos.
    // Una sola pasada aquí: la repair ya es un reintento estructural, no
    // queremosretry sobre retry (riesgo de cuelgue con concurrencia > 1).
    const missing = terms.filter((term) => !byId.has(term.id));
    if (missing.length > 0) {
      try {
        this.#collectInto(byId, await this.#requestEnrichment(missing), missing);
      } catch {
        // Si el repair pass falla, los términos faltantes caen a
        // minimalEnrichment (línea 108). Toleramos sin reintento.
      }
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
   * repetidos se ignoran (nunca lanza: la completitud la garantiza el fallback).
   * Si el LLM omite el `id`, intenta matchear por índice posicional: la 4B
   * conserva el orden de los items de la entrada en el array `terms`. */
  #collectInto(
    target: Map<string, EnrichedTerm>,
    text: string,
    source: readonly DeterministicTerm[],
  ): void {
    const sourceById = new Map(source.map((term) => [term.id, term]));
    const sourceByIndex = new Map(source.map((term, i) => [i, term]));
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
    for (let i = 0; i < rawTerms.length; i++) {
      const value = rawTerms[i];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      // Match por id explícito. Si la SLM devuelve un id que no está en la
      // entrada → ignora (la SLM está mintiendo sobre qué término enriquece,
      // no es un caso de "id faltante" para matchear por índice). El fallback
      // posicional solo aplica cuando el id está ausente del output (4B a
      // veces omite el id en lugar de inventarlo).
      let origin: DeterministicTerm | undefined;
      if (typeof record.id === "string") {
        origin = sourceById.get(record.id);
        if (!origin) continue;
      } else {
        origin = sourceByIndex.get(i);
        if (!origin) continue;
      }
      if (target.has(origin.id)) continue;
      target.set(origin.id, {
        ...origin,
        aliases: parseAliases(record.aliases),
        domains: parseDomains(record.domains),
        description: coerceDescription(record.description, origin.canonicalTerm),
        // `confidence` ya no es parte del schema del LLM (Fase 0). Se preserva el
        // campo en EnrichedTerm y en la DB para compat con `semantic-profile-store`,
        // pero su valor es siempre el fallback — el grounder no lo usa.
        confidence: 0.5,
      });
    }
  }
}

function minimalEnrichment(term: DeterministicTerm): EnrichedTerm {
  return { ...term, aliases: [], domains: [], description: term.canonicalTerm, confidence: 0 };
}

// Aliases son vocabulario de búsqueda. El 4B produce strings planos
// (`["alias1", "alias2"]`); también aceptamos el formato verboso
// (`{value, language, confidence}[]`) por compat con otras SLMs. Cualquier
// entrada mal formada se descarta sin abortar el lote. Se deduplica por valor
// normalizado y se recorta a MAX_ALIASES.
function parseAliases(value: unknown): SemanticAlias[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const aliases: SemanticAlias[] = [];
  for (const entry of value) {
    let str: string;
    let language: "es" | "en" | "unknown" = "unknown";
    let confidence = 0.5;
    if (typeof entry === "string") {
      str = entry.trim();
      if (str.length === 0) continue;
    } else if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      // Formato verboso: {value, language, confidence}
      const record = entry as Record<string, unknown>;
      if (typeof record.value !== "string" || record.value.trim().length === 0) continue;
      if (record.language !== "es" && record.language !== "en" && record.language !== "unknown") continue;
      const conf = tryConfidence(record.confidence);
      if (conf === null) continue;
      str = record.value.trim();
      language = record.language;
      confidence = conf;
    } else {
      continue;
    }
    const normalized = str.normalize("NFKC").toLocaleLowerCase("en-US").trim();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    aliases.push({ value: str, language, confidence });
    if (aliases.length >= MAX_ALIASES) break;
  }
  return aliases;
}

// Dominios no canónicos, con score inválido o duplicados se descartan; se
// recorta a MAX_DOMAINS. El 4B usa la clave `domain`; también aceptamos `name`
// por compat. Un término sin dominios válidos queda sin dominios (aceptable):
// el grounding sigue funcionando por término canónico y aliases.
function parseDomains(value: unknown): SemanticDomainScore[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const domains: SemanticDomainScore[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    // Aceptar `domain` (formato 4B) o `name` (formato verboso).
    const name = (record.domain ?? record.name) as unknown;
    if (typeof name !== "string" || !SEMANTIC_DOMAINS.includes(name as (typeof SEMANTIC_DOMAINS)[number])) continue;
    const score = tryConfidence(record.score);
    if (score === null) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    domains.push({ name: name as SemanticDomainScore["name"], score });
    if (domains.length >= MAX_DOMAINS) break;
  }
  return domains;
}

/** Confianza válida en [0,1] o `null` si el SLM la emitió mal formada. */
function tryConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** Descripción recortada a MAX_DESCRIPTION_LENGTH; usa `fallback` (término canónico) si viene vacía. */
function coerceDescription(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value.trim() : "";
  const base = text.length > 0 ? text : fallback;
  return base.length > MAX_DESCRIPTION_LENGTH ? base.slice(0, MAX_DESCRIPTION_LENGTH) : base;
}
