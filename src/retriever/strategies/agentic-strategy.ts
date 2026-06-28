import {
  type RecoveryStrategy,
  type ContextChunk,
} from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { ChatOptions, LlmClient } from "../../slms/llm-client.js";
import { Bm25Service } from "../utilities/search/bm25-service.js";

type ToolCall =
  | { name: "get_neighbors"; params: { node_id: string } }
  | { name: "get_node_by_symbol"; params: { name: string } }
  | { name: "get_dependencies"; params: { package: string; version?: string } };

type PlannerOutput =
  | { action: "done" }
  | { action: "get_neighbors"; node_id: string }
  | { action: "get_node_by_symbol"; name: string }
  | { action: "get_dependencies"; package: string; version?: string };

export interface AgenticConfig {
  maxIterations: number;
  seedLimit: number;
  chunkLimit: number;
  neighborhoodLimit: number;
  symbolLimit: number;
  dependencyLimit: number;
  plannerAttempts: number;
}

export const AGENTIC_DEFAULT_CONFIG: Readonly<AgenticConfig> = Object.freeze({
  maxIterations: 3,
  seedLimit: 5,
  chunkLimit: 50,
  neighborhoodLimit: 100,
  symbolLimit: 10,
  dependencyLimit: 10,
  plannerAttempts: 2,
});

const PLANNER_SCHEMA: Record<string, unknown> = {
  oneOf: [
    {
      type: "object",
      additionalProperties: false,
      properties: { action: { const: "done" } },
      required: ["action"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { const: "get_neighbors" },
        node_id: { type: "string", minLength: 1 },
      },
      required: ["action", "node_id"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { const: "get_node_by_symbol" },
        name: { type: "string", minLength: 1 },
      },
      required: ["action", "name"],
    },
    {
      type: "object",
      additionalProperties: false,
      properties: {
        action: { const: "get_dependencies" },
        package: { type: "string", minLength: 1 },
        version: { type: "string", minLength: 1 },
      },
      required: ["action", "package"],
    },
  ],
};

const PLANNER_OPTIONS: ChatOptions = {
  format: PLANNER_SCHEMA,
  options: { temperature: 0, seed: 42, num_predict: 128 },
};

export class AgenticPlanningError extends Error {}

export class AgenticStrategy implements RecoveryStrategy {
  private readonly bm25: Bm25Service;
  private readonly config: AgenticConfig;

  constructor(
    private readonly db: LaCoCoDatabase,
    private readonly ollama: LlmClient,
    config?: Partial<AgenticConfig>,
  ) {
    this.bm25 = new Bm25Service(db);
    this.config = { ...AGENTIC_DEFAULT_CONFIG, ...config };
    validateConfig(this.config);
  }

  /**
   * Recupera contexto mediante un planificador local con contrato estructurado.
   *
   * @param query Salida sanitizada del intermediario.
   * @returns Como máximo `chunkLimit` chunks recuperados.
   */
  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    if (!await this.ollama.isAvailable()) {
      throw new AgenticPlanningError("Ollama no disponible para AgenticStrategy");
    }

    const collected = new Map<string, ContextChunk>();
    this.#collect(collected, this.bm25.toChunks(
      this.bm25.search(query.clean_query, this.config.seedLimit),
      "AGENTIC",
    ));

    const history: string[] = [];
    for (
      let iteration = 0;
      iteration < this.config.maxIterations && collected.size < this.config.chunkLimit;
      iteration++
    ) {
      const currentIds = [...collected.keys()];
      const toolCall = await this.#planTool(query, currentIds, history);
      if (!toolCall) break;

      const remaining = this.config.chunkLimit - collected.size;
      const results = this.#executeTool(toolCall, remaining);
      const added = this.#collect(collected, results);
      history.push(
        `Tool: ${toolCall.name}(${JSON.stringify(toolCall.params)}) -> ${added} nuevos`,
      );
      if (added === 0) break;
    }

    return [...collected.values()]
      .sort((left, right) => right.score - left.score)
      .slice(0, this.config.chunkLimit);
  }

  async #planTool(
    query: SanitizerOutput,
    currentIds: string[],
    history: string[],
  ): Promise<ToolCall | null> {
    const systemPrompt = `Eres un planificador de recuperacion de codigo.
Acciones disponibles:
- get_neighbors: requiere node_id y solo puede usar uno de los nodos actuales.
- get_node_by_symbol: requiere name.
- get_dependencies: requiere package y admite version opcional.
- done: termina cuando el contexto ya es suficiente.

No inventes identificadores, simbolos, paquetes ni versiones. Devuelve solo el objeto JSON requerido.`;
    const prompt = `Consulta: ${JSON.stringify(query.embedding_input)}
Nodos actuales: ${JSON.stringify(currentIds)}
Historial: ${history.length === 0 ? "ninguno" : history.join("; ")}`;

    let lastError: unknown;
    for (let attempt = 0; attempt < this.config.plannerAttempts; attempt++) {
      try {
        const response = await this.ollama.chat([
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ], PLANNER_OPTIONS);
        return this.#parsePlannerOutput(response, currentIds);
      } catch (error) {
        lastError = error;
      }
    }

    throw new AgenticPlanningError(
      `El planificador agentic incumplió el contrato después de ${this.config.plannerAttempts} intentos`,
      { cause: lastError },
    );
  }

  #parsePlannerOutput(response: string, currentIds: string[]): ToolCall | null {
    const parsed = JSON.parse(response) as unknown;
    if (!isRecord(parsed) || typeof parsed.action !== "string") {
      throw new Error("Salida agentic inválida");
    }

    switch (parsed.action) {
      case "done":
        assertExactKeys(parsed, ["action"]);
        return null;
      case "get_neighbors": {
        assertExactKeys(parsed, ["action", "node_id"]);
        const nodeId = requireNonEmptyString(parsed.node_id, "node_id");
        if (!currentIds.includes(nodeId)) {
          throw new Error("get_neighbors.node_id debe pertenecer a los nodos actuales");
        }
        return { name: "get_neighbors", params: { node_id: nodeId } };
      }
      case "get_node_by_symbol":
        assertExactKeys(parsed, ["action", "name"]);
        return {
          name: "get_node_by_symbol",
          params: { name: requireNonEmptyString(parsed.name, "name") },
        };
      case "get_dependencies": {
        assertExactKeys(parsed, ["action", "package", "version"]);
        const packageName = requireNonEmptyString(parsed.package, "package");
        const version = parsed.version === undefined
          ? undefined
          : requireNonEmptyString(parsed.version, "version");
        return {
          name: "get_dependencies",
          params: {
            package: packageName,
            ...(version === undefined ? {} : { version }),
          },
        };
      }
      default:
        throw new Error(`Acción agentic no soportada: ${parsed.action}`);
    }
  }

  #executeTool(tool: ToolCall, remaining: number): ContextChunk[] {
    switch (tool.name) {
      case "get_neighbors":
        return this.#getNeighbors(tool.params.node_id, remaining);
      case "get_node_by_symbol":
        return this.#getNodeBySymbol(tool.params.name, remaining);
      case "get_dependencies":
        return this.#getDependencies(tool.params.package, tool.params.version, remaining);
    }
  }

  #getNodeBySymbol(name: string, remaining: number): ContextChunk[] {
    const limit = Math.min(this.config.symbolLimit, remaining);
    const ids = this.db.nodeDao.getNodeIdsBySymbol(name, limit);
    return this.#nodeChunks(ids, 0.7);
  }

  #getDependencies(pkg: string, version: string | undefined, remaining: number): ContextChunk[] {
    const limit = Math.min(this.config.dependencyLimit, remaining);
    const ids = this.db.nodeDao.getExternalLibraryIds(pkg, version, limit);
    return this.#nodeChunks(ids, 0.6);
  }

  #getNeighbors(nodeId: string, remaining: number): ContextChunk[] {
    if (remaining <= 0) return [];
    const limit = Math.min(this.config.neighborhoodLimit, remaining);
    const rows = this.db.edgeDao.getNeighborhood([nodeId], { limit });
    const neighborIds = new Set<string>();
    for (const row of rows) {
      neighborIds.add(row.sourceId === nodeId ? row.targetId : row.sourceId);
      if (neighborIds.size >= limit) break;
    }
    return this.#nodeChunks([...neighborIds], 0.5);
  }

  #nodeChunks(ids: string[], score: number): ContextChunk[] {
    const signatures = this.db.getNodeSignatures(ids);
    return ids.map((id) => ({
      chunkId: id,
      nodeId: id,
      score,
      text: signatures.get(id) ?? id,
      source: "AGENTIC",
    }));
  }

  #collect(collected: Map<string, ContextChunk>, chunks: ContextChunk[]): number {
    let added = 0;
    for (const chunk of chunks) {
      if (collected.size >= this.config.chunkLimit) break;
      if (collected.has(chunk.chunkId)) continue;
      collected.set(chunk.chunkId, chunk);
      added++;
    }
    return added;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${field} debe ser un string no vacío`);
  }
  return value;
}

function assertExactKeys(value: Record<string, unknown>, allowed: string[]): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Propiedades agentic no soportadas: ${unexpected.join(", ")}`);
  }
}

function validateConfig(config: AgenticConfig): void {
  for (const [key, value] of Object.entries(config)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`AgenticConfig.${key} debe ser un entero positivo`);
    }
  }
  if (config.maxIterations > AGENTIC_DEFAULT_CONFIG.maxIterations) {
    throw new Error(`AgenticConfig.maxIterations no puede superar ${AGENTIC_DEFAULT_CONFIG.maxIterations}`);
  }
  if (config.plannerAttempts > AGENTIC_DEFAULT_CONFIG.plannerAttempts) {
    throw new Error(`AgenticConfig.plannerAttempts no puede superar ${AGENTIC_DEFAULT_CONFIG.plannerAttempts}`);
  }
}
