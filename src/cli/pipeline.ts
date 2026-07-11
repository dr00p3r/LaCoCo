import crypto from "node:crypto";
import path from "node:path";
import { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import {
  ContextAggregator,
  DEFAULT_CONTEXT_MAX_TOKENS,
} from "../retriever/utilities/filters/context-aggregator.js";
import { renderContextBlock } from "../retriever/utilities/filters/prompt-injector.js";
import {
  getEffectiveStrategyParameters,
  getStrategyEntry,
  STRATEGY_NAMES,
  type StrategyParameters,
  type StrategyRuntimeOptions,
} from "../retriever/strategies/registry.js";
import type { RecoveryStrategy } from "../retriever/models/strategies/types.js";
import type { IntentTag, SanitizerOutput } from "../retriever/models/utilities/types.js";
import type { LlmClient } from "../slms/llm-client.js";
import { OllamaService } from "../slms/ollama-service.js";
import { DIMENSIONS, type Dimension } from "../domain/dimensions.js";
import { resolveConfig } from "./state/config-store.js";
import { writeTextFileAtomic } from "./state/json-store.js";
import { inspectProject } from "./state/project-registry.js";
import { resolveDbPath, resolveLanceDbPath } from "./storage-paths.js";

export interface JsonOption { json: boolean; }

export interface RetrieveCliOptions {
  strategy?: string;
  verbose: boolean;
  json?: boolean;
  chunks?: number;
  maxTokens?: number;
}

export interface ContextExportCliOptions extends Omit<RetrieveCliOptions, "json">, JsonOption {
  output: string;
}

export interface StructuredRetrieveInput {
  schemaVersion: 1;
  originalPrompt: string;
  clean_query: string;
  embedding_input: string;
  intent: IntentTag;
  dimensions: Dimension[];
  confidence: number;
  strategy?: string;
  chunks?: number;
  maxTokens?: number;
}

type ResolvedRetrieveCliOptions = RetrieveCliOptions & {
  db: string;
  lancedb: string;
  strategy: string;
  maxTokens: number;
};

export interface CliStreams {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
}

export interface RetrieveRuntime {
  createDatabase(dbPath: string): LaCoCoDatabase;
  createStrategy(
    strategyName: string,
    db: LaCoCoDatabase,
    lanceDbPath: string,
    strategyOptions?: StrategyRuntimeOptions,
  ): Promise<{ strategy: RecoveryStrategy; connectedLanceDb?: LaCoCoLanceDb; ollama?: LlmClient }>;
}

interface RetrievedContext {
  id: string;
  generatedAt: string;
  originalPrompt: string;
  options: {
    strategy: string;
    db: string;
    lancedb: string;
    strategyParameters: StrategyParameters;
    maxTokens: number;
  };
  structuredQuery: SanitizerOutput;
  chunks: ReturnType<ContextAggregator["aggregate"]>;
  contextBlock: string;
}

export interface RetrieveJsonSuccess {
  schemaVersion: 3;
  ok: true;
  contextId: string;
  generatedAt: string;
  originalPrompt: string;
  strategy: string;
  query: {
    cleanQuery: string;
    embeddingInput: string;
    intent: IntentTag;
    dimensions: Dimension[];
    confidence: number;
  };
  retrieval: {
    chunkCount: number;
    chunks: RetrievedContext["chunks"];
    strategyParameters: StrategyParameters;
    maxTokens: number;
  };
  storage: {
    sqlite: string;
    lancedb: string;
  };
  contextBlock: string;
}

export interface RetrieveJsonFailure {
  schemaVersion: 3;
  ok: false;
  error: {
    stage: string;
    message: string;
  };
}

export type RetrieveJsonResult = RetrieveJsonSuccess | RetrieveJsonFailure;

const INTENTS: readonly IntentTag[] = [
  "understand",
  "refactor",
  "create",
  "debug",
  "integrate",
  "unknown",
];

const defaultRetrieveRuntime: RetrieveRuntime = {
  createDatabase: (dbPath) => new LaCoCoDatabase(dbPath),
  createStrategy: createRecoveryStrategy,
};

/**
 * Ejecuta `lacoco retrieve` con una query estructurada producida por el agente.
 *
 * LaCoCo ya no sanitiza ni clasifica el prompt: el agente externo decide cuándo
 * llamar a retrieval y entrega clean_query/embedding_input/intent/dimensions.
 */
export async function runRetrieve(
  structuredInputJson: string,
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
    const structuredInput = parseStructuredRetrieveInput(structuredInputJson);
    const resolvedOptions = resolveRetrieveOptions(options, structuredInput, project);
    const context = await retrieveContext(structuredInput, resolvedOptions, streams, runtime);

    writeStdout(options.json
      ? JSON.stringify(createRetrieveJsonSuccess(context), null, 2)
      : context.contextBlock);

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
    schemaVersion: 3,
    ok: true,
    contextId: context.id,
    generatedAt: context.generatedAt,
    originalPrompt: context.originalPrompt,
    strategy: context.options.strategy,
    query: {
      intent: context.structuredQuery.intent,
      confidence: context.structuredQuery.confidence,
      dimensions: context.structuredQuery.dimensions,
      cleanQuery: context.structuredQuery.clean_query,
      embeddingInput: context.structuredQuery.embedding_input,
    },
    retrieval: {
      chunkCount: context.chunks.length,
      chunks: context.chunks,
      strategyParameters: context.options.strategyParameters,
      maxTokens: context.options.maxTokens,
    },
    storage: {
      sqlite: context.options.db,
      lancedb: context.options.lancedb,
    },
    contextBlock: context.contextBlock,
  };
}

function createRetrieveJsonFailure(stage: string, message: string): RetrieveJsonFailure {
  return {
    schemaVersion: 3,
    ok: false,
    error: { stage, message },
  };
}

export async function runContextExport(
  structuredInputJson: string,
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
    const structuredInput = parseStructuredRetrieveInput(structuredInputJson);
    const resolvedOptions = resolveRetrieveOptions(options, structuredInput, project);
    const context = await retrieveContext(structuredInput, resolvedOptions, streams, runtime);
    const markdown = renderContextMarkdown(context);
    const outputPath = path.resolve(options.output);
    writeTextFileAtomic(outputPath, markdown);

    if (options.json) {
      writeStdout(JSON.stringify({
        id: context.id,
        output: outputPath,
        originalPrompt: context.originalPrompt,
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

export function parseStructuredRetrieveInput(raw: string): StructuredRetrieveInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new PipelineStageError("entrada estructurada", new Error("stdin debe contener JSON válido", {
      cause: err instanceof Error ? err : undefined,
    }));
  }

  if (!isRecord(parsed)) throw new PipelineStageError("entrada estructurada", "stdin debe contener un objeto JSON");
  if (parsed.schemaVersion !== 1) throw new PipelineStageError("entrada estructurada", "schemaVersion debe ser 1");

  const originalPrompt = requiredString(parsed, "originalPrompt");
  const cleanQuery = requiredString(parsed, "clean_query");
  const embeddingInput = requiredString(parsed, "embedding_input");
  const intent = requiredIntent(parsed.intent);
  const dimensions = requiredDimensions(parsed.dimensions);
  const confidence = requiredConfidence(parsed.confidence);
  const strategy = optionalString(parsed, "strategy");
  const chunks = optionalPositiveInteger(parsed, "chunks");
  const maxTokens = optionalPositiveInteger(parsed, "maxTokens");

  return {
    schemaVersion: 1,
    originalPrompt,
    clean_query: cleanQuery,
    embedding_input: embeddingInput,
    intent,
    dimensions,
    confidence,
    ...(strategy === undefined ? {} : { strategy }),
    ...(chunks === undefined ? {} : { chunks }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
  };
}

function resolveRetrieveOptions(
  options: RetrieveCliOptions,
  input: StructuredRetrieveInput,
  project?: string,
): ResolvedRetrieveCliOptions {
  const projectPath = resolveRetrieveProjectPath(project);
  const strategyName = options.strategy ?? input.strategy ?? resolveStringConfig("strategy.default");
  const entry = getStrategyEntry(strategyName);
  const chunks = options.chunks ?? input.chunks;
  const strategyOptions = chunks === undefined ? {} : { chunks };
  getEffectiveStrategyParameters(entry.name, strategyOptions);
  const maxTokens = options.maxTokens ?? input.maxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("maxTokens debe ser un entero positivo");
  }
  return {
    ...options,
    db: resolveDbPath(projectPath),
    lancedb: resolveLanceDbPath(projectPath),
    strategy: entry.name,
    maxTokens,
    ...(chunks === undefined ? {} : { chunks }),
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
  input: StructuredRetrieveInput,
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

  const structuredQuery: SanitizerOutput = {
    route: "RAG",
    clean_query: input.clean_query,
    embedding_input: input.embedding_input,
    dimensions: input.dimensions,
    intent: input.intent,
    confidence: input.confidence,
  };

  try {
    verbose(`[CLI] retrieve: strategy=${options.strategy} db=${options.db}`);

    stage = "SQLite";
    db = runtime.createDatabase(options.db);

    stage = "selección de estrategia";
    const created = await runtime.createStrategy(
      options.strategy,
      db,
      options.lancedb,
      options.chunks === undefined ? {} : { chunks: options.chunks },
    );
    lanceDb = created.connectedLanceDb;
    ollama = created.ollama;

    stage = `retrieval:${options.strategy}`;
    const chunks = await created.strategy.retrieve(structuredQuery);

    stage = "agregación";
    const aggregator = new ContextAggregator();
    const aggregated = aggregator.aggregate(chunks, options.maxTokens);
    verbose(`[CLI] chunks recuperados: ${aggregated.length}`);

    const contextBlock = renderContextBlock(aggregated);
    return createRetrievedContext(
      input.originalPrompt,
      options,
      structuredQuery,
      aggregated,
      contextBlock,
    );
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
  originalPrompt: string,
  options: ResolvedRetrieveCliOptions,
  structuredQuery: SanitizerOutput,
  chunks: RetrievedContext["chunks"],
  contextBlock: string,
): RetrievedContext {
  return {
    id: createContextId(originalPrompt, structuredQuery),
    generatedAt: new Date().toISOString(),
    originalPrompt,
    options: {
      strategy: options.strategy,
      db: options.db,
      lancedb: options.lancedb,
      strategyParameters: getEffectiveStrategyParameters(
        options.strategy as (typeof STRATEGY_NAMES)[number],
        options.chunks === undefined ? {} : { chunks: options.chunks },
      ),
      maxTokens: options.maxTokens,
    },
    structuredQuery,
    chunks,
    contextBlock,
  };
}

function renderContextMarkdown(context: RetrievedContext): string {
  const frontMatter = [
    "---",
    "lacoco_export_version: 2",
    `context_id: ${yamlString(context.id)}`,
    `question: ${yamlString(context.originalPrompt)}`,
    `generated_at: ${yamlString(context.generatedAt)}`,
    `strategy: ${yamlString(context.options.strategy)}`,
    `intent: ${yamlString(context.structuredQuery.intent)}`,
    `confidence: ${context.structuredQuery.confidence}`,
    `dimensions: [${context.structuredQuery.dimensions.map(yamlString).join(", ")}]`,
    `chunks: ${context.chunks.length}`,
    `max_tokens: ${context.options.maxTokens}`,
    `strategy_parameters: ${yamlString(JSON.stringify(context.options.strategyParameters))}`,
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

${context.originalPrompt}

## Retrieval Metadata

| Field | Value |
|---|---|
| Context ID | \`${context.id}\` |
| Generated at | ${context.generatedAt} |
| Strategy | \`${context.options.strategy}\` |
| Intent | \`${context.structuredQuery.intent}\` |
| Confidence | \`${context.structuredQuery.confidence.toFixed(2)}\` |
| Dimensions | ${context.structuredQuery.dimensions.length > 0 ? context.structuredQuery.dimensions.map((dim) => `\`${dim}\``).join(", ") : "-"} |
| Strategy parameters | \`${JSON.stringify(context.options.strategyParameters)}\` |
| Max tokens | \`${context.options.maxTokens}\` |
| SQLite | \`${context.options.db}\` |
| LanceDB | \`${context.options.lancedb}\` |

## Clean Query

${fencedBlock(context.structuredQuery.clean_query || "(empty)")}

## Embedding Input

${fencedBlock(context.structuredQuery.embedding_input)}

## Context Block

${fencedBlock(context.contextBlock)}

## Retrieved Chunks

${chunkSections}
`;
}

function createContextId(originalPrompt: string, query: SanitizerOutput): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify({
      originalPrompt: originalPrompt.trim().replace(/\s+/g, " "),
      clean_query: query.clean_query,
      embedding_input: query.embedding_input,
      intent: query.intent,
      dimensions: query.dimensions,
    }))
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
  strategyOptions: StrategyRuntimeOptions = {},
): Promise<{ strategy: RecoveryStrategy; connectedLanceDb?: LaCoCoLanceDb; ollama?: LlmClient }> {
  let lanceDb: LaCoCoLanceDb | undefined;
  let ollama: LlmClient | undefined;

  try {
    const entry = getStrategyEntry(strategyName);
    lanceDb = entry.needsLanceDb ? new LaCoCoLanceDb(lanceDbPath) : undefined;
    if (lanceDb) await lanceDb.connect();
    if (strategyName === "agentic") {
      ollama = new OllamaService(
        resolveStringConfig("agent.endpoint"),
        resolveStringConfig("agent.model"),
        resolveNumberConfig("timeout.ms"),
      );
    }
    return {
      strategy: entry.create({
        db,
        ollamaEndpoint: resolveStringConfig("agent.endpoint"),
        ...(ollama ? { ollama } : {}),
        ...(lanceDb ? { lanceDb } : {}),
        ollamaTimeoutMs: resolveNumberConfig("timeout.ms"),
      }, strategyOptions),
      ...(lanceDb ? { connectedLanceDb: lanceDb } : {}),
      ...(ollama ? { ollama } : {}),
    };
  } catch (error) {
    ollama?.abort();
    if (lanceDb) await lanceDb.close();
    throw error;
  }
}

export function strategyHelp(): string {
  return `Estrategia de recuperación (${STRATEGY_NAMES.join(", ")}); por defecto strategy.default`;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PipelineStageError("entrada estructurada", `${key} debe ser un string no vacío`);
  }
  return value;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PipelineStageError("entrada estructurada", `${key} debe ser un string no vacío`);
  }
  return value;
}

function optionalPositiveInteger(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new PipelineStageError("entrada estructurada", `${key} debe ser un entero positivo`);
  }
  return value;
}

function requiredIntent(value: unknown): IntentTag {
  if (!INTENTS.includes(value as IntentTag)) {
    throw new PipelineStageError("entrada estructurada", `intent debe ser uno de: ${INTENTS.join(", ")}`);
  }
  return value as IntentTag;
}

function requiredDimensions(value: unknown): Dimension[] {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > DIMENSIONS.length ||
    new Set(value).size !== value.length ||
    value.some((dimension) => !DIMENSIONS.includes(dimension as Dimension))
  ) {
    throw new PipelineStageError("entrada estructurada", `dimensions debe contener valores únicos de: ${DIMENSIONS.join(", ")}`);
  }
  return value as Dimension[];
}

function requiredConfidence(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 1
  ) {
    throw new PipelineStageError("entrada estructurada", "confidence debe ser un número entre 0 y 1");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
