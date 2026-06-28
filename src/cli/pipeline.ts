import crypto from "node:crypto";
import path from "node:path";
import { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { AgentIntermediary1 } from "../retriever/utilities/mini-agents/agent-intermediary/index.js";
import { SlmClassifier } from "../retriever/utilities/mini-agents/agent-intermediary/classifier.js";
import { ContextAggregator } from "../retriever/utilities/filters/context-aggregator.js";
import { PromptInjector } from "../retriever/utilities/filters/prompt-injector.js";
import { getStrategyEntry, STRATEGY_NAMES } from "../retriever/strategies/registry.js";
import type { RecoveryStrategy } from "../retriever/models/strategies/types.js";
import type { SanitizerOutput } from "../retriever/models/utilities/types.js";
import type { LlmClient } from "../slms/llm-client.js";
import { OllamaService } from "../slms/ollama-service.js";
import { resolveConfig } from "./state/config-store.js";
import { writeTextFileAtomic } from "./state/json-store.js";
import { inspectProject } from "./state/project-registry.js";
import { resolveDbPath, resolveLanceDbPath } from "./storage-paths.js";

export interface JsonOption { json: boolean; }

export interface RetrieveCliOptions {
  strategy?: string;
  ollama?: string;
  verbose: boolean;
  json?: boolean;
}

export interface ContextExportCliOptions extends Omit<RetrieveCliOptions, "json">, JsonOption {
  output: string;
}

type ResolvedRetrieveCliOptions = RetrieveCliOptions & {
  db: string;
  lancedb: string;
  strategy: string;
  ollama: string;
};

export interface CliStreams {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
}

export interface RetrieveIntermediary {
  sanitize(prompt: string): Promise<SanitizerOutput>;
}

export interface RetrieveRuntime {
  createDatabase(dbPath: string): LaCoCoDatabase;
  createOllama(endpoint: string): LlmClient;
  createIntermediary(ollama: LlmClient): RetrieveIntermediary;
  createStrategy(
    strategyName: string,
    db: LaCoCoDatabase,
    lanceDbPath: string,
    ollamaEndpoint: string,
    ollamaTimeoutMs?: number,
    ollama?: LlmClient,
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

export interface RetrieveJsonSuccess {
  schemaVersion: 1;
  ok: true;
  contextId: string;
  generatedAt: string;
  query: string;
  strategy: string;
  route: SanitizerOutput["route"];
  classification: {
    intent: SanitizerOutput["intent"];
    confidence: number;
    dimensions: SanitizerOutput["dimensions"];
    cleanQuery: string;
    embeddingInput: string;
  };
  retrieval: {
    chunkCount: number;
    chunks: RetrievedContext["chunks"];
  };
  storage: {
    sqlite: string;
    lancedb: string;
  };
  enrichedPrompt: string;
}

export interface RetrieveJsonFailure {
  schemaVersion: 1;
  ok: false;
  error: {
    stage: string;
    message: string;
  };
}

export type RetrieveJsonResult = RetrieveJsonSuccess | RetrieveJsonFailure;

const defaultRetrieveRuntime: RetrieveRuntime = {
  createDatabase: (dbPath) => new LaCoCoDatabase(dbPath),
  createOllama: (endpoint) =>
    new OllamaService(endpoint, resolveStringConfig("agent.model"), resolveNumberConfig("timeout.ms")),
  createIntermediary: (ollama) =>
    new AgentIntermediary1(new SlmClassifier(ollama)),
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
  project?: string,
): Promise<number> {
  const writeStdout = (message: string): void => {
    streams.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
  };
  const writeStderr = (message: string): void => {
    streams.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };

  try {
    const resolvedOptions = resolveRetrieveOptions(options, project);
    const context = await retrieveContext(query, resolvedOptions, streams, runtime);

    writeStdout(options.json
      ? JSON.stringify(createRetrieveJsonSuccess(context), null, 2)
      : context.enrichedPrompt);

    if (resolvedOptions.verbose) writeStderr("[CLI] retrieve completado");
    return 0;
  } catch (err) {
    const stage = err instanceof PipelineStageError ? err.stage : "inicialización";
    const message = formatError(err);
    if (options.json) {
      writeStdout(JSON.stringify(createRetrieveJsonFailure(stage, message), null, 2));
    }
    writeStderr(`[CLI] Error en pipeline RAG (${stage}): ${message}`);
    return 1;
  }
}

function createRetrieveJsonSuccess(
  context: RetrievedContext,
): RetrieveJsonSuccess {
  return {
    schemaVersion: 1,
    ok: true,
    contextId: context.id,
    generatedAt: context.generatedAt,
    query: context.originalQuery,
    strategy: context.options.strategy,
    route: context.sanitized.route,
    classification: {
      intent: context.sanitized.intent,
      confidence: context.sanitized.confidence,
      dimensions: context.sanitized.dimensions,
      cleanQuery: context.sanitized.clean_query,
      embeddingInput: context.sanitized.embedding_input,
    },
    retrieval: {
      chunkCount: context.chunks.length,
      chunks: context.chunks,
    },
    storage: {
      sqlite: context.options.db,
      lancedb: context.options.lancedb,
    },
    enrichedPrompt: context.enrichedPrompt,
  };
}

function createRetrieveJsonFailure(stage: string, message: string): RetrieveJsonFailure {
  return {
    schemaVersion: 1,
    ok: false,
    error: { stage, message },
  };
}

export async function runContextExport(
  query: string,
  options: ContextExportCliOptions,
  streams: CliStreams = { stdout: process.stdout, stderr: process.stderr },
  runtime: RetrieveRuntime = defaultRetrieveRuntime,
  project?: string,
): Promise<number> {
  const writeStdout = (message: string): void => {
    streams.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
  };
  const writeStderr = (message: string): void => {
    streams.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };

  try {
    const resolvedOptions = resolveRetrieveOptions(options, project);
    const context = await retrieveContext(query, resolvedOptions, streams, runtime);
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

function resolveRetrieveOptions(options: RetrieveCliOptions, project?: string): ResolvedRetrieveCliOptions {
  const projectPath = resolveRetrieveProjectPath(project);
  return {
    ...options,
    db: resolveDbPath(projectPath),
    lancedb: resolveLanceDbPath(projectPath),
    strategy: options.strategy ?? resolveStringConfig("strategy.default"),
    ollama: options.ollama ?? resolveStringConfig("agent.endpoint"),
  };
}

function resolveRetrieveProjectPath(project?: string): string {
  if (!project) return process.cwd();
  try {
    const record = inspectProject(project);
    return record.path;
  } catch {
    return project;
  }
}

function resolveStringConfig(key: string): string {
  const entry = resolveConfig(key);
  if (typeof entry.value !== "string") {
    throw new Error(`La configuración ${key} debe ser string`);
  }
  return entry.value;
}

function resolveNumberConfig(key: string): number {
  const entry = resolveConfig(key);
  if (typeof entry.value !== "number") {
    throw new Error(`La configuración ${key} debe ser number`);
  }
  return entry.value;
}

async function retrieveContext(
  query: string,
  options: ResolvedRetrieveCliOptions,
  streams: CliStreams,
  runtime: RetrieveRuntime,
): Promise<RetrievedContext> {
  let stage = "inicialización";
  let db: LaCoCoDatabase | undefined;
  let lanceDb: LaCoCoLanceDb | undefined;
  let ollama: LlmClient | undefined;

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
    ollama = runtime.createOllama(options.ollama);

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
      resolveNumberConfig("timeout.ms"),
      ollama,
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
    ollama?.abort();
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
  options: ResolvedRetrieveCliOptions,
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
  ollamaTimeoutMs?: number,
  ollama?: LlmClient,
): Promise<{ strategy: RecoveryStrategy; connectedLanceDb?: LaCoCoLanceDb }> {
  let lanceDb: LaCoCoLanceDb | undefined;

  try {
    const entry = getStrategyEntry(strategyName);
    lanceDb = entry.needsLanceDb ? new LaCoCoLanceDb(lanceDbPath) : undefined;
    if (lanceDb) await lanceDb.connect();
    const deps = {
      db,
      ollamaEndpoint,
      ollama: ollama ?? new OllamaService(
        ollamaEndpoint,
        resolveStringConfig("agent.model"),
        ollamaTimeoutMs,
      ),
      ...(lanceDb ? { lanceDb } : {}),
      ...(ollamaTimeoutMs !== undefined ? { ollamaTimeoutMs } : {}),
    };

    return {
      strategy: entry.create(deps),
      ...(lanceDb ? { connectedLanceDb: lanceDb } : {}),
    };
  } catch (error) {
    if (lanceDb) await lanceDb.close();
    throw error;
  }
}

export function strategyHelp(): string {
  return `Estrategia de recuperación (${STRATEGY_NAMES.join(", ")}); por defecto strategy.default`;
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
