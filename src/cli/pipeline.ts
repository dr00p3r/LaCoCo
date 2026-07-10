import crypto from "node:crypto";
import path from "node:path";
import { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { AgentIntermediary1 } from "../retriever/utilities/mini-agents/agent-intermediary/index.js";
import { SlmClassifier } from "../retriever/utilities/mini-agents/agent-intermediary/classifier.js";
import {
  ContextAggregator,
  DEFAULT_CONTEXT_MAX_TOKENS,
} from "../retriever/utilities/filters/context-aggregator.js";
import { PromptInjector } from "../retriever/utilities/filters/prompt-injector.js";
import {
  getEffectiveStrategyParameters,
  getStrategyEntry,
  STRATEGY_NAMES,
  type StrategyParameters,
  type StrategyRuntimeOptions,
} from "../retriever/strategies/registry.js";
import type { RecoveryStrategy } from "../retriever/models/strategies/types.js";
import type { SanitizerOutput } from "../retriever/models/utilities/types.js";
import type { LlmClient } from "../slms/llm-client.js";
import { OllamaService } from "../slms/ollama-service.js";
import { SemanticProfileStore } from "../semantic-profile/semantic-profile-store.js";
import { QueryGrounder } from "../semantic-profile/query-grounder.js";
import type {
  GroundingDiagnostics,
  QueryGrounding,
} from "../semantic-profile/types.js";
import type { DetailedClassification } from "../retriever/utilities/mini-agents/agent-intermediary/classifier.js";
import { applyHyde } from "../retriever/utilities/mini-agents/agent-intermediary/hyde-generator.js";
import { resolveConfig } from "./state/config-store.js";
import { resolveHydeModel, resolveIntermediaryModel } from "./config.js";
import { writeTextFileAtomic } from "./state/json-store.js";
import { inspectProject } from "./state/project-registry.js";
import { resolveDbPath, resolveLanceDbPath } from "./storage-paths.js";

export interface JsonOption { json: boolean; }

export interface RetrieveCliOptions {
  strategy?: string;
  ollama?: string;
  verbose: boolean;
  json?: boolean;
  chunks?: number;
  maxTokens?: number;
  grounding?: boolean;
}

export interface ContextExportCliOptions extends Omit<RetrieveCliOptions, "json">, JsonOption {
  output: string;
}

type ResolvedRetrieveCliOptions = RetrieveCliOptions & {
  db: string;
  lancedb: string;
  strategy: string;
  ollama: string;
  maxTokens: number;
  grounding: boolean;
};

export interface CliStreams {
  stdout: Pick<NodeJS.WritableStream, "write">;
  stderr: Pick<NodeJS.WritableStream, "write">;
}

export interface RetrieveIntermediary {
  sanitize(prompt: string, grounding?: QueryGrounding): Promise<SanitizerOutput>;
  sanitizeDetailed?(prompt: string, grounding?: QueryGrounding): Promise<DetailedClassification>;
}

export interface RetrieveRuntime {
  createDatabase(dbPath: string): LaCoCoDatabase;
  createOllama(endpoint: string): LlmClient;
  createIntermediary(ollama: LlmClient, endpoint: string, timeoutMs: number): RetrieveIntermediary;
  createStrategy(
    strategyName: string,
    db: LaCoCoDatabase,
    lanceDbPath: string,
    ollamaEndpoint: string,
    ollamaTimeoutMs?: number,
    ollama?: LlmClient,
    strategyOptions?: StrategyRuntimeOptions,
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
    strategyParameters: StrategyParameters;
    maxTokens: number;
  };
  sanitized: SanitizerOutput;
  grounding: GroundingDiagnostics;
  chunks: ReturnType<ContextAggregator["aggregate"]>;
  enrichedPrompt: string;
}

export interface RetrieveJsonSuccess {
  schemaVersion: 2;
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
  grounding: GroundingDiagnostics;
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
  enrichedPrompt: string;
}

export interface RetrieveJsonFailure {
  schemaVersion: 2;
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
  // El clasificador puede usar un modelo distinto al de generación vía
  // intermediary.model (vacío = hereda agent.model → reutiliza el mismo cliente).
  createIntermediary: (ollama, endpoint, timeoutMs) => {
    const model = resolveIntermediaryModel();
    const client = model === resolveStringConfig("agent.model")
      ? ollama
      : new OllamaService(endpoint, model, timeoutMs);
    return new AgentIntermediary1(new SlmClassifier(client));
  },
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
    schemaVersion: 2,
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
    grounding: context.grounding,
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
    enrichedPrompt: context.enrichedPrompt,
  };
}

function createRetrieveJsonFailure(stage: string, message: string): RetrieveJsonFailure {
  return {
    schemaVersion: 2,
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
  const entry = getStrategyEntry(options.strategy ?? resolveStringConfig("strategy.default"));
  const strategyOptions = options.chunks === undefined ? {} : { chunks: options.chunks };
  getEffectiveStrategyParameters(entry.name, strategyOptions);
  const maxTokens = options.maxTokens ?? DEFAULT_CONTEXT_MAX_TOKENS;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new Error("maxTokens debe ser un entero positivo");
  }
  return {
    ...options,
    db: resolveDbPath(projectPath),
    lancedb: resolveLanceDbPath(projectPath),
    strategy: entry.name,
    ollama: options.ollama ?? resolveStringConfig("agent.endpoint"),
    maxTokens,
    grounding: options.grounding ?? resolveBooleanConfig("profile.groundingEnabled"),
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

    let grounding: QueryGrounding | undefined;
    if (options.grounding) {
      stage = "query grounding";
      grounding = new QueryGrounder(new SemanticProfileStore(db.getRawDb())).ground(query);
    }

    stage = "intermediario";
    const intermediary = runtime.createIntermediary(ollama, options.ollama, resolveNumberConfig("timeout.ms"));
    let detailed: DetailedClassification | undefined;
    let sanitized: SanitizerOutput;
    if (grounding) {
      if (!intermediary.sanitizeDetailed) {
        throw new Error("El intermediario configurado no soporta grounding detallado");
      }
      detailed = await intermediary.sanitizeDetailed(query, grounding);
      sanitized = detailed.output;
    } else {
      sanitized = await intermediary.sanitize(query);
    }
    const groundingDiagnostics = createGroundingDiagnostics(grounding, detailed);

    verbose(
      `[CLI] intermediario: route=${sanitized.route} intent=${sanitized.intent} ` +
        `confidence=${sanitized.confidence.toFixed(2)} clean_query=${JSON.stringify(sanitized.clean_query)}`,
    );

    if (sanitized.route === "LLM_DIRECT") {
      return createRetrievedContext(
        query,
        options,
        sanitized,
        groundingDiagnostics,
        [],
        sanitized.embedding_input || query,
      );
    }

    if (resolveBooleanConfig("hyde.enabled")) {
      stage = "HyDE";
      const hydeModel = resolveHydeModel();
      const hydeClient = hydeModel === resolveStringConfig("agent.model")
        ? ollama
        : new OllamaService(options.ollama, hydeModel, resolveNumberConfig("timeout.ms"));
      const hydeMode = resolveStringConfig("hyde.mode") === "concat" ? "concat" : "replace";
      const outcome = await applyHyde(sanitized, query, hydeClient, hydeMode);
      if (outcome.error) {
        verbose(`[CLI] HyDE falló (${outcome.error}); se usa embedding_input original`);
      } else if (outcome.applied) {
        verbose(`[CLI] HyDE: embedding_input reescrito por ${hydeModel}`);
      }
      sanitized = outcome.sanitizer;
      if (hydeClient !== ollama) hydeClient.abort();
    }

    stage = "selección de estrategia";
    const created = await runtime.createStrategy(
      options.strategy,
      db,
      options.lancedb,
      options.ollama,
      resolveNumberConfig("timeout.ms"),
      ollama,
      options.chunks === undefined ? {} : { chunks: options.chunks },
    );
    lanceDb = created.connectedLanceDb;

    stage = `retrieval:${options.strategy}`;
    const chunks = await created.strategy.retrieve(sanitized);

    stage = "agregación";
    const aggregator = new ContextAggregator();
    const aggregated = aggregator.aggregate(chunks, options.maxTokens);
    verbose(`[CLI] chunks recuperados: ${aggregated.length}`);

    const injector = new PromptInjector();
    const enrichedPrompt = injector.inject(query, aggregated);
    return createRetrievedContext(
      query,
      options,
      sanitized,
      groundingDiagnostics,
      aggregated,
      enrichedPrompt,
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
  originalQuery: string,
  options: ResolvedRetrieveCliOptions,
  sanitized: SanitizerOutput,
  grounding: GroundingDiagnostics,
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
      strategyParameters: getEffectiveStrategyParameters(
        options.strategy as (typeof STRATEGY_NAMES)[number],
        options.chunks === undefined ? {} : { chunks: options.chunks },
      ),
      maxTokens: options.maxTokens,
    },
    sanitized,
    grounding,
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
| Strategy parameters | \`${JSON.stringify(context.options.strategyParameters)}\` |
| Max tokens | \`${context.options.maxTokens}\` |
| Grounding | \`${context.grounding.enabled}\` |
| Semantic profile build | ${context.grounding.profileBuildId ? `\`${context.grounding.profileBuildId}\`` : "-"} |
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

function createGroundingDiagnostics(
  grounding: QueryGrounding | undefined,
  detailed: DetailedClassification | undefined,
): GroundingDiagnostics {
  if (!grounding) {
    return {
      enabled: false,
      profileBuildId: null,
      candidates: [],
      domains: [],
      usedTermIds: [],
      initialUnsupportedClauses: [],
      repairCount: 0,
      durationMs: null,
    };
  }
  return {
    enabled: true,
    profileBuildId: grounding.profileBuildId,
    candidates: grounding.candidates,
    domains: grounding.domains,
    usedTermIds: detailed?.usedTermIds ?? [],
    initialUnsupportedClauses: detailed?.initialUnsupportedClauses ?? [],
    repairCount: detailed?.repairCount ?? 0,
    durationMs: grounding.durationMs,
  };
}

function resolveBooleanConfig(key: string): boolean {
  const entry = resolveConfig(key);
  if (typeof entry.value !== "boolean") {
    throw new Error(`La configuración ${key} debe ser boolean`);
  }
  return entry.value;
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
  strategyOptions: StrategyRuntimeOptions = {},
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
      strategy: entry.create(deps, strategyOptions),
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
