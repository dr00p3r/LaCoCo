import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
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
import { PROJECT_ROOT } from "./lib/paths.js";
import { readRepositoriesLock, type LockedRepository } from "./lib/repo-lock.js";
import {
  parseRetrievalJson,
  type RankedNode,
  type RetrievalError,
} from "./lib/retrieval-record.js";
import type { StrategyDefinition, TaskDefinition } from "./lib/types.js";

interface RetrievalSettings {
  splitName: string;
  enabled: boolean;
  timeoutMs: number;
  useDeterministicInput: boolean;
  schemaVersion: number;
  taskIds?: Set<string>;
  repoIds?: Set<string>;
  strategyIds: Set<string>;
  continueOnTaskFailure: boolean;
  continueOnStrategyFailure: boolean;
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
  gold_status: string;
  metrics_eligibility: {
    m3_m6: boolean;
    exclusion_reason: string | null;
  };
  ranked_nodes: RankedNode[];
  effective_parameters: Record<string, number> | null;
  timings_ms: { total: number };
  exit_code: number | null;
  error: RetrievalError | null;
  artifact_paths: RetrievalArtifactPaths;
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

  return {
    splitName,
    enabled: asBoolean(retrieval.enabled, "run.yaml.phases.retrieval.enabled"),
    timeoutMs: asNumber(retrieval.timeout_ms, "run.yaml.phases.retrieval.timeout_ms"),
    useDeterministicInput: asBoolean(
      retrieval.use_deterministic_sanitizer,
      "run.yaml.phases.retrieval.use_deterministic_sanitizer",
    ),
    schemaVersion: asNumber(versions.retrieval, "run.yaml.jsonl_schema_versions.retrieval"),
    ...(taskIds === undefined ? {} : { taskIds }),
    ...(repoIds === undefined ? {} : { repoIds }),
    strategyIds,
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

function selectQuery(
  task: TaskDefinition,
  useDeterministicInput: boolean,
): Pick<RetrievalRecord, "query" | "query_source"> {
  if (useDeterministicInput) {
    // TODO(eval): pass clean_query, intent, and dimensions directly once the CLI exposes
    // deterministic intermediary inputs. Until then, embedding_input is the stable proxy query.
    return {
      query: task.deterministic_input.embedding_input,
      query_source: "deterministic_input.embedding_input",
    };
  }
  return { query: task.prompt, query_source: "task.prompt" };
}

function buildCommand(repoPath: string, query: string, lacocoStrategy: string): string {
  return [
    "npm run dev -- retrieve",
    shellQuote(repoPath),
    shellQuote(query),
    "--strategy",
    shellQuote(lacocoStrategy),
    "--json",
  ].join(" ");
}

function artifactPaths(
  artifactsDirectory: string,
  taskId: string,
  strategyId: string,
): { absolute: RetrievalArtifactPaths; relative: RetrievalArtifactPaths } {
  const directory = join(artifactsDirectory, taskId, strategyId);
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
  querySelection: Pick<RetrievalRecord, "query" | "query_source">,
  paths: RetrievalArtifactPaths,
  execution: Awaited<ReturnType<typeof executeRetrieval>>,
): RetrievalRecord {
  const eligible = task.gold.status === "ready";
  return {
    schema_version: settings.schemaVersion,
    run_id: runId,
    task_id: task.id,
    repo_id: task.repo_id,
    strategy_id: strategy.id,
    lacoco_strategy: strategy.lacoco_strategy,
    ...querySelection,
    gold_status: task.gold.status,
    metrics_eligibility: {
      m3_m6: eligible,
      exclusion_reason: eligible ? null : `gold.status is ${task.gold.status}`,
    },
    ranked_nodes: execution.rankedNodes,
    effective_parameters: execution.effectiveParameters,
    timings_ms: { total: execution.result.durationMs },
    exit_code: execution.result.exitCode,
    error: execution.error,
    artifact_paths: paths,
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
  ]);
  const manifests = loadManifests();
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
  if (tasks.length === 0) {
    throw new Error(`no tasks matched the combined filters for split ${settings.splitName}`);
  }
  if (strategies.length === 0) {
    throw new Error(`no strategies matched the combined filters for split ${settings.splitName}`);
  }
  const selectedRepoIds = [...new Set(tasks.map(({ repo_id }) => repo_id))].sort();
  const outputPath = join(layout.runDirectory, "retrieval.jsonl");

  console.log(`Run: ${layout.runId}`);
  console.log(`Lock: ${layout.lockFile}`);
  console.log(`Artifacts: ${layout.artifactsDirectory}`);
  console.log(`Output: ${outputPath}`);
  console.log(`Split: ${settings.splitName}`);
  console.log(`Selected repositories (${selectedRepoIds.length}): ${selectedRepoIds.join(", ")}`);
  console.log(`Selected tasks (${tasks.length}): ${tasks.map(({ id }) => id).join(", ")}`);
  console.log(`Selected strategies (${strategies.length}): ${strategies.map(({ id }) => id).join(", ")}`);
  console.log(`Combinations: ${tasks.length * strategies.length}`);
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
  }

  const failures: string[] = [];
  let stop = false;
  for (const task of tasks) {
    const locked = lockedById.get(task.repo_id);
    if (locked === undefined) {
      failures.push(`${task.id}: repository ${task.repo_id} is missing from ${layout.lockFile}`);
      console.error(failures.at(-1));
      if (!settings.continueOnTaskFailure) break;
      continue;
    }

    for (const strategy of strategies) {
      const querySelection = selectQuery(task, settings.useDeterministicInput);
      const command = buildCommand(locked.repoPath, querySelection.query, strategy.lacoco_strategy);
      const paths = artifactPaths(layout.artifactsDirectory, task.id, strategy.id);
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
          execution,
        );
        appendFileSync(outputPath, `${JSON.stringify(record)}\n`, "utf8");
        if (record.error !== null) {
          failures.push(`${task.id} x ${strategy.id}: ${record.error.message}`);
          console.error(failures.at(-1));
          if (!settings.continueOnStrategyFailure) {
            stop = true;
            break;
          }
        }
      } catch (error) {
        failures.push(`${task.id} x ${strategy.id}: ${error instanceof Error ? error.message : String(error)}`);
        console.error(failures.at(-1));
        if (!settings.continueOnStrategyFailure) {
          stop = true;
          break;
        }
      }
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
