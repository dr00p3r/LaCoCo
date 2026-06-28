import type { Command } from "commander";
import { inspect, inspectQuery } from "../inspect.js";
import {
  runContextExport,
  runRetrieve,
  strategyHelp,
  type ContextExportCliOptions,
  type RetrieveCliOptions,
} from "../pipeline.js";
import { resolveNumberConfig, resolveStringConfig } from "../config.js";
import { resolveDbPath, resolveLanceDbPath } from "../storage-paths.js";
import { inspectProject } from "../state/project-registry.js";

export function registerRetrievalCommands(program: Command): void {
  registerContextExport(program);
  registerRetrieve(program);
  registerInspect(program);
  registerInspectQuery(program);
}

function registerContextExport(program: Command): void {
  const context = program
    .command("context")
    .description("Exporta y administra contextos recuperados.");

  context
    .command("export [project] <query>")
    .description("Recupera contexto y lo exporta como Markdown identificable por pregunta.")
    .requiredOption("-o, --output <path>", "Archivo Markdown de salida")
    .option("-s, --strategy <name>", strategyHelp())
    .option("--ollama <url>", "Endpoint de Ollama; por defecto agent.endpoint")
    .option("-v, --verbose", "Imprime diagnóstico del pipeline en stderr", false)
    .option("--json", "Imprime JSON válido", false)
    .action(async (project: string | undefined, query: string, options: ContextExportCliOptions) => {
      const exitCode = await runContextExport(query, options, undefined, undefined, project);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}

function registerRetrieve(program: Command): void {
  program
    .command("retrieve [project] <query>")
    .description("Recupera contexto del proyecto y devuelve un prompt enriquecido para hooks.")
    .option("-s, --strategy <name>", strategyHelp())
    .option("--ollama <url>", "Endpoint de Ollama; por defecto agent.endpoint")
    .option("--json", "Imprime un resultado JSON estructurado para hooks", false)
    .option("-v, --verbose", "Imprime diagnóstico del pipeline en stderr", false)
    .action(async (project: string | undefined, query: string, options: RetrieveCliOptions) => {
      const exitCode = await runRetrieve(query, options, undefined, undefined, project);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}

function registerInspect(program: Command): void {
  program
    .command("inspect <root-node>")
    .description("Visualiza el subgrafo alrededor de un nodo usando expansión BFS con budget.")
    .option("-b, --budget <num>", "Máximo de nodos a expandir", "75")
    .option("-f, --focus <dim>", "Prioridad dimensional: SYS, CPG, DTG, ALL", "ALL")
    .option("-o, --output <path>", "Archivo HTML de salida", "inspect.html")
    .option("--cdn", "Usar CDN para Cytoscape.js en vez de embeberlo", false)
    .action(async (rootNode: string, options: InspectCliOptions) => {
      const budget = parseBudget(options.budget);
      if (budget === null) return;
      const focus = ["SYS", "CPG", "DTG", "ALL"].includes(options.focus)
        ? options.focus as "SYS" | "CPG" | "DTG" | "ALL"
        : "ALL";
      await inspect({
        rootNode,
        db: resolveDbPath(process.cwd()),
        budget,
        focus,
        output: options.output,
        cdn: options.cdn,
      });
    });
}

function registerInspectQuery(program: Command): void {
  program
    .command("inspect-query [project] <prompt>")
    .description("Pipeline RAG completo → visualización del subgrafo recuperado para un prompt.")
    .option("-b, --budget <num>", "Máximo de nodos a expandir", "75")
    .option("-s, --strategy <name>", strategyHelp())
    .option("-m, --mode <mode>", "Modo de visualización (default, tensor, scores)", "default")
    .option("-o, --output <path>", "Archivo HTML de salida", "inspect-query.html")
    .option("--cdn", "Usar CDN para Cytoscape.js en vez de embeberlo", false)
    .option("--ollama <url>", "Endpoint de Ollama; por defecto agent.endpoint")
    .action(async (project: string | undefined, prompt: string, options: InspectQueryCliOptions) => {
      const budget = parseBudget(options.budget);
      if (budget === null) return;
      const mode = ["default", "tensor", "scores"].includes(options.mode)
        ? options.mode as "default" | "tensor" | "scores"
        : "default";
      const ollamaEndpoint = options.ollama ?? resolveStringConfig("agent.endpoint");
      const projectPath = resolveInspectQueryProjectPath(project);
      await inspectQuery({
        prompt,
        db: resolveDbPath(projectPath),
        lancedb: resolveLanceDbPath(projectPath),
        budget,
        strategy: options.strategy ?? resolveStringConfig("strategy.default"),
        mode,
        output: options.output,
        cdn: options.cdn,
        ollama: ollamaEndpoint,
        model: resolveStringConfig("agent.model"),
        timeoutMs: resolveNumberConfig("timeout.ms"),
      });
    });
}

function parseBudget(value: string): number | null {
  const budget = Number.parseInt(value, 10);
  if (Number.isNaN(budget) || budget < 1) {
    console.error("[CLI] ❌ --budget debe ser un número positivo.");
    process.exitCode = 1;
    return null;
  }
  return budget;
}

interface InspectCliOptions {
  budget: string;
  focus: string;
  output: string;
  cdn: boolean;
}

interface InspectQueryCliOptions {
  budget: string;
  strategy?: string;
  mode: string;
  output: string;
  cdn: boolean;
  ollama?: string;
}

function resolveInspectQueryProjectPath(project?: string): string {
  if (!project) return process.cwd();
  try {
    const record = inspectProject(project);
    return record.path;
  } catch {
    return project;
  }
}
