import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { dirname, join, relative } from "node:path";
import { parseEvalCliOptions, isEntrypoint, type EvalCliOptions } from "./lib/cli.js";
import { asBoolean, asNumber, asRecord, asString, asStringArray } from "./lib/config.js";
import {
  CommandExecutionError,
  executeCommand,
  shellQuote,
  type CommandResult,
} from "./lib/exec.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { loadManifests } from "./lib/load-manifests.js";
import { PROJECT_ROOT, resolveManifestsDir } from "./lib/paths.js";
import { readRepositoriesLock, type LockedRepository } from "./lib/repo-lock.js";
import {
  applyEmbeddingEnv,
  checkEmbeddingConsistency,
  embeddingMetadataFromProfile,
  readIndexEmbeddingMetadata,
  resolveEmbeddingProfile,
} from "./lib/embedding-profile.js";
import { resolveIntermediaryModel, resolveNumberConfig, resolveStringConfig } from "../../src/cli/config.js";
import { resolveDbPath } from "../../src/cli/storage-paths.js";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { SanitizerOutput } from "../../src/retriever/models/utilities/types.js";
import { AgentIntermediary1 } from "../../src/retriever/utilities/mini-agents/agent-intermediary/index.js";
import { SlmClassifier } from "../../src/retriever/utilities/mini-agents/agent-intermediary/classifier.js";
import { QueryGrounder } from "../../src/semantic-profile/query-grounder.js";
import { SemanticProfileStore } from "../../src/semantic-profile/semantic-profile-store.js";
import type { QueryGrounding } from "../../src/semantic-profile/types.js";
import { OllamaService } from "../../src/slms/ollama-service.js";
import {
  parseRetrievalJson,
  type ParsedClassification,
  type ParsedGrounding,
  type RankedNode,
  type RetrievalError,
} from "./lib/retrieval-record.js";
import { defaultSlmCachePath, isSlmCacheEnabled, SlmCache } from "./lib/slm-cache.js";
import type { StrategyDefinition, TaskDefinition } from "./lib/types.js";

interface RetrievalSettings {
  splitName: string;
  enabled: boolean;
  timeoutMs: number;
  useDeterministicInput: boolean;
  sanitizerVariants: SanitizerVariant[];
  schemaVersion: number;
  taskIds?: Set<string>;
  repoIds?: Set<string>;
  strategyIds: Set<string>;
  requireGoldStatus?: string;
  continueOnTaskFailure: boolean;
  continueOnStrategyFailure: boolean;
}

type SanitizerVariant = "deterministic" | "baseline" | "grounded" | "oracle";
type RecordedSanitizerVariant = SanitizerVariant | "agent_intermediary";

interface QuerySelection {
  query: string;
  query_source: RetrievalRecord["query_source"];
  sanitizer_source: RetrievalRecord["sanitizer_source"];
  sanitizerVariant: RecordedSanitizerVariant;
  encodedSanitizer: string;
  sanitizerDurationMs: number;
}

interface RetrievalArtifactPaths {
  context_json: string;
  stdout_log: string;
  stderr_log: string;
  command_log: string;
}

interface RetrievalRecord {
  schema_version: number;
  run_id: string;
  task_id: string;
  repo_id: string;
  strategy_id: string;
  lacoco_strategy: string;
  query: string;
  query_source: "task.prompt" | "deterministic_input.embedding_input";
  sanitizer_source: "agent_intermediary" | "task.deterministic_input";
  sanitizer_variant: RecordedSanitizerVariant;
  gold_status: string;
  metrics_eligibility: {
    m3_m6: boolean;
    exclusion_reason: string | null;
  };
  ranked_nodes: RankedNode[];
  effective_parameters: Record<string, number> | null;
  classification: ParsedClassification | null;
  grounding: ParsedGrounding | null;
  timings_ms: {
    total: number;
    sanitizer: number;
    retrieval: number;
  };
  exit_code: number | null;
  error: RetrievalError | null;
  artifact_paths: RetrievalArtifactPaths & { sanitizer_json: string | null };
}

function optionalSelection(
  split: Record<string, unknown> | undefined,
  key: string,
  path: string,
): Set<string> | undefined {
  const value = split?.[key];
  return value === undefined ? undefined : new Set(asStringArray(value, `${path}.${key}`));
}

function readSettings(runManifest: Record<string, unknown>, requestedSplit?: string): RetrievalSettings {
  const run = asRecord(runManifest.run, "run.yaml.run");
  const mode = asString(run.mode, "run.yaml.run.mode");
  const splitName = requestedSplit ?? mode;
  const phases = asRecord(runManifest.phases, "run.yaml.phases");
  const retrieval = asRecord(phases.retrieval, "run.yaml.phases.retrieval");
  const failure = asRecord(runManifest.failure_policy, "run.yaml.failure_policy");
  const versions = asRecord(runManifest.jsonl_schema_versions, "run.yaml.jsonl_schema_versions");
  const splits = asRecord(runManifest.splits, "run.yaml.splits");
  const splitValue = splits[splitName];
  if (splitValue === undefined) {
    throw new Error(`split not found: ${splitName}`);
  }
  const split = asRecord(splitValue, `run.yaml.splits.${splitName}`);
  const phaseStrategies = new Set(
    asStringArray(retrieval.include_strategies, "run.yaml.phases.retrieval.include_strategies"),
  );
  const splitStrategies = optionalSelection(split, "strategies", `run.yaml.splits.${splitName}`);
  const taskIds = optionalSelection(split, "task_ids", `run.yaml.splits.${splitName}`);
  const repoIds = optionalSelection(split, "repo_ids", `run.yaml.splits.${splitName}`);
  const strategyIds = splitStrategies === undefined
    ? phaseStrategies
    : new Set([...phaseStrategies].filter((id) => splitStrategies.has(id)));
  const variantValues = split.sanitizer_variants === undefined
    ? asStringArray(retrieval.sanitizer_variants, "run.yaml.phases.retrieval.sanitizer_variants")
    : asStringArray(split.sanitizer_variants, `run.yaml.splits.${splitName}.sanitizer_variants`);
  const sanitizerVariants = variantValues.map((value): SanitizerVariant => {
    if (value !== "deterministic" && value !== "baseline" && value !== "grounded" && value !== "oracle") {
      throw new Error(`unsupported sanitizer variant: ${value}`);
    }
    return value;
  });
  const requireGoldStatus = split.require_gold_status === undefined
    ? undefined
    : asString(split.require_gold_status, `run.yaml.splits.${splitName}.require_gold_status`);

  return {
    splitName,
    enabled: asBoolean(retrieval.enabled, "run.yaml.phases.retrieval.enabled"),
    timeoutMs: asNumber(retrieval.timeout_ms, "run.yaml.phases.retrieval.timeout_ms"),
    useDeterministicInput: asBoolean(
      retrieval.use_deterministic_sanitizer,
      "run.yaml.phases.retrieval.use_deterministic_sanitizer",
    ),
    sanitizerVariants,
    schemaVersion: asNumber(versions.retrieval, "run.yaml.jsonl_schema_versions.retrieval"),
    ...(taskIds === undefined ? {} : { taskIds }),
    ...(repoIds === undefined ? {} : { repoIds }),
    strategyIds,
    ...(requireGoldStatus === undefined ? {} : { requireGoldStatus }),
    continueOnTaskFailure: asBoolean(
      failure.continue_on_task_failure,
      "run.yaml.failure_policy.continue_on_task_failure",
    ),
    continueOnStrategyFailure: asBoolean(
      failure.continue_on_strategy_failure,
      "run.yaml.failure_policy.continue_on_strategy_failure",
    ),
  };
}

function assertRequestedIdsExist(
  options: EvalCliOptions,
  manifests: ReturnType<typeof loadManifests>,
): void {
  if (
    options.repoId !== undefined &&
    !manifests.repos.repositories.some(({ id }) => id === options.repoId)
  ) {
    throw new Error(`repository filter matched no entries: ${options.repoId}`);
  }
  if (
    options.taskId !== undefined &&
    !manifests.tasks.tasks.some(({ id }) => id === options.taskId)
  ) {
    throw new Error(`task filter matched no entries: ${options.taskId}`);
  }
  if (
    options.strategyId !== undefined &&
    !manifests.strategies.strategies.some(({ id }) => id === options.strategyId)
  ) {
    throw new Error(`strategy filter matched no entries: ${options.strategyId}`);
  }
}

function selectTasks(tasks: TaskDefinition[], settings: RetrievalSettings): TaskDefinition[] {
  return tasks.filter((task) =>
    task.enabled !== false &&
    (settings.requireGoldStatus === undefined || task.gold.status === settings.requireGoldStatus) &&
    (settings.taskIds === undefined || settings.taskIds.has(task.id)) &&
    (settings.repoIds === undefined || settings.repoIds.has(task.repo_id)),
  );
}

function selectStrategies(
  strategies: StrategyDefinition[],
  settings: RetrievalSettings,
): Array<StrategyDefinition & { lacoco_strategy: string }> {
  return strategies.filter((strategy): strategy is StrategyDefinition & { lacoco_strategy: string } =>
    strategy.enabled &&
    strategy.retrieval_enabled &&
    strategy.lacoco_strategy !== null &&
    settings.strategyIds.has(strategy.id),
  );
}

function encodeSanitizer(sanitizer: SanitizerOutput): string {
  return Buffer.from(JSON.stringify(sanitizer), "utf8").toString("base64url");
}

function deterministicQuerySelection(
  task: TaskDefinition,
  variant: "deterministic" | "oracle",
): QuerySelection {
  const cleanQuery = variant === "oracle"
    ? task.deterministic_input.oracle_input?.query
    : task.deterministic_input.retrieval_input.query;
  if (cleanQuery === undefined) {
    throw new Error(`task ${task.id} has no oracle_input.query required by the oracle sanitizer variant`);
  }
  const sanitizer = {
    route: "RAG",
    clean_query: cleanQuery,
    embedding_input: task.deterministic_input.embedding_input,
    intent: task.deterministic_input.intent,
    dimensions: task.deterministic_input.dimensions,
    confidence: 1,
  } as SanitizerOutput;
  return {
    query: task.deterministic_input.embedding_input,
    query_source: "deterministic_input.embedding_input",
    sanitizer_source: "task.deterministic_input",
    sanitizerVariant: variant,
    encodedSanitizer: encodeSanitizer(sanitizer),
    sanitizerDurationMs: 0,
  };
}

function recordedSlmVariant(variant: SanitizerVariant): RecordedSanitizerVariant {
  return variant === "deterministic" ? "agent_intermediary" : variant;
}

function dryRunSlmSelection(task: TaskDefinition, variant: SanitizerVariant): QuerySelection {
  const placeholder = deterministicQuerySelection(task, "deterministic");
  return {
    ...placeholder,
    query: task.prompt,
    query_source: "task.prompt",
    sanitizer_source: "agent_intermediary",
    sanitizerVariant: recordedSlmVariant(variant),
  };
}

async function freezeSlmQuery(
  task: TaskDefinition,
  variant: SanitizerVariant,
  repoPath: string,
  cache: SlmCache | null = null,
): Promise<{ selection: QuerySelection; sanitizer: SanitizerOutput; grounding: QueryGrounding | null }> {
  // Cache hit short-circuit: si ya tenemos la salida del SLM congelada para
  // (prompt, variant, model, schemaVersion) en un run anterior, la devolvemos
  // tal cual. Esto evita la llamada a Ollama (~5s con 1.5B/7B, ~3-4s con 4B)
  // cuando se re-corre el mismo run con `--strategy-id` o `--task-id` filtrado.
  // El grounder también queda cacheado, así que `grounded` no re-ejecuta el
  // escaneo FTS5+INSTR de `QueryGrounder.ground`.
  if (cache !== null) {
    const cached = cache.get(task.prompt, variant);
    if (cached !== null) {
      return {
        selection: {
          query: task.prompt,
          query_source: "task.prompt",
          sanitizer_source: "agent_intermediary",
          sanitizerVariant: recordedSlmVariant(variant),
          encodedSanitizer: encodeSanitizer(cached.sanitizer),
          sanitizerDurationMs: cached.duration_ms,
        },
        sanitizer: cached.sanitizer,
        grounding: cached.grounding,
      };
    }
  }

  // El intermediario que congela el sanitizer honra `intermediary.model` (vacío =
  // hereda agent.model), igual que la pipeline real (src/cli/pipeline.ts). Esto
  // importa para el brazo `grounded`: `sanitizeDetailed` inyecta los candidatos del
  // grounding y agranda el prompt; qwen2.5-coder:1.5b se atraganta con el JSON —
  // un instruct 7B+ lo maneja. El grounder en sí es determinista, así que cambiar
  // este modelo no altera qué términos recupera, solo si el SLM emite JSON válido.
  const ollama = new OllamaService(
    resolveStringConfig("agent.endpoint"),
    resolveIntermediaryModel(),
    resolveNumberConfig("timeout.ms"),
  );
  let db: LaCoCoDatabase | undefined;
  try {
    if (!await ollama.isAvailable()) {
      throw new Error("Ollama no disponible para congelar el sanitizer de la tarea");
    }
    const intermediary = new AgentIntermediary1(new SlmClassifier(ollama));
    let grounding: QueryGrounding | null = null;
    let sanitizer: SanitizerOutput;
    const startedAt = performance.now();
    if (variant === "grounded") {
      db = new LaCoCoDatabase(resolveDbPath(repoPath));
      grounding = new QueryGrounder(new SemanticProfileStore(db.getRawDb())).ground(task.prompt);
      sanitizer = (await intermediary.sanitizeDetailed(task.prompt, grounding)).output;
    } else {
      sanitizer = await intermediary.sanitize(task.prompt);
    }
    const sanitizerDurationMs = Math.round(performance.now() - startedAt);
    if (sanitizer.route !== "RAG") {
      throw new Error(`task ${task.id}: el sanitizer congelado produjo route=${sanitizer.route}; retrieval requiere RAG`);
    }
    if (cache !== null) {
      cache.set(task.prompt, variant, { sanitizer, grounding, duration_ms: sanitizerDurationMs });
    }
    return {
      selection: {
        query: task.prompt,
        query_source: "task.prompt",
        sanitizer_source: "agent_intermediary",
        sanitizerVariant: recordedSlmVariant(variant),
        encodedSanitizer: encodeSanitizer(sanitizer),
        sanitizerDurationMs,
      },
      sanitizer,
      grounding,
    };
  } finally {
    db?.close();
    ollama.abort();
  }
}

function usesSlm(variant: SanitizerVariant, explicitUseSlm: boolean): boolean {
  return explicitUseSlm || variant === "baseline" || variant === "grounded";
}

function buildCommand(
  repoPath: string,
  query: string,
  lacocoStrategy: string,
  encodedSanitizer: string,
): string {
  return [
    "npm run --silent eval:retrieve:deterministic --",
    shellQuote(repoPath),
    shellQuote(query),
    shellQuote(lacocoStrategy),
    shellQuote(encodedSanitizer),
  ].join(" ");
}

function artifactPaths(
  artifactsDirectory: string,
  taskId: string,
  strategyId: string,
  sanitizerVariant: RecordedSanitizerVariant,
): { absolute: RetrievalArtifactPaths; relative: RetrievalArtifactPaths } {
  const directory = join(artifactsDirectory, taskId, strategyId, sanitizerVariant);
  const absolute = {
    context_json: join(directory, "context.json"),
    stdout_log: join(directory, "stdout.log"),
    stderr_log: join(directory, "stderr.log"),
    command_log: join(directory, "command.log"),
  };
  return {
    absolute,
    relative: {
      context_json: relative(PROJECT_ROOT, absolute.context_json),
      stdout_log: relative(PROJECT_ROOT, absolute.stdout_log),
      stderr_log: relative(PROJECT_ROOT, absolute.stderr_log),
      command_log: relative(PROJECT_ROOT, absolute.command_log),
    },
  };
}

function writeFrozenSanitizerArtifact(
  artifactsDirectory: string,
  task: TaskDefinition,
  selection: QuerySelection,
  sanitizer: SanitizerOutput,
  grounding: QueryGrounding | null,
): string {
  const outputPath = join(
    artifactsDirectory,
    task.id,
    "_sanitizer",
    `${selection.sanitizerVariant}.json`,
  );
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify({
    schema_version: 1,
    task_id: task.id,
    repo_id: task.repo_id,
    query: selection.query,
    query_source: selection.query_source,
    sanitizer_source: selection.sanitizer_source,
    sanitizer_variant: selection.sanitizerVariant,
    duration_ms: selection.sanitizerDurationMs,
    output: sanitizer,
    grounding,
  }, null, 2)}\n`, "utf8");
  return relative(PROJECT_ROOT, outputPath);
}

function describeExecution(
  task: TaskDefinition,
  strategy: StrategyDefinition & { lacoco_strategy: string },
  query: string,
  command: string,
  paths: RetrievalArtifactPaths,
): void {
  console.log(`\n${task.id} x ${strategy.id}`);
  console.log(`  repo: ${task.repo_id}`);
  console.log(`  gold: ${task.gold.status}${task.gold.status === "ready" ? "" : " (exclude M3-M6)"}`);
  console.log(`  query: ${query}`);
  console.log(`  command: ${command}`);
  console.log(`  context: ${paths.context_json}`);
  console.log(`  log: ${paths.command_log}`);
}

function commandError(result: CommandResult, message: string): RetrievalError | null {
  if (result.exitCode === 0 && !result.timedOut) {
    return null;
  }
  return { type: "command_error", message };
}

async function executeRetrieval(
  command: string,
  timeoutMs: number,
  paths: { absolute: RetrievalArtifactPaths; relative: RetrievalArtifactPaths },
  expectedParameters: Record<string, number>,
): Promise<{
  result: CommandResult;
  rankedNodes: RankedNode[];
  effectiveParameters: Record<string, number> | null;
  classification: ParsedClassification | null;
  grounding: ParsedGrounding | null;
  error: RetrievalError | null;
}> {
  let result: CommandResult;
  let executionMessage = "command failed";
  try {
    result = await executeCommand({
      command,
      cwd: PROJECT_ROOT,
      timeoutMs,
      logPath: paths.absolute.command_log,
      env: {
        npm_config_loglevel: "silent",
        npm_config_update_notifier: "false",
      },
    });
  } catch (error) {
    if (!(error instanceof CommandExecutionError)) {
      throw error;
    }
    result = error.result;
    executionMessage = error.message;
  }

  mkdirSync(dirname(paths.absolute.context_json), { recursive: true });
  writeFileSync(paths.absolute.context_json, result.stdout, "utf8");
  writeFileSync(paths.absolute.stdout_log, result.stdout, "utf8");
  writeFileSync(paths.absolute.stderr_log, result.stderr, "utf8");

  const parsed = parseRetrievalJson(result.stdout);
  const executionError = commandError(result, executionMessage);
  let error = parsed.error?.type === "cli_error"
    ? parsed.error
    : executionError ?? parsed.error;
  if (error === null && !parametersMatch(parsed.effectiveParameters, expectedParameters)) {
    error = {
      type: "invalid_contract",
      message: `effective parameters do not match manifest: expected ${JSON.stringify(expectedParameters)}`,
    };
  }
  return {
    result,
    rankedNodes: parsed.rankedNodes,
    effectiveParameters: parsed.effectiveParameters,
    classification: parsed.classification,
    grounding: parsed.grounding,
    error,
  };
}

function parametersMatch(
  effective: Record<string, number> | null,
  expected: Record<string, number>,
): boolean {
  if (effective === null) return false;
  const normalized = Object.fromEntries(Object.entries(effective).map(([key, value]) => [
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    value,
  ]));
  const normalizedKeys = Object.keys(normalized).sort();
  const expectedKeys = Object.keys(expected).sort();
  return normalizedKeys.length === expectedKeys.length
    && normalizedKeys.every(
      (key, index) => key === expectedKeys[index] && normalized[key] === expected[key],
    );
}

function createRecord(
  settings: RetrievalSettings,
  runId: string,
  task: TaskDefinition,
  strategy: StrategyDefinition & { lacoco_strategy: string },
  querySelection: QuerySelection,
  paths: RetrievalArtifactPaths,
  sanitizerArtifactPath: string | null,
  execution: Awaited<ReturnType<typeof executeRetrieval>>,
): RetrievalRecord {
  const eligible = task.gold.status === "ready";
  return {
    schema_version: settings.schemaVersion,
    run_id: runId,
    task_id: task.id,
    repo_id: task.repo_id,
    strategy_id: querySelection.sanitizerVariant === "deterministic"
      || querySelection.sanitizerVariant === "agent_intermediary"
      ? strategy.id
      : `${strategy.id}@${querySelection.sanitizerVariant}`,
    lacoco_strategy: strategy.lacoco_strategy,
    query: querySelection.query,
    query_source: querySelection.query_source,
    sanitizer_source: querySelection.sanitizer_source,
    sanitizer_variant: querySelection.sanitizerVariant,
    gold_status: task.gold.status,
    metrics_eligibility: {
      m3_m6: eligible,
      exclusion_reason: eligible ? null : `gold.status is ${task.gold.status}`,
    },
    ranked_nodes: execution.rankedNodes,
    effective_parameters: execution.effectiveParameters,
    classification: execution.classification,
    grounding: execution.grounding,
    timings_ms: {
      total: execution.result.durationMs + querySelection.sanitizerDurationMs,
      sanitizer: querySelection.sanitizerDurationMs,
      retrieval: execution.result.durationMs,
    },
    exit_code: execution.result.exitCode,
    error: execution.error,
    artifact_paths: { ...paths, sanitizer_json: sanitizerArtifactPath },
  };
}

export async function runRetrieval(argv = process.argv.slice(2)): Promise<void> {
  const options = parseEvalCliOptions(argv, [
    "--dry-run",
    "--run-id",
    "--repo-id",
    "--task-id",
    "--strategy-id",
    "--split",
    "--sanitizer-variant",
    "--use-slm",
    "--manifests-dir",
  ]);
  const manifests = loadManifests(resolveManifestsDir(options.manifestsDir));
  assertRequestedIdsExist(options, manifests);
  const settings = readSettings(manifests.run, options.split);
  const layout = resolveEvalLayout(manifests.run, options.runId);
  const tasks = selectTasks(manifests.tasks.tasks, settings).filter((task) =>
    (options.repoId === undefined || task.repo_id === options.repoId) &&
    (options.taskId === undefined || task.id === options.taskId),
  );
  const strategies = selectStrategies(manifests.strategies.strategies, settings).filter(
    ({ id }) => options.strategyId === undefined || id === options.strategyId,
  );
  const sanitizerVariants = settings.sanitizerVariants.filter((variant) =>
    options.sanitizerVariant === undefined || variant === options.sanitizerVariant
  );
  if (tasks.length === 0) {
    throw new Error(`no tasks matched the combined filters for split ${settings.splitName}`);
  }
  if (strategies.length === 0) {
    throw new Error(`no strategies matched the combined filters for split ${settings.splitName}`);
  }
  if (sanitizerVariants.length === 0) {
    throw new Error(`sanitizer variant filter matched no entries: ${String(options.sanitizerVariant)}`);
  }
  if (options.useSlm === true && sanitizerVariants.includes("oracle")) {
    throw new Error("--use-slm cannot be combined with the oracle sanitizer variant");
  }
  const selectedRepoIds = [...new Set(tasks.map(({ repo_id }) => repo_id))].sort();
  const outputPath = join(layout.runDirectory, "retrieval.jsonl");

  // Perfil de embedding = fuente de verdad de run.yaml. Setear el env AQUÍ hace que
  // el subproceso `eval:retrieve:deterministic` embeba el query con el mismo modelo
  // que construyó el índice — sin exportar variables a mano.
  const embeddingProfile = resolveEmbeddingProfile(manifests.run);
  applyEmbeddingEnv(embeddingProfile);

  console.log(`Run: ${layout.runId}`);
  console.log(`Lock: ${layout.lockFile}`);
  console.log(
    `Embedding: ${embeddingProfile.model} (dim ${embeddingProfile.dim}, quantized ${embeddingProfile.quantized})`,
  );
  console.log(`Artifacts: ${layout.artifactsDirectory}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Split: ${settings.splitName}`);
  console.log(`Selected repositories (${selectedRepoIds.length}): ${selectedRepoIds.join(", ")}`);
  console.log(`Selected tasks (${tasks.length}): ${tasks.map(({ id }) => id).join(", ")}`);
  console.log(`Selected strategies (${strategies.length}): ${strategies.map(({ id }) => id).join(", ")}`);
  console.log(`Sanitizer variants (${sanitizerVariants.length}): ${sanitizerVariants.join(", ")}`);
  console.log(`SLM intermediary: ${options.useSlm === true ? `active and frozen once per task (${resolveIntermediaryModel()})` : "selected by sanitizer variant"}`);
  console.log(`Combinations: ${tasks.length * strategies.length * sanitizerVariants.length}`);
  if (!settings.enabled) {
    console.log("Retrieval phase is disabled by run.yaml.");
    return;
  }

  let lockedRepositories: LockedRepository[];
  if (existsSync(layout.lockFile)) {
    const lock = readRepositoriesLock(layout.lockFile);
    if (lock.runId !== layout.runId) {
      throw new Error(`lock run id ${lock.runId} does not match requested run ${layout.runId}`);
    }
    lockedRepositories = lock.repositories;
  } else if (options.dryRun) {
    console.log("Dry run: lock file is absent; planning with manifest repository paths.");
    lockedRepositories = manifests.repos.repositories
      .filter(({ id }) => selectedRepoIds.includes(id))
      .map((repository) => ({
        id: repository.id,
        url: repository.url,
        requestedRef: repository.ref,
        commit: "<resolved-by-eval:prepare>",
        repoPath: join(layout.reposDirectory, repository.id),
        preparedAt: "<resolved-by-eval:prepare>",
        steps: {},
      }));
  } else {
    throw new Error(`repositories lock does not exist: ${layout.lockFile}; run eval:prepare first`);
  }

  const lockedById = new Map(lockedRepositories.map((repository) => [repository.id, repository]));
  if (!options.dryRun) {
    mkdirSync(layout.runDirectory, { recursive: true });
    mkdirSync(layout.artifactsDirectory, { recursive: true });
    writeFileSync(outputPath, "", "utf8");
    // Registra qué embedding produjo este retrieval, para comparar corridas
    // (p. ej. baseline all-MiniLM vs code-aware) sin ambigüedad. Se escribe desde
    // el perfil de run.yaml (no de constantes congeladas al importar).
    writeFileSync(
      join(layout.runDirectory, "embedding-metadata.json"),
      `${JSON.stringify(
        { ...embeddingMetadataFromProfile(embeddingProfile), generated_at: new Date().toISOString() },
        null,
        2,
      )}\n`,
      "utf8",
    );

    // Assert de consistencia: el índice que abrirá el retrieval (resuelto por el
    // mismo resolveDbPath que usa la pipeline) debe haberse construido con el modelo
    // declarado. Un query-Jina sobre índice-MiniLM (o viceversa) NO da error, solo
    // basura → invalidez silenciosa. Metadata ausente = índice legacy: warn, no bloquea.
    for (const repoId of selectedRepoIds) {
      const locked = lockedById.get(repoId);
      if (locked === undefined) continue;
      const indexDirectory = dirname(resolveDbPath(locked.repoPath));
      const consistency = checkEmbeddingConsistency(
        embeddingProfile,
        readIndexEmbeddingMetadata(indexDirectory),
      );
      if (consistency.mismatch) {
        throw new Error(
          `embedding mismatch en ${repoId}: el índice (${indexDirectory}) NO coincide con el ` +
            `perfil declarado (${embeddingProfile.model}/${embeddingProfile.dim}). ` +
            `Detalle: ${consistency.reason}. Reindexa con eval:index o corrige run.yaml.embedding.`,
        );
      }
      if (consistency.reason !== null) {
        console.warn(`⚠ embedding ${repoId}: ${consistency.reason}`);
      }
    }
  }

  const failures: string[] = [];
  let stop = false;
  const slmCache = isSlmCacheEnabled()
    ? new SlmCache(defaultSlmCachePath(layout.workdir), resolveIntermediaryModel())
    : null;
  if (slmCache !== null) {
    console.log(`SLM cache: ${slmCache.getPath()} (${slmCache.size()} entradas previas)`);
  }
  for (const task of tasks) {
    const locked = lockedById.get(task.repo_id);
    if (locked === undefined) {
      failures.push(`${task.id}: repository ${task.repo_id} is missing from ${layout.lockFile}`);
      console.error(failures.at(-1));
      if (!settings.continueOnTaskFailure) break;
      continue;
    }

    for (const sanitizerVariant of sanitizerVariants) {
      let querySelection: QuerySelection;
      let sanitizerArtifactPath: string | null = null;
      try {
        if (usesSlm(sanitizerVariant, options.useSlm === true)) {
          if (options.dryRun) {
            querySelection = dryRunSlmSelection(task, sanitizerVariant);
          } else {
            const frozen = await freezeSlmQuery(task, sanitizerVariant, locked.repoPath, slmCache);
            querySelection = frozen.selection;
            sanitizerArtifactPath = writeFrozenSanitizerArtifact(
              layout.artifactsDirectory,
              task,
              frozen.selection,
              frozen.sanitizer,
              frozen.grounding,
            );
          }
        } else {
          if (sanitizerVariant !== "deterministic" && sanitizerVariant !== "oracle") {
            throw new Error(`sanitizer variant ${sanitizerVariant} requires the SLM intermediary`);
          }
          querySelection = deterministicQuerySelection(task, sanitizerVariant);
        }
      } catch (error) {
        failures.push(`${task.id} x ${sanitizerVariant}: no se pudo congelar el sanitizer: ${error instanceof Error ? error.message : String(error)}`);
        console.error(failures.at(-1));
        if (!settings.continueOnTaskFailure) stop = true;
        if (stop) break;
        continue;
      }

      for (const strategy of strategies) {
        const command = buildCommand(
          locked.repoPath,
          querySelection.query,
          strategy.lacoco_strategy,
          querySelection.encodedSanitizer,
        );
        const paths = artifactPaths(
          layout.artifactsDirectory,
          task.id,
          strategy.id,
          querySelection.sanitizerVariant,
        );
        describeExecution(task, strategy, querySelection.query, command, paths.relative);
        if (options.dryRun) {
          continue;
        }

        try {
          const execution = await executeRetrieval(
            command,
            settings.timeoutMs,
            paths,
            strategy.parameters,
          );
          const record = createRecord(
            settings,
            layout.runId,
            task,
            strategy,
            querySelection,
            paths.relative,
            sanitizerArtifactPath,
            execution,
          );
          appendFileSync(outputPath, `${JSON.stringify(record)}\n`, "utf8");
          if (record.error !== null) {
            failures.push(`${task.id} x ${strategy.id} x ${querySelection.sanitizerVariant}: ${record.error.message}`);
            console.error(failures.at(-1));
            if (!settings.continueOnStrategyFailure) {
              stop = true;
              break;
            }
          }
        } catch (error) {
          failures.push(`${task.id} x ${strategy.id} x ${querySelection.sanitizerVariant}: ${error instanceof Error ? error.message : String(error)}`);
          console.error(failures.at(-1));
          if (!settings.continueOnStrategyFailure) {
            stop = true;
            break;
          }
        }
      }
      if (stop) break;
    }
    if (stop || (failures.length > 0 && !settings.continueOnTaskFailure)) {
      break;
    }
  }

  if (options.dryRun) {
    console.log("\nDry run: no retrieval commands ran and no artifacts or JSONL were written.");
  }
  if (failures.length > 0) {
    throw new Error(`retrieval executions failed:\n${failures.join("\n")}`);
  }
}

if (isEntrypoint(import.meta.url)) {
  runRetrieval().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
