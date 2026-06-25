#!/usr/bin/env node

import { Command } from "commander";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { DaemonManager } from "../extractor/daemon.js";
import { AgentIntermediary1 } from "../retriever/utilities/mini-agents/agent-intermediary/index.js";
import { SlmClassifier } from "../retriever/utilities/mini-agents/agent-intermediary/classifier.js";
import { ContextAggregator } from "../retriever/utilities/filters/context-aggregator.js";
import { PromptInjector } from "../retriever/utilities/filters/prompt-injector.js";
import { HybridStrategy } from "../retriever/strategies/hybrid-strategy.js";
import { AgenticStrategy } from "../retriever/strategies/agentic-strategy.js";
import { IctdStrategy } from "../retriever/strategies/ictd-strategy.js";
import { ClcrStrategy } from "../retriever/strategies/clcr-strategy.js";
import { RprStrategy } from "../retriever/strategies/rpr-strategy.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { VectorsIndexer } from "../indexer/vectors-indexer.js";
import { OllamaService } from "../slms/ollama-service.js";
import type { RecoveryStrategy } from "../retriever/models/strategies/types.js";
import type { SanitizerOutput } from "../retriever/models/utilities/types.js";
import { inspect, inspectQuery } from "./inspect.js";
import { GraphIndexer } from "../indexer/graph-indexer.js";
import {
  configKeys,
  getConfigPath,
  listConfig,
  resolveConfig,
  setConfig,
  unsetConfig,
  type WritableConfigScope,
} from "./state/config-store.js";
import { writeTextFileAtomic } from "./state/json-store.js";
import {
  getProjectsPath,
  inspectProject,
  listProjects,
  markProjectIndexStatus,
  markWatcherError,
  markWatcherRunning,
  markWatcherStarting,
  markWatcherStopped,
  registerCurrentProject,
  removeProject,
  configureProjectWatcher,
  type ProjectRecord,
} from "./state/project-registry.js";
import { acquireWatchLock, type WatchLock } from "./state/watch-lock.js";



export const program = new Command();
program
  .name("lacoco")
  .description("LaCoCo — Recuperador de Contexto de Grandes Bases de Código (RAG local)")
  .version("1.0.0");

program
  .command("init [project-path]")
  .description("Registra el proyecto actual en el estado persistente de LaCoCo.")
  .option("--json", "Imprime JSON válido", false)
  .action((projectPath: string | undefined, options: JsonOption) => {
    runCliCommand(() => {
      const project = registerCurrentProject(projectPath ?? process.cwd());
      writeProjectResult(project, options.json);
    });
  });

program
  .command("status [project]")
  .description("Muestra el estado registrado de un proyecto.")
  .option("--json", "Imprime JSON válido", false)
  .action((project: string | undefined, options: JsonOption) => {
    runCliCommand(() => {
      const record = project
        ? inspectProject(project)
        : inspectProject(process.cwd());
      writeProjectResult(record, options.json);
    });
  });

const configCommand = program
  .command("config")
  .description("Consulta y modifica configuración de LaCoCo.");

configCommand
  .command("list")
  .description("Lista las claves de configuración resueltas y su origen.")
  .option("--json", "Imprime JSON válido", false)
  .action((options: JsonOption) => {
    runCliCommand(() => {
      const entries = listConfig();
      if (options.json) {
        console.log(JSON.stringify(entries, null, 2));
        return;
      }
      console.log(formatTable(["KEY", "VALUE", "SOURCE"], entries.map((entry) => [
        entry.key,
        String(entry.value),
        entry.source,
      ])));
    });
  });

configCommand
  .command("get <key>")
  .description("Muestra una clave de configuración resuelta.")
  .option("--json", "Imprime JSON válido", false)
  .action((key: string, options: JsonOption) => {
    runCliCommand(() => {
      const entry = resolveConfig(key);
      if (options.json) {
        console.log(JSON.stringify(entry, null, 2));
        return;
      }
      console.log(`${entry.value} (${entry.source})`);
    });
  });

configCommand
  .command("set <key> <value>")
  .description("Guarda una clave de configuración en el alcance seleccionado.")
  .option("--global", "Escribe en la configuración global del usuario", false)
  .option("--local", "Escribe en la configuración local del proyecto", false)
  .option("--json", "Imprime JSON válido", false)
  .action((key: string, value: string, options: ConfigScopeOptions) => {
    runCliCommand(() => {
      const scope = resolveWritableScope(options);
      setConfig(key, value, scope);
      const entry = resolveConfig(key);
      if (options.json) {
        console.log(JSON.stringify({ scope, entry }, null, 2));
        return;
      }
      console.log(`${key}=${entry.value} escrito en ${scope}`);
    });
  });

configCommand
  .command("unset <key>")
  .description("Elimina una clave de configuración del alcance seleccionado.")
  .option("--global", "Elimina desde la configuración global del usuario", false)
  .option("--local", "Elimina desde la configuración local del proyecto", false)
  .option("--json", "Imprime JSON válido", false)
  .action((key: string, options: ConfigScopeOptions) => {
    runCliCommand(() => {
      const scope = resolveWritableScope(options);
      unsetConfig(key, scope);
      if (options.json) {
        console.log(JSON.stringify({ key, scope, unset: true }, null, 2));
        return;
      }
      console.log(`${key} eliminado de ${scope}`);
    });
  });

configCommand
  .command("path")
  .description("Muestra la ruta de archivo para configuración global o local.")
  .option("--global", "Muestra la ruta global", false)
  .option("--local", "Muestra la ruta local", false)
  .option("--json", "Imprime JSON válido", false)
  .action((options: ConfigScopeOptions) => {
    runCliCommand(() => {
      const scope = resolveWritableScope(options);
      const filePath = getConfigPath(scope);
      if (options.json) {
        console.log(JSON.stringify({ scope, path: filePath }, null, 2));
        return;
      }
      console.log(filePath);
    });
  });

configCommand
  .command("keys")
  .description("Lista las claves de configuración válidas.")
  .action(() => {
    runCliCommand(() => {
      console.log(configKeys().join("\n"));
    });
  });

const projectCommand = program
  .command("project")
  .description("Administra el registro persistente de proyectos.");

projectCommand
  .command("list")
  .description("Lista los proyectos registrados.")
  .option("--json", "Imprime JSON válido", false)
  .action((options: JsonOption) => {
    runCliCommand(() => {
      const projects = listProjects();
      if (options.json) {
        console.log(JSON.stringify(projects, null, 2));
        return;
      }
      console.log(formatProjectList(projects));
    });
  });

projectCommand
  .command("inspect <project>")
  .description("Muestra el detalle de un proyecto registrado.")
  .option("--json", "Imprime JSON válido", false)
  .action((project: string, options: JsonOption) => {
    runCliCommand(() => {
      writeProjectResult(inspectProject(project), options.json);
    });
  });

projectCommand
  .command("remove <project>")
  .description("Elimina un proyecto del registro.")
  .option("--json", "Imprime JSON válido", false)
  .action((project: string, options: JsonOption) => {
    runCliCommand(() => {
      const removed = removeProject(project);
      if (options.json) {
        console.log(JSON.stringify({ removed }, null, 2));
        return;
      }
      console.log(`Proyecto eliminado: ${removed.name} (${removed.id})`);
    });
  });

projectCommand
  .command("path")
  .description("Muestra la ruta del registro persistente de proyectos.")
  .action(() => {
    runCliCommand(() => {
      console.log(getProjectsPath());
    });
  });

const contextCommand = program
  .command("context")
  .description("Exporta y administra contextos recuperados.");

contextCommand
  .command("export <query>")
  .description("Recupera contexto y lo exporta como Markdown identificable por pregunta.")
  .requiredOption("-o, --output <path>", "Archivo Markdown de salida")
  .option("-d, --db <path>", "Ruta al archivo SQLite", "tensor.sqlite")
  .option("-l, --lancedb <path>", "Ruta al directorio de LanceDB", "./lancedb")
  .option("-s, --strategy <name>", "Estrategia de recuperación (hybrid, agentic, ictd, clcr, rpr)", "hybrid")
  .option("--ollama <url>", "Endpoint de Ollama", "http://localhost:11434")
  .option("-v, --verbose", "Imprime diagnóstico del pipeline en stderr", false)
  .option("--json", "Imprime JSON válido", false)
  .action(async (query: string, options: ContextExportCliOptions) => {
    const exitCode = await runContextExport(query, options);
    if (exitCode !== 0) process.exitCode = exitCode;
  });


program
  .command("_watch-foreground <ruta-tsconfig>", { hidden: true })
  .option("-d, --db <path>", "Ruta al archivo SQLite de salida", "tensor.sqlite")
  .option("-l, --lancedb <path>", "Ruta al directorio de LanceDB", "./lancedb")
  .option("-v, --verbose", "Imprime el path de cada archivo procesado", false)
  .action((rutaTsconfig: string, options: WatchForegroundOptions) => {
    startForegroundWatcher(
      rutaTsconfig,
      options,
      process.env.LACOCO_WATCH_PROJECT_ID,
      process.env.LACOCO_WATCH_SKIP_LOCK === "1" ? noopWatchLock() : undefined,
    );
  });

program
  .command("watch [action] [project]")
  .description(
    "Administra watchers. Compatibilidad: `watch <tsconfig>` inicia foreground."
  )
  .option("-d, --db <path>", "Ruta al archivo SQLite de salida", "tensor.sqlite")
  .option("-l, --lancedb <path>", "Ruta al directorio de LanceDB", "./lancedb")
  .option("-v, --verbose", "Imprime el path de cada archivo procesado", false)
  .option("--foreground", "Ejecuta el watcher en primer plano", false)
  .option("--json", "Imprime JSON válido", false)
  .action((action: string | undefined, project: string | undefined, options: WatchCliOptions) => {
    runCliCommand(() => {
      runWatchCommand(action, project, options);
    });
  });


program
  .command("index_graph <ruta-tsconfig>")
  .description(
    "Extrae solo el grafo estructural en SQLite (sin embeddings ni watcher)."
  )
  .option("-d, --db <path>", "Ruta al archivo SQLite de salida", "tensor.sqlite")
  .option("-v, --verbose", "Imprime progreso detallado", false)
  .action((rutaTsconfig: string, options: { db: string; verbose: boolean }) => {
   
    console.log("\n[CLI] Extrayendo grafo estructural...\n");
    console.log(`  tsconfig : ${rutaTsconfig}`);
    console.log(`  sqlite   : ${options.db}\n`);

    const projectPath = projectPathFromTsconfig(rutaTsconfig);
    registerCurrentProject(projectPath);

    try {
      const indexer = new GraphIndexer(options.db, rutaTsconfig);
      indexer.index();
      markProjectIndexStatus(projectPath, "completed");
    } catch (err) {
      markProjectIndexStatus(projectPath, "error");
      throw err;
    }

  });

program
  .command("index_vectors")
  .description(
    "Genera embeddings semánticos en LanceDB directamente desde el AST (sin dependencia de SQLite)."
  )
  .requiredOption("--tsconfig <path>", "Ruta al tsconfig.json del proyecto a analizar")
  .option("--lancedb <path>", "Ruta al directorio de LanceDB", "./lancedb")
  .option("-v, --verbose", "Imprime progreso detallado", false)
  .action(async (options: { tsconfig: string; lancedb: string; verbose: boolean }) => {
    
    console.log("\n[CLI] Indexando vectores semánticos...\n");
    console.log(`  tsconfig : ${options.tsconfig}`);
    console.log(`  lancedb  : ${options.lancedb}\n`);

    const projectPath = projectPathFromTsconfig(options.tsconfig);
    registerCurrentProject(projectPath);

    try {
      const indexer = new VectorsIndexer(options.lancedb, options.tsconfig);
      await indexer.index();
      markProjectIndexStatus(projectPath, "completed");
    } catch (err) {
      markProjectIndexStatus(projectPath, "error");
      throw err;
    }

  });

program
  .command("retrieve <query>")
  .description("Ejecuta el pipeline RAG completo y muestra la respuesta del LLM.")
  .option("-d, --db <path>", "Ruta al archivo SQLite", "tensor.sqlite")
  .option("-l, --lancedb <path>", "Ruta al directorio de LanceDB", "./lancedb")
  .option("-s, --strategy <name>", "Estrategia de recuperación (hybrid, agentic, ictd, clcr, rpr)", "hybrid")
  .option("--ollama <url>", "Endpoint de Ollama", "http://localhost:11434")
  .option("--no-llm", "Solo muestra chunks recuperados, no llama al LLM")
  .option("-v, --verbose", "Imprime diagnóstico del pipeline en stderr", false)
  .action(async (query: string, options: RetrieveCliOptions) => {
    const exitCode = await runRetrieve(query, options);
    if (exitCode !== 0) process.exitCode = exitCode;
  });

export interface RetrieveCliOptions {
  db: string;
  lancedb: string;
  strategy: string;
  ollama: string;
  llm: boolean;
  verbose: boolean;
}

export interface ContextExportCliOptions extends Omit<RetrieveCliOptions, "llm">, JsonOption {
  output: string;
}

export interface CliStreams {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
}

export interface RetrieveOllamaClient {
  isAvailable(): Promise<boolean>;
  generate(prompt: string, system?: string): Promise<string>;
}

export interface RetrieveIntermediary {
  sanitize(prompt: string): Promise<SanitizerOutput>;
}

export interface RetrieveRuntime {
  createDatabase(dbPath: string): LaCoCoDatabase;
  createOllama(endpoint: string): RetrieveOllamaClient;
  createIntermediary(ollama: RetrieveOllamaClient): RetrieveIntermediary;
  createStrategy(
    strategyName: string,
    db: LaCoCoDatabase,
    lanceDbPath: string,
    ollamaEndpoint: string,
  ): Promise<{ strategy: RecoveryStrategy; connectedLanceDb?: LaCoCoLanceDb }>;
}

interface RetrievedContext {
  id: string;
  generatedAt: string;
  originalQuery: string;
  options: {
    strategy: string;
    db: string;
    lancedb: string;
    ollama: string;
  };
  sanitized: SanitizerOutput;
  chunks: ReturnType<ContextAggregator["aggregate"]>;
  enrichedPrompt: string;
}

const defaultRetrieveRuntime: RetrieveRuntime = {
  createDatabase: (dbPath) => new LaCoCoDatabase(dbPath),
  createOllama: (endpoint) => new OllamaService(endpoint),
  createIntermediary: (ollama) =>
    new AgentIntermediary1(new SlmClassifier(ollama as OllamaService)),
  createStrategy: createRecoveryStrategy,
};

/**
 * Ejecuta el pipeline observable de `lacoco retrieve`.
 *
 * stdout queda reservado para el resultado final; los mensajes operativos y
 * errores se escriben en stderr para permitir pipes y redirecciones.
 */
export async function runRetrieve(
  query: string,
  options: RetrieveCliOptions,
  streams: CliStreams = { stdout: process.stdout, stderr: process.stderr },
  runtime: RetrieveRuntime = defaultRetrieveRuntime,
): Promise<number> {
  const writeStdout = (message: string): void => {
    streams.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
  };
  const writeStderr = (message: string): void => {
    streams.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };

  try {
    const context = await retrieveContext(query, options, streams, runtime);

    if (options.llm && context.chunks.length > 0 && context.sanitized.route === "RAG") {
      const ollama = runtime.createOllama(options.ollama);
      if (await ollama.isAvailable()) {
        const answer = await ollama.generate(context.enrichedPrompt);
        writeStdout(answer);
      } else {
        writeStderr("[CLI] Ollama no disponible para la respuesta final; se imprime el prompt enriquecido.");
        writeStdout(context.enrichedPrompt);
      }
    } else {
      writeStdout(context.enrichedPrompt);
    }

    if (options.verbose) writeStderr("[CLI] retrieve completado");
    return 0;
  } catch (err) {
    const stage = err instanceof PipelineStageError ? err.stage : "inicialización";
    writeStderr(`[CLI] Error en pipeline RAG (${stage}): ${formatError(err)}`);
    return 1;
  }
}

export async function runContextExport(
  query: string,
  options: ContextExportCliOptions,
  streams: CliStreams = { stdout: process.stdout, stderr: process.stderr },
  runtime: RetrieveRuntime = defaultRetrieveRuntime,
): Promise<number> {
  const writeStdout = (message: string): void => {
    streams.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
  };
  const writeStderr = (message: string): void => {
    streams.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };

  try {
    const context = await retrieveContext(query, { ...options, llm: false }, streams, runtime);
    const markdown = renderContextMarkdown(context);
    const outputPath = path.resolve(options.output);
    writeTextFileAtomic(outputPath, markdown);

    if (options.json) {
      writeStdout(JSON.stringify({
        id: context.id,
        output: outputPath,
        query: context.originalQuery,
        strategy: context.options.strategy,
        chunks: context.chunks.length,
      }, null, 2));
    } else {
      writeStdout(`Contexto exportado: ${outputPath}`);
    }

    return 0;
  } catch (err) {
    const stage = err instanceof PipelineStageError ? err.stage : "exportación";
    writeStderr(`[CLI] Error exportando contexto (${stage}): ${formatError(err)}`);
    return 1;
  }
}

async function retrieveContext(
  query: string,
  options: RetrieveCliOptions,
  streams: CliStreams,
  runtime: RetrieveRuntime,
): Promise<RetrievedContext> {
  let stage = "inicialización";
  let db: LaCoCoDatabase | undefined;
  let lanceDb: LaCoCoLanceDb | undefined;

  const writeStderr = (message: string): void => {
    streams.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };
  const verbose = (message: string): void => {
    if (options.verbose) writeStderr(message);
  };

  try {
    verbose(`[CLI] retrieve: strategy=${options.strategy} db=${options.db}`);

    stage = "SQLite";
    db = runtime.createDatabase(options.db);
    const ollama = runtime.createOllama(options.ollama);

    stage = "intermediario";
    const intermediary = runtime.createIntermediary(ollama);
    const sanitized = await intermediary.sanitize(query);

    verbose(
      `[CLI] intermediario: route=${sanitized.route} intent=${sanitized.intent} ` +
        `confidence=${sanitized.confidence.toFixed(2)} clean_query=${JSON.stringify(sanitized.clean_query)}`,
    );

    if (sanitized.route === "LLM_DIRECT") {
      return createRetrievedContext(query, options, sanitized, [], sanitized.embedding_input || query);
    }

    stage = "selección de estrategia";
    const created = await runtime.createStrategy(
      options.strategy,
      db,
      options.lancedb,
      options.ollama,
    );
    lanceDb = created.connectedLanceDb;

    stage = `retrieval:${options.strategy}`;
    const chunks = await created.strategy.retrieve(sanitized);

    stage = "agregación";
    const aggregator = new ContextAggregator();
    const aggregated = aggregator.aggregate(chunks);
    verbose(`[CLI] chunks recuperados: ${aggregated.length}`);

    const injector = new PromptInjector();
    const enrichedPrompt = injector.inject(query, aggregated);
    return createRetrievedContext(query, options, sanitized, aggregated, enrichedPrompt);
  } catch (err) {
    throw new PipelineStageError(stage, err);
  } finally {
    if (lanceDb) {
      try {
        await lanceDb.close();
      } catch (err) {
        writeStderr(`[CLI] Error cerrando LanceDB: ${formatError(err)}`);
      }
    }
    if (db) {
      try {
        db.close();
      } catch (err) {
        writeStderr(`[CLI] Error cerrando SQLite: ${formatError(err)}`);
      }
    }
  }
}

function createRetrievedContext(
  originalQuery: string,
  options: RetrieveCliOptions,
  sanitized: SanitizerOutput,
  chunks: RetrievedContext["chunks"],
  enrichedPrompt: string,
): RetrievedContext {
  return {
    id: createContextId(originalQuery),
    generatedAt: new Date().toISOString(),
    originalQuery,
    options: {
      strategy: options.strategy,
      db: options.db,
      lancedb: options.lancedb,
      ollama: options.ollama,
    },
    sanitized,
    chunks,
    enrichedPrompt,
  };
}

function renderContextMarkdown(context: RetrievedContext): string {
  const frontMatter = [
    "---",
    "lacoco_export_version: 1",
    `context_id: ${yamlString(context.id)}`,
    `question: ${yamlString(context.originalQuery)}`,
    `generated_at: ${yamlString(context.generatedAt)}`,
    `strategy: ${yamlString(context.options.strategy)}`,
    `route: ${yamlString(context.sanitized.route)}`,
    `intent: ${yamlString(context.sanitized.intent)}`,
    `confidence: ${context.sanitized.confidence}`,
    `dimensions: [${context.sanitized.dimensions.map(yamlString).join(", ")}]`,
    `chunks: ${context.chunks.length}`,
    "---",
    "",
  ].join("\n");

  const chunkSections = context.chunks.length === 0
    ? "No se recuperaron chunks para esta consulta.\n"
    : context.chunks.map((chunk, index) => [
      `### ${index + 1}. ${chunk.nodeId}`,
      "",
      `- Source: \`${chunk.source}\``,
      `- Score: \`${chunk.score.toFixed(4)}\``,
      "",
      fencedBlock(chunk.text),
    ].join("\n")).join("\n\n");

  return `${frontMatter}# LaCoCo Context Export

## Question

${context.originalQuery}

## Retrieval Metadata

| Field | Value |
|---|---|
| Context ID | \`${context.id}\` |
| Generated at | ${context.generatedAt} |
| Strategy | \`${context.options.strategy}\` |
| Route | \`${context.sanitized.route}\` |
| Intent | \`${context.sanitized.intent}\` |
| Confidence | \`${context.sanitized.confidence.toFixed(2)}\` |
| Dimensions | ${context.sanitized.dimensions.length > 0 ? context.sanitized.dimensions.map((dim) => `\`${dim}\``).join(", ") : "-"} |
| SQLite | \`${context.options.db}\` |
| LanceDB | \`${context.options.lancedb}\` |

## Clean Query

${fencedBlock(context.sanitized.clean_query || "(empty)")}

## Embedding Input

${fencedBlock(context.sanitized.embedding_input)}

## Enriched Prompt

${fencedBlock(context.enrichedPrompt)}

## Retrieved Chunks

${chunkSections}
`;
}

function createContextId(query: string): string {
  return crypto
    .createHash("sha256")
    .update(query.trim().replace(/\s+/g, " "))
    .digest("hex")
    .slice(0, 16);
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function fencedBlock(value: string): string {
  const fence = value.includes("```") ? "````" : "```";
  return `${fence}text\n${value}\n${fence}`;
}

class PipelineStageError extends Error {
  constructor(
    readonly stage: string,
    cause: unknown,
  ) {
    super(formatError(cause));
  }
}

async function createRecoveryStrategy(
  strategyName: string,
  db: LaCoCoDatabase,
  lanceDbPath: string,
  ollamaEndpoint: string,
): Promise<{ strategy: RecoveryStrategy; connectedLanceDb?: LaCoCoLanceDb }> {
  const needsLanceDb = ["hybrid", "ictd", "clcr", "rpr"].includes(strategyName);
  const lanceDb = needsLanceDb ? new LaCoCoLanceDb(lanceDbPath) : undefined;

  if (lanceDb) await lanceDb.connect();

  switch (strategyName) {
    case "hybrid":
      if (!lanceDb) throw new Error("LanceDB requerido para hybrid strategy");
      return { strategy: new HybridStrategy(db, lanceDb), connectedLanceDb: lanceDb };
    case "ictd":
      if (!lanceDb) throw new Error("LanceDB requerido para ictd strategy");
      return { strategy: new IctdStrategy(db, lanceDb), connectedLanceDb: lanceDb };
    case "clcr":
      if (!lanceDb) throw new Error("LanceDB requerido para clcr strategy");
      return { strategy: new ClcrStrategy(db, lanceDb), connectedLanceDb: lanceDb };
    case "rpr":
      if (!lanceDb) throw new Error("LanceDB requerido para rpr strategy");
      return { strategy: new RprStrategy(db, lanceDb), connectedLanceDb: lanceDb };
    case "agentic":
      return { strategy: new AgenticStrategy(db, ollamaEndpoint) };
    default:
      if (lanceDb) await lanceDb.close();
      throw new Error(`Estrategia no soportada: ${strategyName}`);
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ─────────────────────────────────────────────────────────────────────────────
// Comando: inspect <root-node>
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("inspect <root-node>")
  .description(
    "Visualiza el subgrafo alrededor de un nodo usando expansión BFS con budget."
  )
  .option("-d, --db <path>", "Ruta al archivo SQLite", "tensor.sqlite")
  .option("-b, --budget <num>", "Máximo de nodos a expandir", "75")
  .option("-f, --focus <dim>", "Prioridad dimensional: SYS, CPG, DTG, ALL", "ALL")
  .option("-o, --output <path>", "Archivo HTML de salida", "inspect.html")
  .option("--cdn", "Usar CDN para Cytoscape.js en vez de embeberlo", false)
  .action(async (rootNode: string, opts: {
    db: string;
    budget: string;
    focus: string;
    output: string;
    cdn: boolean;
  }) => {
    const budget = parseInt(opts.budget, 10);
    if (isNaN(budget) || budget < 1) {
      console.error("[CLI] ❌ --budget debe ser un número positivo.");
      process.exit(1);
    }
    const focus = ["SYS", "CPG", "DTG", "ALL"].includes(opts.focus)
      ? (opts.focus as "SYS" | "CPG" | "DTG" | "ALL")
      : "ALL";
    await inspect({
      rootNode,
      db: opts.db,
      budget,
      focus,
      output: opts.output,
      cdn: opts.cdn,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// Comando: inspect-query <prompt>
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("inspect-query <prompt>")
  .description(
    "Pipeline RAG completo → visualización del subgrafo recuperado para un prompt."
  )
  .option("-d, --db <path>", "Ruta al archivo SQLite", "tensor.sqlite")
  .option("-l, --lancedb <path>", "Ruta al directorio de LanceDB", "./lancedb")
  .option("-b, --budget <num>", "Máximo de nodos a expandir", "75")
  .option("-s, --strategy <name>", "Estrategia de recuperación (hybrid, agentic, ictd, clcr, rpr)", "hybrid")
  .option("-m, --mode <mode>", "Modo de visualización (default, tensor, scores)", "default")
  .option("-o, --output <path>", "Archivo HTML de salida", "inspect-query.html")
  .option("--cdn", "Usar CDN para Cytoscape.js en vez de embeberlo", false)
  .option("--ollama <url>", "Endpoint de Ollama", "http://localhost:11434")
  .action(async (prompt: string, opts: {
    db: string;
    lancedb: string;
    budget: string;
    strategy: string;
    mode: string;
    output: string;
    cdn: boolean;
    ollama: string;
  }) => {
    const budget = parseInt(opts.budget, 10);
    if (isNaN(budget) || budget < 1) {
      console.error("[CLI] ❌ --budget debe ser un número positivo.");
      process.exit(1);
    }
    const mode = ["default", "tensor", "scores"].includes(opts.mode)
      ? (opts.mode as "default" | "tensor" | "scores")
      : "default";
    await inspectQuery({
      prompt,
      db: opts.db,
      lancedb: opts.lancedb,
      budget,
      strategy: opts.strategy,
      mode,
      output: opts.output,
      cdn: opts.cdn,
      ollama: opts.ollama,
    });
  });

if (isMainModule()) {
  program.parseAsync(process.argv).catch((err: unknown) => {
    console.error("[CLI] Error fatal:", formatError(err));
    process.exit(1);
  });
}



// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function printBanner(tsconfig: string, dbPath: string, lanceDbPath: string): void {
  console.log("");
  console.log("┌──────────────────────────────────────────────────┐");
  console.log("│     tensor-extractor  ·  Grafo Multirrelacional   │");
  console.log("├──────────────────────────────────────────────────┤");
  console.log(`│  tsconfig : ${tsconfig.padEnd(37)}│`);
  console.log(`│  sqlite   : ${dbPath.padEnd(37)}│`);
  console.log(`│  lancedb  : ${lanceDbPath.padEnd(37)}│`);
  console.log("└──────────────────────────────────────────────────┘");
  console.log("");
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}

function projectPathFromTsconfig(tsconfigPath: string): string {
  return path.dirname(path.resolve(tsconfigPath));
}

interface WatchForegroundOptions {
  db: string;
  lancedb: string;
  verbose: boolean;
}

interface WatchCliOptions extends WatchForegroundOptions, JsonOption {
  foreground: boolean;
}

function runWatchCommand(
  action: string | undefined,
  project: string | undefined,
  options: WatchCliOptions,
): void {
  if (action === undefined || action === "list") {
    const projects = listProjects();
    if (options.json) {
      console.log(JSON.stringify(projects, null, 2));
      return;
    }
    console.log(formatProjectList(projects));
    return;
  }

  if (action === "status") {
    writeProjectResult(inspectProject(project ?? process.cwd()), options.json);
    return;
  }

  if (action === "start") {
    startManagedWatcher(project ?? process.cwd(), options);
    return;
  }

  if (action === "stop") {
    stopManagedWatcher(project ?? process.cwd(), options.json);
    return;
  }

  if (action === "restart") {
    stopManagedWatcher(project ?? process.cwd(), options.json, true);
    startManagedWatcher(project ?? process.cwd(), options);
    return;
  }

  if (looksLikeTsconfig(action)) {
    startForegroundWatcher(action, options);
    return;
  }

  throw new Error(`Acción watch no soportada: ${action}`);
}

function startManagedWatcher(target: string, options: WatchCliOptions): void {
  const project = resolveProjectForWatcher(target, options);
  const lock = acquireWatchLock(project.id);
  let launchAttempted = false;

  try {
    const current = inspectProject(project.id);

    if (current.watcher.status === "running") {
      throw new Error(`Ya existe un watcher activo para ${current.name} (pid ${current.watcher.pid})`);
    }

    const tsconfig = current.watcher.tsconfig;
    if (!tsconfig) throw new Error(`Proyecto sin tsconfig configurado: ${current.name}`);

    if (options.foreground) {
      startForegroundWatcher(tsconfig, options, current.id, lock);
      return;
    }

    markWatcherStarting(current.id);
    launchAttempted = true;
    const { command, childPid } = spawnDetachedWatcher(current, tsconfig, options);
    const updated = markWatcherRunning(current.id, childPid, command);
    if (options.json) {
      console.log(JSON.stringify(updated, null, 2));
      return;
    }
    console.log(`Watcher iniciado: ${updated.name} (pid ${childPid})`);
  } catch (err) {
    if (launchAttempted) markWatcherError(project.id);
    lock.release();
    throw err;
  } finally {
    if (!options.foreground) lock.release();
  }
}

function stopManagedWatcher(selector: string, json: boolean, quiet = false): void {
  const project = inspectProject(selector);

  if (project.watcher.status === "running" && project.watcher.pid !== null) {
    process.kill(project.watcher.pid, "SIGTERM");
  }

  const updated = markWatcherStopped(project.id);
  if (quiet) return;
  if (json) {
    console.log(JSON.stringify(updated, null, 2));
    return;
  }
  console.log(`Watcher detenido: ${updated.name}`);
}

function resolveProjectForWatcher(target: string, options: WatchForegroundOptions): ProjectRecord {
  if (looksLikeTsconfig(target)) {
    const projectPath = projectPathFromTsconfig(target);
    return configureProjectWatcher(projectPath, {
      tsconfig: target,
      dbPath: options.db,
      lanceDbPath: options.lancedb,
    });
  }

  const project = inspectProject(target);
  const tsconfig = project.watcher.tsconfig ?? inferTsconfig(project);
  return configureProjectWatcher(project.path, {
    tsconfig,
    dbPath: project.watcher.dbPath ?? options.db,
    lanceDbPath: project.watcher.lanceDbPath ?? options.lancedb,
  });
}

function inferTsconfig(project: ProjectRecord): string {
  const candidate = path.join(project.repoRoot, "tsconfig.json");
  if (!fs.existsSync(candidate)) {
    throw new Error(`No hay tsconfig configurado y no existe ${candidate}`);
  }
  return candidate;
}

function startForegroundWatcher(
  rutaTsconfig: string,
  options: WatchForegroundOptions,
  projectId?: string,
  existingLock?: WatchLock,
): void {
  printBanner(rutaTsconfig, options.db, options.lancedb);
  const project = configureProjectWatcher(projectPathFromTsconfig(rutaTsconfig), {
    tsconfig: rutaTsconfig,
    dbPath: options.db,
    lanceDbPath: options.lancedb,
  });
  const watcherProjectId = projectId ?? project.id;
  const lock = existingLock ?? acquireWatchLock(watcherProjectId);
  const current = inspectProject(watcherProjectId);

  if (
    current.watcher.status === "running" &&
    current.watcher.pid !== null &&
    current.watcher.pid !== process.pid
  ) {
    lock.release();
    throw new Error(`Ya existe un watcher activo para ${current.name} (pid ${current.watcher.pid})`);
  }

  markWatcherRunning(watcherProjectId, process.pid, process.argv);

  const db = new LaCoCoDatabase(options.db);

  const daemon = new DaemonManager({
    tsConfigFilePath: rutaTsconfig,
    db,
    verbose: options.verbose,
    indexEmbeddings: true,
    lanceDbPath: options.lancedb,
  });

  const shutdown = (): void => {
    console.log("\n[CLI] Señal de apagado recibida...");
    markWatcherStopped(watcherProjectId);
    lock.release();
    void daemon.stop().then(() => process.exit(0));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    daemon.start();
  } catch (err) {
    markWatcherError(watcherProjectId);
    lock.release();
    console.error(
      "[CLI] ❌ Error fatal durante el arranque:",
      err instanceof Error ? err.message : err
    );
    void daemon.stop().then(() => process.exit(1));
  }
}

function spawnDetachedWatcher(
  project: ProjectRecord,
  tsconfig: string,
  options: WatchForegroundOptions,
): { command: string[]; childPid: number } {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error("No se pudo resolver el entrypoint de la CLI");

  const command = buildWatchCommand(entrypoint, tsconfig, options);
  const logsDir = resolveProjectPath(project, String(project.config["paths.logs"] ?? ".lacoco/logs"));
  fs.mkdirSync(logsDir, { recursive: true });
  const out = fs.openSync(path.join(logsDir, "watcher.log"), "a");
  const err = fs.openSync(path.join(logsDir, "watcher.err.log"), "a");

  const [cmd, ...args] = command;
  if (!cmd) throw new Error("Comando de watcher inválido");

  const child = spawn(cmd, args, {
    cwd: project.path,
    detached: true,
    stdio: ["ignore", out, err],
    env: {
      ...process.env,
      LACOCO_WATCH_PROJECT_ID: project.id,
      LACOCO_WATCH_SKIP_LOCK: "1",
    },
  });

  fs.closeSync(out);
  fs.closeSync(err);

  if (!child.pid) throw new Error("No se pudo iniciar el proceso watcher");
  child.unref();
  return { command, childPid: child.pid };
}

function buildWatchCommand(
  entrypoint: string,
  tsconfig: string,
  options: WatchForegroundOptions,
): string[] {
  const args = [
    "_watch-foreground",
    tsconfig,
    "--db",
    options.db,
    "--lancedb",
    options.lancedb,
  ];
  if (options.verbose) args.push("--verbose");

  if (entrypoint.endsWith(".ts")) {
    return [process.execPath, "--import", "tsx", entrypoint, ...args];
  }
  return [process.execPath, entrypoint, ...args];
}

function resolveProjectPath(project: ProjectRecord, maybeRelativePath: string): string {
  return path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.join(project.path, maybeRelativePath);
}

function looksLikeTsconfig(value: string): boolean {
  return value.endsWith(".json") || value.includes("/") || value.includes("\\");
}

function noopWatchLock(): WatchLock {
  return {
    path: "",
    release: () => {},
  };
}

interface JsonOption {
  json: boolean;
}

interface ConfigScopeOptions extends JsonOption {
  global: boolean;
  local: boolean;
}

function runCliCommand(action: () => void | Promise<void>): void {
  Promise.resolve()
    .then(action)
    .catch((err: unknown) => {
      console.error(formatError(err));
      process.exitCode = 1;
    });
}

function resolveWritableScope(options: ConfigScopeOptions): WritableConfigScope {
  if (options.global && options.local) {
    throw new Error("Usa solo uno de --global o --local");
  }
  return options.global ? "global" : "local";
}

function writeProjectResult(project: ProjectRecord, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(project, null, 2));
    return;
  }

  console.log(formatTable(
    ["FIELD", "VALUE"],
    [
      ["id", project.id],
      ["name", project.name],
      ["path", project.path],
      ["repoRoot", project.repoRoot],
      ["registeredAt", project.registeredAt],
      ["lastIndexedAt", project.lastIndexedAt ?? "-"],
      ["lastIndexStatus", project.lastIndexStatus],
      ["watcherStatus", project.watcher.status],
      ["watcherPid", project.watcher.pid === null ? "-" : String(project.watcher.pid)],
    ],
  ));
}

function formatProjectList(projects: ProjectRecord[]): string {
  if (projects.length === 0) return "No hay proyectos registrados.";

  return formatTable(
    ["PROJECT", "STATUS", "PID", "PATH"],
    projects.map((project) => [
      project.name,
      project.watcher.status,
      project.watcher.pid === null ? "-" : String(project.watcher.pid),
      project.path,
    ]),
  );
}

function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(
      header.length,
      ...rows.map((row) => row[column]?.length ?? 0),
    ),
  );

  const formatRow = (row: string[]) =>
    row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();

  return [
    formatRow(headers),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(formatRow),
  ].join("\n");
}
