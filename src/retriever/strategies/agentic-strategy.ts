import {
  type RecoveryStrategy,
  type ContextChunk,
} from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LlmClient } from "../../slms/llm-client.js";
import { Bm25Service } from "../utilities/search/bm25-service.js";

interface Tool {
  name: "get_neighbors" | "get_node_by_symbol" | "get_dependencies";
  params: Record<string, string | number>;
}

export class AgenticStrategy implements RecoveryStrategy {
  private readonly bm25: Bm25Service;
  private readonly maxIterations = 3;

  constructor(
    private readonly db: LaCoCoDatabase,
    private readonly ollama: LlmClient,
  ) {
    this.bm25 = new Bm25Service(db);
  }

  /**
   * Recupera contexto mediante un ciclo agente-executor.
   *
   * @param query Salida sanitizada del intermediario
   * @returns Chunks recuperados tras max 3 iteraciones
   */
  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    // Fase 1: recuperar símbolos semilla por BM25
    const seedResults = this.bm25.search(query.clean_query, 5);
    const collected = new Map<string, ContextChunk>();

    for (const hit of seedResults) {
      collected.set(hit.nodeId, {
        nodeId: hit.nodeId,
        score: hit.score,
        text: hit.text,
        source: "AGENTIC",
      });
    }

    // Fase 2: ciclo agente-executor con SLM (Ollama)
    if (await this.ollama.isAvailable()) {
      const contextHistory: string[] = [];

      for (let i = 0; i < this.maxIterations && collected.size < 50; i++) {
        const toolCall = await this.#planTool(query, Array.from(collected.keys()), contextHistory);
        if (!toolCall) break;

        const results = this.#executeTool(toolCall);
        if (results.length === 0) break;

        for (const chunk of results) {
          if (!collected.has(chunk.nodeId)) {
            collected.set(chunk.nodeId, chunk);
          }
        }

        contextHistory.push(`Tool: ${toolCall.name}(${JSON.stringify(toolCall.params)}) → ${results.length} resultados`);
      }
    } else {
      // Fallback determinístico: expansión por vecindad pura
      for (let i = 0; i < this.maxIterations && collected.size < 50; i++) {
        const currentIds = Array.from(collected.keys());
        const neighbors = this.#getNeighbors(currentIds);
        for (const n of neighbors) {
          if (!collected.has(n.nodeId)) {
            collected.set(n.nodeId, n);
          }
        }
      }
    }

    return Array.from(collected.values()).sort((a, b) => b.score - a.score);
  }

  // ── Planificador SLM ─────────────────────────────────────────────────

  async #planTool(
    query: SanitizerOutput,
    currentIds: string[],
    history: string[]
  ): Promise<Tool | null> {
    const systemPrompt = `Eres un planificador de recuperación de código. Tienes estas herramientas:
- get_neighbors(node_id): recupera nodos conectados por aristas.
- get_node_by_symbol(name): busca un nodo por nombre de símbolo.
- get_dependencies(package, version): busca dependencias externas.

Usa herramientas solo cuando aporten contexto adicional concreto. Si los nodos actuales ya cubren la consulta,
responde {"done": true}. No inventes nombres de nodos, paquetes ni versiones.

Responde SOLO con un JSON de la forma: {"name": "...", "params": {...}}.
Si no necesitas más herramientas, responde: {"done": true}.`;

    const prompt = `Consulta: "${query.embedding_input}"\nNodos actuales: [${currentIds.join(", ")}]\nHistorial: ${history.join("; ") || "ninguno"}`;

    try {
      const response = await this.ollama.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ]
      );

      if (response.includes('"done"')) return null;

      // Extraer JSON de la respuesta (puede venir con markdown)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as { name: string; params: Record<string, unknown> };
      if (["get_neighbors", "get_node_by_symbol", "get_dependencies"].includes(parsed.name)) {
        return {
          name: parsed.name as Tool["name"],
          params: Object.fromEntries(
            Object.entries(parsed.params).map(([k, v]) => [k, String(v)])
          ),
        };
      }
    } catch (err) {
      console.warn(
        "[AgenticStrategy] ⚠️  SLM falló en planTool:",
        err instanceof Error ? err.message : String(err)
      );
    }
    return null;
  }

  // ── Ejecutor determinístico ─────────────────────────────────────────

  #executeTool(tool: Tool): ContextChunk[] {
    switch (tool.name) {
      case "get_neighbors":
        return this.#getNeighbors([tool.params.node_id as string]);
      case "get_node_by_symbol":
        return this.#getNodeBySymbol(tool.params.name as string);
      case "get_dependencies":
        return this.#getDependencies(tool.params.package as string, tool.params.version as string);
      default:
        return [];
    }
  }

  #getNodeBySymbol(name: string): ContextChunk[] {
    const ids = this.db.nodeDao.getNodeIdsBySymbol(name, 10);
    const sigs = this.db.getNodeSignatures(ids);
    return ids.map((id) => ({
      nodeId: id,
      score: 0.7,
      text: sigs.get(id) ?? id,
      source: "AGENTIC",
    }));
  }

  #getDependencies(pkg: string, version?: string): ContextChunk[] {
    const ids = this.db.nodeDao.getExternalLibraryIds(pkg, version, 10);
    const sigs = this.db.getNodeSignatures(ids);
    return ids.map((id) => ({
      nodeId: id,
      score: 0.6,
      text: sigs.get(id) ?? id,
      source: "AGENTIC",
    }));
  }

  // ── Motor determinístico de herramientas ─────────────────────────

  /** get_neighbors: recupera nodos conectados por aristas a los ids dados. */
  #getNeighbors(nodeIds: string[]): ContextChunk[] {
    if (nodeIds.length === 0) return [];

    const rows = this.db.edgeDao.getNeighborhood(nodeIds, { limit: 100 });

    const chunks: ContextChunk[] = [];
    const neighborIds = new Set<string>();
    for (const row of rows) {
      const otherId = nodeIds.includes(row.sourceId) ? row.targetId : row.sourceId;
      neighborIds.add(otherId);
    }

    const sigs = this.db.getNodeSignatures(Array.from(neighborIds));
    for (const id of neighborIds) {
      chunks.push({
        nodeId: id,
        score: 0.5,
        text: sigs.get(id) ?? id,
        source: "AGENTIC",
      });
    }
    return chunks;
  }
}
