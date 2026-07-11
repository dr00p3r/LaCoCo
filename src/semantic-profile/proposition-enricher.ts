import type { ChatOptions, LlmClient } from "../slms/llm-client.js";

/**
 * Enricher doc-side de C2. Dado un nodo de código (name + signature), un SLM
 * emite 1..MAX proposiciones de capacidad en **lenguaje de issue** ("persiste
 * una orden en el repositorio"), NO identificadores de código. Esas frases se
 * embeben como filas extra (ver `LaCoCoPropositionsDb`) para que una query en
 * lenguaje de issue matchee la proposición en vez del código.
 *
 * Determinista (`temperature:0, seed:42`) y **ciego al issue y al gold** — solo
 * ve el nodo → no puede memorizar el test set. Espeja la estructura de
 * `SemanticTermEnricher` (lotes, retry, fallback controlado sin abortar).
 */

export const PROPOSITION_PROMPT_VERSION = 1;
export const MAX_PROPOSITIONS = 3;
export const MAX_PROPOSITION_LENGTH = 200;
const BATCH_SIZE = 3;
const DEFAULT_ENRICH_CONCURRENCY = 1;

export interface PropositionInput {
  /** Id del nodo de código real (será el `real_node_id` de la fila). */
  id: string;
  name: string;
  signature: string;
}

export interface NodePropositions {
  id: string;
  propositions: string[];
}

const PROPOSITION_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    nodes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          propositions: {
            type: "array",
            minItems: 1,
            maxItems: MAX_PROPOSITIONS,
            items: { type: "string", minLength: 1, maxLength: MAX_PROPOSITION_LENGTH },
          },
        },
        required: ["propositions"],
      },
    },
  },
  required: ["nodes"],
};

const OPTIONS: ChatOptions = {
  format: PROPOSITION_SCHEMA,
  options: { temperature: 0, seed: 42, num_predict: 2048, num_ctx: 8192 },
  think: false,
  keep_alive: "5m",
};

const SYSTEM_PROMPT = `Eres el generador de proposiciones de capacidad de LaCoCo.
Recibirás nodos de código TypeScript/JavaScript (nombre + firma).
Por cada nodo, describe QUÉ HACE en lenguaje natural, como lo escribiría alguien
reportando un bug o pidiendo un cambio — NO uses identificadores del código.

Devuelve JSON con esta estructura exacta:
{
  "nodes": [
    { "id": "<id original de la entrada>", "propositions": ["frase 1", "frase 2"] }
  ]
}

Reglas:
- "propositions" es un array de 1 a ${MAX_PROPOSITIONS} frases cortas (≤ ${MAX_PROPOSITION_LENGTH} chars),
  en español o inglés, en lenguaje de dominio/negocio, no de código.
- Describe la capacidad o efecto observable (qué valida, qué persiste, qué renderiza,
  qué transforma), no la sintaxis. Evita repetir el nombre del símbolo tal cual.
- "id" debe ser exactamente el "id" que recibiste en la entrada.
- Devuelve solo el JSON, sin markdown, sin explicaciones.`;

export class PropositionEnricher {
  readonly #concurrency: number;

  constructor(private readonly llm: LlmClient, concurrency: number = DEFAULT_ENRICH_CONCURRENCY) {
    this.#concurrency = Math.max(1, Math.floor(concurrency) || 1);
  }

  async enrich(nodes: readonly PropositionInput[]): Promise<NodePropositions[]> {
    const batches: PropositionInput[][] = [];
    for (let offset = 0; offset < nodes.length; offset += BATCH_SIZE) {
      batches.push(nodes.slice(offset, offset + BATCH_SIZE));
    }

    const results = new Array<NodePropositions[]>(batches.length);
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

  async #enrichBatch(nodes: readonly PropositionInput[]): Promise<NodePropositions[]> {
    const byId = new Map<string, NodePropositions>();
    const MAX_ATTEMPTS = 3;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        this.#collectInto(byId, await this.#request(nodes), nodes);
        break;
      } catch {
        if (attempt === MAX_ATTEMPTS) {
          return nodes.map(fallbackProposition);
        }
        await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
      }
    }

    // Cualquier nodo que el SLM siga omitiendo cae a una proposición mínima
    // (el nombre humanizado) en lugar de abortar el índice.
    return nodes.map((node) => byId.get(node.id) ?? fallbackProposition(node));
  }

  async #request(nodes: readonly PropositionInput[]): Promise<string> {
    const input = nodes.map((node) => ({ id: node.id, name: node.name, signature: node.signature }));
    return this.llm.chat(
      [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: `Entrada:\n${JSON.stringify(input)}\nSalida:` },
      ],
      OPTIONS,
    );
  }

  #collectInto(
    target: Map<string, NodePropositions>,
    text: string,
    source: readonly PropositionInput[],
  ): void {
    const sourceById = new Map(source.map((node) => [node.id, node]));
    const sourceByIndex = new Map(source.map((node, i) => [i, node]));
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(match[0]);
    } catch {
      return;
    }
    const rawNodes = (parsed as Record<string, unknown>)?.nodes;
    if (!Array.isArray(rawNodes)) return;
    for (let i = 0; i < rawNodes.length; i++) {
      const value = rawNodes[i];
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      let origin: PropositionInput | undefined;
      if (typeof record.id === "string") {
        origin = sourceById.get(record.id);
        if (!origin) continue;
      } else {
        origin = sourceByIndex.get(i);
        if (!origin) continue;
      }
      if (target.has(origin.id)) continue;
      const propositions = coercePropositions(record.propositions);
      target.set(origin.id, {
        id: origin.id,
        propositions: propositions.length > 0 ? propositions : fallbackProposition(origin).propositions,
      });
    }
  }
}

/** Fallback determinista sin SLM: el nombre humanizado (camelCase → palabras). */
function fallbackProposition(node: PropositionInput): NodePropositions {
  const humanized = node.name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  const text = humanized.length > 0 ? humanized : node.name;
  return { id: node.id, propositions: [text.slice(0, MAX_PROPOSITION_LENGTH)] };
}

function coercePropositions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const capped = trimmed.length > MAX_PROPOSITION_LENGTH ? trimmed.slice(0, MAX_PROPOSITION_LENGTH) : trimmed;
    const key = capped.normalize("NFKC").toLocaleLowerCase("en-US");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(capped);
    if (out.length >= MAX_PROPOSITIONS) break;
  }
  return out;
}
