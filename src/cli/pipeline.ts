import crypto from "node:crypto";
import path from "node:path";
import { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { AgentIntermediary1 } from "../retriever/utilities/mini-agents/agent-intermediary/index.js";
import { SlmClassifier } from "../retriever/utilities/mini-agents/agent-intermediary/classifier.js";
import { ContextAggregator } from "../retriever/utilities/filters/context-aggregator.js";
import { PromptInjector } from "../retriever/utilities/filters/prompt-injector.js";
import { ChunkBodyResolver } from "../retriever/utilities/filters/chunk-body-resolver.js";
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
import { resolveConfig } from "./state/config-store.js";
import { resolveIntermediaryModel } from "./config.js";
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
  template: string;
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

export interface RetrievedContext {
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
    templateVersion: string;
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
    templateVersion: string;
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
      templateVersion: context.options.templateVersion,
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
  const maxTokens = options.maxTokens ?? resolveNumberConfig("context.maxTokens");
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
    template: resolveStringConfig("context.template"),
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
  const writeStderr = (message: string): void => {
    streams.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };
  const session = RetrievalSession.open({
    db: options.db,
    lancedb: options.lancedb,
    ollamaEndpoint: options.ollama,
    runtime,
    ...(options.verbose ? { log: writeStderr } : {}),
  });
  try {
    return await session.retrieve(query, {
      strategy: options.strategy,
      maxTokens: options.maxTokens,
      grounding: options.grounding,
      template: options.template,
      ...(options.chunks === undefined ? {} : { chunks: options.chunks }),
    });
  } finally {
    await session.close(writeStderr);
  }
}

/** Configuración de apertura de una sesión de retrieval con estado caliente. */
export interface RetrievalSessionConfig {
  db: string;
  lancedb: string;
  ollamaEndpoint: string;
  runtime?: RetrieveRuntime;
  /** Logger de diagnóstico (stderr en CLI/MCP). Ausente = silencioso. */
  log?: (message: string) => void;
}

/** Parámetros por llamada de `RetrievalSession.retrieve`. */
export interface SessionRetrieveParams {
  strategy: string;
  maxTokens: number;
  grounding: boolean;
  template: string;
  chunks?: number;
  /**
   * Clasificación pre-validada (sanitizer congelado). Cuando se provee, se
   * SALTA el clasificador SLM y el grounding — mismo mecanismo determinista que
   * `eval/scripts/deterministic-retrieve.ts`. La usa el modo tool (MCP) cuando el
   * LLM del agente aporta la clasificación. Ausente = clasifica el SLM (doctrina).
   */
  presetSanitized?: SanitizerOutput;
}

/**
 * Sesión de retrieval con estado ABIERTO reutilizable entre llamadas: mantiene
 * calientes SQLite, el cliente Ollama (clasificador) y las estrategias creadas
 * (cachear la estrategia ES cachear su modelo de embeddings, lazy por instancia).
 * El modo hook del CLI la usa como `open → retrieve → close` (una llamada); el
 * servidor MCP la mantiene viva a lo largo de todo el proceso.
 */
export class RetrievalSession {
  private readonly strategyCache = new Map<
    string,
    { strategy: RecoveryStrategy; lanceDb?: LaCoCoLanceDb }
  >();

  private constructor(
    private readonly db: LaCoCoDatabase,
    private readonly ollama: LlmClient,
    private readonly intermediary: RetrieveIntermediary,
    private readonly config: RetrievalSessionConfig,
    private readonly runtime: RetrieveRuntime,
    private readonly timeoutMs: number,
  ) {}

  static open(config: RetrievalSessionConfig): RetrievalSession {
    const runtime = config.runtime ?? defaultRetrieveRuntime;
    const timeoutMs = resolveNumberConfig("timeout.ms");
    const db = runtime.createDatabase(config.db);
    const ollama = runtime.createOllama(config.ollamaEndpoint);
    const intermediary = runtime.createIntermediary(ollama, config.ollamaEndpoint, timeoutMs);
    return new RetrievalSession(db, ollama, intermediary, config, runtime, timeoutMs);
  }

  async retrieve(query: string, params: SessionRetrieveParams): Promise<RetrievedContext> {
    let stage = "inicialización";
    const verbose = (message: string): void => this.config.log?.(message);
    try {
      verbose(`[CLI] retrieve: strategy=${params.strategy} db=${this.config.db}`);

      let sanitized: SanitizerOutput;
      let groundingDiagnostics: GroundingDiagnostics;

      if (params.presetSanitized) {
        // Clasificación congelada del agente: sin SLM, sin grounding.
        sanitized = params.presetSanitized;
        groundingDiagnostics = createGroundingDiagnostics(undefined, undefined);
      } else {
        let grounding: QueryGrounding | undefined;
        if (params.grounding) {
          stage = "query grounding";
          grounding = new QueryGrounder(new SemanticProfileStore(this.db.getRawDb())).ground(query);
        }

        stage = "intermediario";
        let detailed: DetailedClassification | undefined;
        if (grounding) {
          if (!this.intermediary.sanitizeDetailed) {
            throw new Error("El intermediario configurado no soporta grounding detallado");
          }
          detailed = await this.intermediary.sanitizeDetailed(query, grounding);
          sanitized = detailed.output;
        } else {
          sanitized = await this.intermediary.sanitize(query);
        }
        groundingDiagnostics = createGroundingDiagnostics(grounding, detailed);
      }

      verbose(
        `[CLI] intermediario: route=${sanitized.route} intent=${sanitized.intent} ` +
          `confidence=${sanitized.confidence.toFixed(2)} clean_query=${JSON.stringify(sanitized.clean_query)}`,
      );

      if (sanitized.route === "LLM_DIRECT") {
        return this.#build(query, params, sanitized, groundingDiagnostics, [], sanitized.embedding_input || query);
      }

      stage = "selección de estrategia";
      const { strategy } = await this.#getStrategy(params.strategy, params.chunks);

      stage = `retrieval:${params.strategy}`;
      const rawChunks = await strategy.retrieve(sanitized);

      // Template v2: reemplaza la firma de cada chunk por el cuerpo cortado del
      // working tree ANTES de agregar, para que el presupuesto de tokens se
      // calcule sobre el texto real que verá el agente.
      const chunks = params.template === "v2"
        ? new ChunkBodyResolver(this.db).resolve(rawChunks)
        : rawChunks;

      stage = "agregación";
      const aggregated = new ContextAggregator().aggregate(chunks, params.maxTokens);
      verbose(`[CLI] chunks recuperados: ${aggregated.length}`);

      const enrichedPrompt = new PromptInjector().inject(query, aggregated, params.template);
      return this.#build(query, params, sanitized, groundingDiagnostics, aggregated, enrichedPrompt);
    } catch (err) {
      throw new PipelineStageError(stage, err);
    }
  }

  async #getStrategy(
    strategyName: string,
    chunks: number | undefined,
  ): Promise<{ strategy: RecoveryStrategy; lanceDb?: LaCoCoLanceDb }> {
    const key = `${strategyName}:${chunks ?? "default"}`;
    const cached = this.strategyCache.get(key);
    if (cached) return cached;

    const created = await this.runtime.createStrategy(
      strategyName,
      this.db,
      this.config.lancedb,
      this.config.ollamaEndpoint,
      this.timeoutMs,
      this.ollama,
      chunks === undefined ? {} : { chunks },
    );
    const entry = {
      strategy: created.strategy,
      ...(created.connectedLanceDb ? { lanceDb: created.connectedLanceDb } : {}),
    };
    this.strategyCache.set(key, entry);
    return entry;
  }

  #build(
    originalQuery: string,
    params: SessionRetrieveParams,
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
        strategy: params.strategy,
        db: this.config.db,
        lancedb: this.config.lancedb,
        ollama: this.config.ollamaEndpoint,
        strategyParameters: getEffectiveStrategyParameters(
          params.strategy as (typeof STRATEGY_NAMES)[number],
          params.chunks === undefined ? {} : { chunks: params.chunks },
        ),
        maxTokens: params.maxTokens,
        templateVersion: params.template,
      },
      sanitized,
      grounding,
      chunks,
      enrichedPrompt,
    };
  }

  async close(onError?: (message: string) => void): Promise<void> {
    this.ollama.abort();
    for (const { lanceDb } of this.strategyCache.values()) {
      if (!lanceDb) continue;
      try {
        await lanceDb.close();
      } catch (err) {
        onError?.(`[CLI] Error cerrando LanceDB: ${formatError(err)}`);
      }
    }
    this.strategyCache.clear();
    try {
      this.db.close();
    } catch (err) {
      onError?.(`[CLI] Error cerrando SQLite: ${formatError(err)}`);
    }
  }
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
