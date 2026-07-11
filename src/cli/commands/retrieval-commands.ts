import { InvalidArgumentError, type Command } from "commander";
import { inspect, inspectQuery } from "../inspect.js";
import {
  runContextExport,
  runRetrieve,
  strategyHelp,
  type ContextExportCliOptions,
  type RetrieveCliOptions,
} from "../pipeline.js";
import { resolveStringConfig } from "../config.js";
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
    .command("export [project]")
    .description("Lee una query estructurada desde stdin y exporta contexto como Markdown.")
    .requiredOption("-o, --output <path>", "Archivo Markdown de salida")
    .option("-s, --strategy <name>", strategyHelp())
    .option("--chunks <number>", "Máximo de chunks producido por la estrategia", parsePositiveInteger)
    .option("--max-tokens <number>", "Presupuesto de tokens del agregador", parsePositiveInteger)
    .option("-v, --verbose", "Imprime diagnóstico del pipeline en stderr", false)
    .option("--json", "Imprime JSON válido", false)
    .action(async (project: string | undefined, options: ContextExportCliOptions) => {
      const input = await readStdin();
      const exitCode = await runContextExport(input, options, undefined, undefined, project);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}

function registerRetrieve(program: Command): void {
  program
    .command("retrieve [project]")
    .description("Lee una query estructurada desde stdin y devuelve contexto recuperado.")
    .option("-s, --strategy <name>", strategyHelp())
    .option("--chunks <number>", "Máximo de chunks producido por la estrategia", parsePositiveInteger)
    .option("--max-tokens <number>", "Presupuesto de tokens del agregador", parsePositiveInteger)
    .option("--json", "Imprime un resultado JSON estructurado", false)
    .option("-v, --verbose", "Imprime diagnóstico del pipeline en stderr", false)
    .action(async (project: string | undefined, options: RetrieveCliOptions) => {
      const input = await readStdin();
      const exitCode = await runRetrieve(input, options, undefined, undefined, project);
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
    .command("inspect-query [project]")
    .description("Lee una query estructurada desde stdin y visualiza el subgrafo recuperado.")
    .option("-b, --budget <num>", "Máximo de nodos a expandir", "75")
    .option("-s, --strategy <name>", strategyHelp())
    .option("--chunks <number>", "Máximo de chunks producido por la estrategia", parsePositiveInteger)
    .option("-m, --mode <mode>", "Modo de visualización (default, tensor, scores)", "default")
    .option("-o, --output <path>", "Archivo HTML de salida", "inspect-query.html")
    .option("--cdn", "Usar CDN para Cytoscape.js en vez de embeberlo", false)
    .action(async (project: string | undefined, options: InspectQueryCliOptions) => {
      const budget = parseBudget(options.budget);
      if (budget === null) return;
      const mode = ["default", "tensor", "scores"].includes(options.mode)
        ? options.mode as "default" | "tensor" | "scores"
        : "default";
      const input = await readStdin();
      const projectPath = resolveInspectQueryProjectPath(project);
      await inspectQuery({
        structuredInputJson: input,
        db: resolveDbPath(projectPath),
        lancedb: resolveLanceDbPath(projectPath),
        budget,
        strategy: options.strategy ?? resolveStringConfig("strategy.default"),
        mode,
        output: options.output,
        cdn: options.cdn,
        ...(options.chunks === undefined ? {} : { chunks: options.chunks }),
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

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new InvalidArgumentError("debe ser un entero positivo");
  }
  return parsed;
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
  chunks?: number;
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

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  return Buffer.concat(chunks).toString("utf-8");
}
