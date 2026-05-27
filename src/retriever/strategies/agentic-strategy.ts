/**
 * AgenticStrategy (2.3) — Recuperación guiada por LLM planificador + ejecutor determinístico.
 *
 * El SLM (Qwen2.5-Coder:1.5B) emite herramientas (tool-calling) para navegar el grafo.
 * Un motor determinístico ejecuta cada tool sobre SQLite/LanceDB.
 * Máximo 3 iteraciones. Filtro dimensional como hint inicial.
 */

import {
  type RecoveryStrategy,
  type ContextChunk,
} from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { DimensionalFilter } from "../utilities/filters/dimensional-filter.js";
import { OllamaService } from "../../slms/ollama-service.js";

/** Herramientas disponibles para el agente */
interface Tool {
  name: "get_neighbors" | "get_node_by_symbol" | "get_dependencies";
  params: Record<string, string | number>;
}

export class AgenticStrategy implements RecoveryStrategy {
  private readonly dimFilter: DimensionalFilter;
  private readonly ollama: OllamaService;
  private readonly maxIterations = 3;

  constructor(
    private readonly db: LaCoCoDatabase,
    ollamaEndpoint = "http://localhost:11434",
    confidenceThreshold = 0.65
  ) {
    this.ollama = new OllamaService(ollamaEndpoint);
    this.dimFilter = new DimensionalFilter(confidenceThreshold, this.ollama);
  }

  /**
   * Recupera contexto mediante un ciclo agente-executor.
   *
   * @param query Salida sanitizada del intermediario
   * @returns Chunks recuperados tras max 3 iteraciones
   */
  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    // Hint dimensional inicial
    const dimensions = await this.dimFilter.filter(query);

    // Fase 1: recuperar símbolos semilla por BM25
    const seedResults = this.db.searchBM25(query.clean_query, 20);
    const collected = new Map<string, ContextChunk>();
    const seedSigs = this.db.getNodeSignatures(seedResults.map((r) => r.node_id));

    for (const r of seedResults) {
      collected.set(r.node_id, {
        nodeId: r.node_id,
        score: Math.max(0, 1 - Math.abs(r.score)),
        text: seedSigs.get(r.node_id) ?? r.node_id,
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
    } catch {
      // Si Ollama devuelve algo inválido, terminamos el ciclo
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
    const rawDb = this.db.getRawDb();
    const rows = rawDb
      .prepare("SELECT id FROM nodes WHERE name = ? LIMIT 10")
      .all(name) as { id: string }[];
    const sigs = this.db.getNodeSignatures(rows.map((r) => r.id));
    return rows.map((r) => ({
      nodeId: r.id,
      score: 0.7,
      text: sigs.get(r.id) ?? r.id,
      source: "AGENTIC",
    }));
  }

  #getDependencies(pkg: string, version?: string): ContextChunk[] {
    const rawDb = this.db.getRawDb();
    const sql = version
      ? "SELECT id FROM nodes WHERE kind = 'EXTERNAL_LIB' AND name LIKE ? AND name LIKE ? LIMIT 10"
      : "SELECT id FROM nodes WHERE kind = 'EXTERNAL_LIB' AND name LIKE ? LIMIT 10";
    const params = version ? [`%${pkg}%`, `%${version}%`] : [`%${pkg}%`];
    const rows = rawDb.prepare(sql).all(...params) as { id: string }[];
    const sigs = this.db.getNodeSignatures(rows.map((r) => r.id));
    return rows.map((r) => ({
      nodeId: r.id,
      score: 0.6,
      text: sigs.get(r.id) ?? r.id,
      source: "AGENTIC",
    }));
  }

  // ── Motor determinístico de herramientas ─────────────────────────

  /** get_neighbors: recupera nodos conectados por aristas a los ids dados. */
  #getNeighbors(nodeIds: string[]): ContextChunk[] {
    if (nodeIds.length === 0) return [];

    const placeholders = nodeIds.map(() => "?").join(",");
    const sql = `
      SELECT sourceId, targetId, relation
      FROM edges
      WHERE sourceId IN (${placeholders}) OR targetId IN (${placeholders})
      LIMIT 100
    `;

    const rawDb = this.db.getRawDb();
    const rows = rawDb.prepare(sql).all([...nodeIds, ...nodeIds]) as {
      sourceId: string;
      targetId: string;
      relation: string;
    }[];

    const chunks: ContextChunk[] = [];
    for (const row of rows) {
      const otherId = nodeIds.includes(row.sourceId) ? row.targetId : row.sourceId;
      chunks.push({
        nodeId: otherId,
        score: 0.5, // Score base de vecindad
        text: `${otherId} (via ${row.relation})`,
        source: "AGENTIC",
      });
    }
    return chunks;
  }
}
