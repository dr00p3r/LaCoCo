import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createLacocoMcpServer } from "../../mcp/server.js";
import { RetrievalSession } from "../pipeline.js";
import { resolveBooleanConfig, resolveNumberConfig, resolveStringConfig } from "../config.js";
import { resolveDbPath, resolveLanceDbPath } from "../storage-paths.js";
import { inspectProject } from "../state/project-registry.js";
import { strategyHelp } from "../pipeline.js";

interface McpCliOptions {
  strategy?: string;
  maxTokens?: number;
  ollama?: string;
  grounding?: boolean;
}

export function registerMcpCommand(program: Command): void {
  program
    .command("mcp [project]")
    .description("Levanta un servidor MCP (stdio) que expone la tool lacoco_retrieve para agentes.")
    .option("-s, --strategy <name>", strategyHelp())
    .option("--max-tokens <number>", "Presupuesto de tokens del contexto", parsePositiveInteger)
    .option("--ollama <endpoint>", "Endpoint de Ollama para el clasificador SLM")
    .option("--no-grounding", "Desactiva el grounding del perfil semántico")
    .action(async (project: string | undefined, options: McpCliOptions) => {
      await runMcpServer(project, options);
    });
}

async function runMcpServer(project: string | undefined, options: McpCliOptions): Promise<void> {
  const projectPath = resolveProjectPath(project);
  const dbPath = resolveDbPath(projectPath);

  // stdout está reservado al protocolo MCP: todo diagnóstico va a stderr.
  const logStderr = (message: string): void => {
    process.stderr.write(`${message}\n`);
  };

  if (!fs.existsSync(dbPath)) {
    logStderr(`[MCP] Proyecto no indexado: ${dbPath} no existe. Corre 'lacoco index_graph' primero.`);
    process.exitCode = 1;
    return;
  }

  const session = RetrievalSession.open({
    db: dbPath,
    lancedb: resolveLanceDbPath(projectPath),
    ollamaEndpoint: options.ollama ?? resolveStringConfig("agent.endpoint"),
    log: logStderr,
  });

  const server = createLacocoMcpServer({
    session,
    defaultStrategy: options.strategy ?? resolveStringConfig("strategy.default"),
    defaultMaxTokens: options.maxTokens ?? resolveNumberConfig("context.maxTokens"),
    defaultGrounding: options.grounding ?? resolveBooleanConfig("profile.groundingEnabled"),
  });

  // Cierre ordenado ante señales/EOF del cliente MCP.
  let closing = false;
  const shutdown = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await session.close(logStderr);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  const transport = new StdioServerTransport();
  await server.connect(transport);
  logStderr(`[MCP] Servidor lacoco listo (proyecto: ${projectPath}). Esperando llamadas por stdio.`);
}

function resolveProjectPath(project?: string): string {
  if (!project) return process.cwd();
  try {
    return inspectProject(project).path;
  } catch {
    return path.resolve(project);
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new Error("--max-tokens debe ser un entero positivo");
  }
  return parsed;
}
