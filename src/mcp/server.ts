/**
 * Servidor MCP de LaCoCo — expone el retrieval como una tool que el agente
 * invoca BAJO DEMANDA (a mitad de tarea), en vez del hook one-shot en t=0.
 *
 * El servidor es un proceso persistente: mantiene calientes SQLite, el cliente
 * Ollama y las estrategias (con su modelo de embeddings) a través de una
 * `RetrievalSession` viva durante toda su ejecución. La primera llamada paga el
 * cold-start; las siguientes reutilizan el estado.
 *
 * Doctrina SLM: la clasificación del SLM sigue siendo el default. Pero en modo
 * tool hay, por definición, un LLM capaz aguas arriba; si el agente aporta la
 * clasificación (clean_query/intent/dimensions), se valida y se congela — sin
 * llamar al SLM (mismo régimen que el arnés determinista).
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { RetrievalSession, type RetrievedContext } from "../cli/pipeline.js";
import { buildFrozenSanitizer, INTENT_TAGS } from "../retriever/utilities/structured-query.js";
import { DIMENSIONS } from "../domain/dimensions.js";
import { STRATEGY_NAMES } from "../retriever/strategies/strategy-names.js";

export interface McpServerConfig {
  session: RetrievalSession;
  defaultStrategy: string;
  defaultMaxTokens: number;
  defaultGrounding: boolean;
  version?: string;
}

const TOOL_DESCRIPTION = [
  "Recupera contexto de código del proyecto indexado (grafo tipado + búsqueda híbrida).",
  "Úsalo ANTES de grep/read para localizar los símbolos relevantes: devuelve rutas,",
  "rangos de línea y el CUERPO de cada símbolo tal como está en el working tree.",
  "",
  "Puedes aportar la clasificación para saltarte el clasificador interno (más rápido):",
  "- clean_query: query FTS5, típicamente símbolos/archivos entre comillas unidos con OR.",
  "- embedding_input: descripción en lenguaje natural de qué evidencia buscas.",
  "- intent: understand | refactor | create | debug | integrate | unknown.",
  "- dimensions: SYS (contratos/módulos/deps), CPG (clases/llamadas/ejecución), DTG (datos/tipos/estado).",
  "Si omites estos campos, el servidor clasifica con su modelo local (requiere Ollama).",
].join("\n");

/** Deriva el nombre corto del símbolo desde el nodeId (`ruta#Símbolo[.método]`). */
function symbolOf(nodeId: string): string {
  const afterHash = nodeId.includes("#") ? nodeId.slice(nodeId.lastIndexOf("#") + 1) : nodeId;
  return afterHash;
}

function toStructuredResult(context: RetrievedContext, classifiedBy: "agent" | "slm"): unknown {
  const base = {
    classifiedBy,
    classification: {
      route: context.sanitized.route,
      intent: context.sanitized.intent,
      confidence: context.sanitized.confidence,
      dimensions: context.sanitized.dimensions,
      cleanQuery: context.sanitized.clean_query,
      embeddingInput: context.sanitized.embedding_input,
    },
    chunks: context.chunks.map((chunk) => ({
      nodeId: chunk.nodeId,
      symbol: symbolOf(chunk.nodeId),
      filepath: chunk.location?.filepath ?? null,
      startLine: chunk.location?.startLine ?? null,
      endLine: chunk.location?.endLine ?? null,
      truncated: chunk.location?.truncated ?? false,
      score: chunk.score,
      source: chunk.source,
      text: chunk.text,
    })),
  };
  if (context.sanitized.route === "LLM_DIRECT") {
    return {
      ...base,
      note: "el clasificador determinó que esta consulta no requiere retrieval (route LLM_DIRECT)",
    };
  }
  return base;
}

/**
 * Construye el servidor MCP con la tool `lacoco_retrieve`. No abre transporte;
 * el llamador conecta un `StdioServerTransport`.
 */
export function createLacocoMcpServer(config: McpServerConfig): McpServer {
  const server = new McpServer({
    name: "lacoco",
    version: config.version ?? "1.0.0",
  });

  server.registerTool(
    "lacoco_retrieve",
    {
      description: TOOL_DESCRIPTION,
      inputSchema: {
        query: z.string().min(1).describe("El prompt/tarea original del usuario, sin modificar."),
        clean_query: z.string().optional().describe("Query FTS5 opcional (símbolos/archivos con OR)."),
        embedding_input: z.string().optional().describe("Descripción semántica opcional de la evidencia buscada."),
        intent: z.enum(INTENT_TAGS).optional().describe("Intención opcional de la consulta."),
        dimensions: z.array(z.enum(DIMENSIONS)).optional().describe("Dimensiones opcionales SYS/CPG/DTG."),
        strategy: z.enum(STRATEGY_NAMES).optional().describe("Estrategia de recuperación (default del servidor)."),
        maxTokens: z.number().int().positive().optional().describe("Presupuesto de tokens del contexto."),
      },
    },
    async (args): Promise<CallToolResult> => {
      try {
        const preset = buildFrozenSanitizer({
          clean_query: args.clean_query,
          embedding_input: args.embedding_input,
          intent: args.intent,
          dimensions: args.dimensions,
        });
        const context = await config.session.retrieve(args.query, {
          strategy: args.strategy ?? config.defaultStrategy,
          maxTokens: args.maxTokens ?? config.defaultMaxTokens,
          grounding: config.defaultGrounding,
          template: "v2",
          ...(preset ? { presetSanitized: preset } : {}),
        });
        const structured = toStructuredResult(context, preset ? "agent" : "slm");
        return { content: [{ type: "text", text: JSON.stringify(structured, null, 2) }] };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text", text: `lacoco_retrieve falló: ${message}` }],
        };
      }
    },
  );

  return server;
}
