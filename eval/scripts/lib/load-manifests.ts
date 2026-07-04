import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";
import {
  isStrategyName,
  STRATEGY_REGISTRY,
} from "../../../src/retriever/strategies/registry.js";
import { getManifestPaths, MANIFESTS_DIR } from "./paths.js";
import type {
  AgentDefinition,
  AgentsManifest,
  EvalManifests,
  MetricDefinition,
  MetricsManifest,
  RepositoriesManifest,
  RepositoryDefinition,
  RunConfigurationManifest,
  StrategiesManifest,
  StrategyDefinition,
  TaskDefinition,
  TasksManifest,
} from "./types.js";

type UnknownRecord = Record<string, unknown>;

export class ManifestValidationError extends Error {
  public constructor(file: string, message: string, options?: ErrorOptions) {
    super(`${file}: ${message}`, options);
    this.name = "ManifestValidationError";
  }
}

function fail(file: string, path: string, expected: string): never {
  throw new ManifestValidationError(file, `${path} must be ${expected}`);
}

function record(value: unknown, file: string, path: string): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(file, path, "an object");
  }
  return value as UnknownRecord;
}

function string(value: unknown, file: string, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    fail(file, path, "a non-empty string");
  }
  return value;
}

function boolean(value: unknown, file: string, path: string): boolean {
  if (typeof value !== "boolean") {
    fail(file, path, "a boolean");
  }
  return value;
}

function number(value: unknown, file: string, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(file, path, "a finite number");
  }
  return value;
}

function array(value: unknown, file: string, path: string): unknown[] {
  if (!Array.isArray(value)) {
    fail(file, path, "an array");
  }
  return value;
}

function strings(value: unknown, file: string, path: string): string[] {
  return array(value, file, path).map((entry, index) =>
    string(entry, file, `${path}[${index}]`),
  );
}

function nullableString(value: unknown, file: string, path: string): string | null {
  return value === null ? null : string(value, file, path);
}

function numericRecord(value: unknown, file: string, path: string): Record<string, number> {
  if (value === undefined) return {};
  const result = record(value, file, path);
  return Object.fromEntries(
    Object.entries(result).map(([key, entry]) => [key, number(entry, file, `${path}.${key}`)]),
  );
}

function header(value: unknown, file: string, kind: string): UnknownRecord {
  const result = record(value, file, "document");
  const version = number(result.manifest_version, file, "manifest_version");
  if (version !== 1) {
    throw new ManifestValidationError(file, `unsupported manifest_version ${version}`);
  }
  const actualKind = string(result.kind, file, "kind");
  if (actualKind !== kind) {
    throw new ManifestValidationError(file, `kind must be ${JSON.stringify(kind)}`);
  }
  string(result.updated_at, file, "updated_at");
  return result;
}

function assertUniqueIds(items: Array<{ id: string }>, file: string, path: string): void {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) {
      throw new ManifestValidationError(file, `${path} contains duplicate id ${JSON.stringify(item.id)}`);
    }
    seen.add(item.id);
  }
}

function validateRepos(value: unknown, file: string): RepositoriesManifest {
  const root = header(value, file, "repositories");
  const repositories = array(root.repositories, file, "repositories").map((entry, index) => {
    const path = `repositories[${index}]`;
    const item = record(entry, file, path);
    return {
      ...item,
      id: string(item.id, file, `${path}.id`),
      display_name: string(item.display_name, file, `${path}.display_name`),
      url: string(item.url, file, `${path}.url`),
      ref: string(item.ref, file, `${path}.ref`),
      package_manager: string(item.package_manager, file, `${path}.package_manager`),
      install_command: string(item.install_command, file, `${path}.install_command`),
      test_command: string(item.test_command, file, `${path}.test_command`),
      source_roots: strings(item.source_roots, file, `${path}.source_roots`),
      tsconfig_candidates: strings(item.tsconfig_candidates, file, `${path}.tsconfig_candidates`),
    } satisfies RepositoryDefinition;
  });
  assertUniqueIds(repositories, file, "repositories");
  return { ...root, kind: "repositories", repositories } as RepositoriesManifest;
}

function validateStrategies(value: unknown, file: string): StrategiesManifest {
  const root = header(value, file, "retrieval_strategies");
  const strategies = array(root.strategies, file, "strategies").map((entry, index) => {
    const path = `strategies[${index}]`;
    const item = record(entry, file, path);
    return {
      ...item,
      id: string(item.id, file, `${path}.id`),
      label: string(item.label, file, `${path}.label`),
      kind: string(item.kind, file, `${path}.kind`),
      enabled: boolean(item.enabled, file, `${path}.enabled`),
      lacoco_strategy: nullableString(item.lacoco_strategy, file, `${path}.lacoco_strategy`),
      requires_lancedb: boolean(item.requires_lancedb, file, `${path}.requires_lancedb`),
      requires_ollama: boolean(item.requires_ollama, file, `${path}.requires_ollama`),
      retrieval_enabled: boolean(item.retrieval_enabled, file, `${path}.retrieval_enabled`),
      generation_enabled: boolean(item.generation_enabled, file, `${path}.generation_enabled`),
      parameters: numericRecord(item.parameters, file, `${path}.parameters`),
    } satisfies StrategyDefinition;
  });
  assertUniqueIds(strategies, file, "strategies");
  for (const [index, strategy] of strategies.entries()) {
    if (strategy.lacoco_strategy === null) continue;
    if (!isStrategyName(strategy.lacoco_strategy)) {
      throw new ManifestValidationError(
        file,
        `strategies[${index}].lacoco_strategy is not registered: ${strategy.lacoco_strategy}`,
      );
    }
    const expected = toSnakeCaseRecord(
      STRATEGY_REGISTRY[strategy.lacoco_strategy].defaultParameters,
    );
    if (!sameNumericRecord(strategy.parameters, expected)) {
      throw new ManifestValidationError(
        file,
        `strategies[${index}].parameters does not match runtime defaults; ` +
          `expected ${JSON.stringify(expected)}`,
      );
    }
  }
  return { ...root, kind: "retrieval_strategies", strategies } as StrategiesManifest;
}

function toSnakeCaseRecord(values: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [
    key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
    value,
  ]));
}

function sameNumericRecord(
  left: Record<string, number>,
  right: Record<string, number>,
): boolean {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function validateAgents(value: unknown, file: string): AgentsManifest {
  const root = header(value, file, "coding_agents");
  const agents = array(root.agents, file, "agents").map((entry, index) => {
    const path = `agents[${index}]`;
    const item = record(entry, file, path);
    return {
      ...item,
      id: string(item.id, file, `${path}.id`),
      label: string(item.label, file, `${path}.label`),
      enabled: boolean(item.enabled, file, `${path}.enabled`),
      adapter_kind: string(item.adapter_kind, file, `${path}.adapter_kind`),
      command: nullableString(item.command, file, `${path}.command`),
      invocation: record(item.invocation, file, `${path}.invocation`),
    } satisfies AgentDefinition;
  });
  assertUniqueIds(agents, file, "agents");
  return { ...root, kind: "coding_agents", agents } as AgentsManifest;
}

function validateMetrics(value: unknown, file: string): MetricsManifest {
  const root = header(value, file, "metrics");
  const metrics = array(root.metrics, file, "metrics").map((entry, index) => {
    const path = `metrics[${index}]`;
    const item = record(entry, file, path);
    return {
      ...item,
      id: string(item.id, file, `${path}.id`),
      name: string(item.name, file, `${path}.name`),
      dimension: string(item.dimension, file, `${path}.dimension`),
      stage: string(item.stage, file, `${path}.stage`),
      formula: string(item.formula, file, `${path}.formula`),
      unit: string(item.unit, file, `${path}.unit`),
      better: string(item.better, file, `${path}.better`),
      source: string(item.source, file, `${path}.source`),
    } satisfies MetricDefinition;
  });
  assertUniqueIds(metrics, file, "metrics");
  return { ...root, kind: "metrics", metrics } as MetricsManifest;
}

function validateRun(value: unknown, file: string): RunConfigurationManifest {
  const root = header(value, file, "run_configuration");
  return {
    ...root,
    kind: "run_configuration",
    run: record(root.run, file, "run"),
    paths: record(root.paths, file, "paths"),
    inputs: record(root.inputs, file, "inputs"),
    phases: record(root.phases, file, "phases"),
    splits: record(root.splits, file, "splits"),
  } as RunConfigurationManifest;
}

function validateTasks(value: unknown, file: string): TasksManifest {
  const root = header(value, file, "tasks");
  const tasks = array(root.tasks, file, "tasks").map((entry, index) => {
    const path = `tasks[${index}]`;
    const item = record(entry, file, path);
    const deterministic = record(item.deterministic_input, file, `${path}.deterministic_input`);
    const gold = record(item.gold, file, `${path}.gold`);
    return {
      ...item,
      id: string(item.id, file, `${path}.id`),
      repo_id: string(item.repo_id, file, `${path}.repo_id`),
      title: string(item.title, file, `${path}.title`),
      type: string(item.type, file, `${path}.type`),
      difficulty: string(item.difficulty, file, `${path}.difficulty`),
      prompt: string(item.prompt, file, `${path}.prompt`),
      deterministic_input: {
        clean_query: string(deterministic.clean_query, file, `${path}.deterministic_input.clean_query`),
        embedding_input: string(deterministic.embedding_input, file, `${path}.deterministic_input.embedding_input`),
        intent: string(deterministic.intent, file, `${path}.deterministic_input.intent`),
        dimensions: strings(deterministic.dimensions, file, `${path}.deterministic_input.dimensions`),
      },
      expected_areas: strings(item.expected_areas, file, `${path}.expected_areas`),
      target_tests: strings(item.target_tests, file, `${path}.target_tests`),
      gold: {
        status: string(gold.status, file, `${path}.gold.status`),
        relevant_nodes: strings(gold.relevant_nodes, file, `${path}.gold.relevant_nodes`),
        multihop_nodes: strings(gold.multihop_nodes, file, `${path}.gold.multihop_nodes`),
        annotation_notes: string(gold.annotation_notes, file, `${path}.gold.annotation_notes`),
      },
    } satisfies TaskDefinition;
  });
  assertUniqueIds(tasks, file, "tasks");
  return { ...root, kind: "tasks", tasks } as TasksManifest;
}

function readYaml(path: string): unknown {
  const file = basename(path);
  try {
    return parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (error instanceof ManifestValidationError) {
      throw error;
    }
    throw new ManifestValidationError(file, "could not be read or parsed as YAML", { cause: error });
  }
}

export function loadManifests(manifestsDirectory = MANIFESTS_DIR): EvalManifests {
  const paths = getManifestPaths(manifestsDirectory);
  const manifests: EvalManifests = {
    repos: validateRepos(readYaml(paths.repos), basename(paths.repos)),
    strategies: validateStrategies(readYaml(paths.strategies), basename(paths.strategies)),
    agents: validateAgents(readYaml(paths.agents), basename(paths.agents)),
    metrics: validateMetrics(readYaml(paths.metrics), basename(paths.metrics)),
    run: validateRun(readYaml(paths.run), basename(paths.run)),
    tasks: validateTasks(readYaml(paths.tasks), basename(paths.tasks)),
  };

  const repositoryIds = new Set(manifests.repos.repositories.map(({ id }) => id));
  for (const [index, task] of manifests.tasks.tasks.entries()) {
    if (!repositoryIds.has(task.repo_id)) {
      throw new ManifestValidationError(
        "tasks.yaml",
        `tasks[${index}].repo_id references unknown repository ${JSON.stringify(task.repo_id)}`,
      );
    }
  }

  return manifests;
}

function printSummary(manifests: EvalManifests): void {
  console.log(
    `Validated 6 manifests: ${manifests.repos.repositories.length} repositories, ` +
      `${manifests.strategies.strategies.length} strategies, ${manifests.agents.agents.length} agents, ` +
      `${manifests.metrics.metrics.length} metrics, ${manifests.tasks.tasks.length} tasks.`,
  );
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && import.meta.url === pathToFileURL(resolve(entrypoint)).href) {
  try {
    printSummary(loadManifests());
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
