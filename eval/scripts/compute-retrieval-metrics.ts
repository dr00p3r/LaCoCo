import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { isEntrypoint } from "./lib/cli.js";
import { asNumber, asRecord } from "./lib/config.js";
import { readJsonl } from "./lib/jsonl.js";
import { existsSync } from "node:fs";
import { resolveEvalLayout } from "./lib/layout.js";
import { loadManifests } from "./lib/load-manifests.js";
import { readRepositoriesLock } from "./lib/repo-lock.js";
import {
  computeExecutionMetrics,
  groupByTask,
  parseRetrievalInput,
  summarizeTaskMetrics,
  type GoldInput,
} from "./lib/metrics.js";
import { resolveNodeId } from "./lib/node-id.js";
import { PROJECT_ROOT } from "./lib/paths.js";
import { renderSummaryCsv, renderSummaryMarkdown } from "./lib/summary.js";

interface MetricsCliOptions {
  runId?: string;
  runDir?: string;
  inputFile?: string;
}

function parseOptions(argv: string[]): MetricsCliOptions {
  let runId: string | undefined;
  let runDir: string | undefined;
  let inputFile: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument !== "--run-id" && argument !== "--run-dir" && argument !== "--input-file") {
      throw new Error(`unknown argument: ${String(argument)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--run-id") runId = value;
    else if (argument === "--run-dir") runDir = value;
    else inputFile = value;
    index += 1;
  }
  if ((runId === undefined) === (runDir === undefined)) {
    throw new Error("provide exactly one of --run-id or --run-dir");
  }
  const base = runId === undefined ? { runDir: runDir! } : { runId };
  // --input-file (default retrieval.jsonl) permite medir sobre una variante
  // normalizada (p. ej. retrieval.normalized.jsonl) sin mutar el JSONL crudo.
  return inputFile === undefined ? base : { ...base, inputFile };
}

function resolveRun(
  options: MetricsCliOptions,
  runManifest: Parameters<typeof resolveEvalLayout>[0],
): { runId: string; runDirectory: string } {
  if (options.runId !== undefined) {
    const layout = resolveEvalLayout(runManifest, options.runId);
    return { runId: layout.runId, runDirectory: layout.runDirectory };
  }
  const runDirectory = isAbsolute(options.runDir!)
    ? resolve(options.runDir!)
    : resolve(PROJECT_ROOT, options.runDir!);
  return { runId: basename(runDirectory), runDirectory };
}

export function computeRetrievalMetrics(argv = process.argv.slice(2)): void {
  const options = parseOptions(argv);
  const manifests = loadManifests();
  const run = resolveRun(options, manifests.run);
  const aggregation = asRecord(
    manifests.metrics.aggregation_policy,
    "metrics.yaml.aggregation_policy",
  );
  const availableMetrics = new Set(manifests.metrics.metrics.map(({ id }) => id));
  for (const metricId of ["M3", "M4", "M5", "M6", "M7"]) {
    if (!availableMetrics.has(metricId)) {
      throw new Error(`metrics.yaml is missing required retrieval metric ${metricId}`);
    }
  }
  const precisionCutoff = asNumber(
    aggregation.ranking_cutoff_primary,
    "metrics.yaml.aggregation_policy.ranking_cutoff_primary",
  );
  const multihopCutoff = asNumber(
    aggregation.multihop_cutoff_primary,
    "metrics.yaml.aggregation_policy.multihop_cutoff_primary",
  );
  const schemaVersions = asRecord(
    manifests.run.jsonl_schema_versions,
    "run.yaml.jsonl_schema_versions",
  );
  const expectedSchemaVersion = asNumber(
    schemaVersions.retrieval,
    "run.yaml.jsonl_schema_versions.retrieval",
  );
  const layout = resolveEvalLayout(manifests.run, run.runId);
  const reposDirectory = layout.reposDirectory;
  // El gold es repo-relativo y debe resolverse contra el MISMO árbol donde corrió
  // el retrieval. Ese árbol lo fija el lock del run (p. ej. repos-jina/ para los
  // runs Jina), no `paths.repos`. Resolver contra `paths.repos` (repos/) cuando el
  // run usó repos-jina/ produce un prefijo distinto → 0 matches en TODAS las celdas
  // (regresión introducida al migrar el gold a rutas relativas). Fallback a
  // `paths.repos` para runs cuyo lock no exista o no liste el repo.
  const lockRepoPathById = new Map<string, string>();
  if (existsSync(layout.lockFile)) {
    for (const repository of readRepositoriesLock(layout.lockFile).repositories) {
      lockRepoPathById.set(repository.id, repository.repoPath);
    }
  }
  const inputPath = join(run.runDirectory, options.inputFile ?? "retrieval.jsonl");
  const metricsPath = join(run.runDirectory, "retrieval-metrics.json");
  const csvPath = join(run.runDirectory, "summary.csv");
  const markdownPath = join(run.runDirectory, "summary.md");
  const taskById = new Map(manifests.tasks.tasks.map((task) => [task.id, task]));

  const inputs = readJsonl(inputPath).map(({ line, value }) => {
    const record = parseRetrievalInput(value, `${inputPath}:${line}`);
    if (record.schemaVersion !== expectedSchemaVersion) {
      throw new Error(
        `${inputPath}:${line}: schema_version ${record.schemaVersion} does not match ${expectedSchemaVersion}`,
      );
    }
    if (record.runId !== run.runId) {
      throw new Error(`${inputPath}:${line}: run_id ${record.runId} does not match ${run.runId}`);
    }
    const task = taskById.get(record.taskId);
    if (task === undefined) {
      throw new Error(`${inputPath}:${line}: unknown task_id ${record.taskId}`);
    }
    if (task.repo_id !== record.repoId) {
      throw new Error(
        `${inputPath}:${line}: repo_id ${record.repoId} does not match task repo ${task.repo_id}`,
      );
    }
    const repoPath = lockRepoPathById.get(task.repo_id) ?? join(reposDirectory, task.repo_id);
    const gold: GoldInput = {
      status: task.gold.status,
      relevantNodes: task.gold.relevant_nodes.map((id) => resolveNodeId(id, repoPath)),
      multihopNodes: task.gold.multihop_nodes.map((id) => resolveNodeId(id, repoPath)),
    };
    return computeExecutionMetrics(record, gold, precisionCutoff, multihopCutoff);
  });

  const taskResults = groupByTask(inputs);
  const summary = summarizeTaskMetrics(taskResults);
  const output = {
    schema_version: 1,
    run_id: run.runId,
    generated_at: new Date().toISOString(),
    aggregation_policy: "macro_by_task_then_repo",
    cutoffs: {
      precision_at: precisionCutoff,
      recall_at: precisionCutoff,
      multihop_recall_at: multihopCutoff,
      latency_percentile: 95,
    },
    inputs: {
      retrieval_jsonl: relative(PROJECT_ROOT, inputPath),
      tasks_manifest: "eval/manifests/tasks.yaml",
      metrics_manifest: "eval/manifests/metrics.yaml",
    },
    counts: {
      executions: inputs.length,
      task_repo_strategy_groups: taskResults.length,
    },
    executions: inputs,
    task_results: taskResults,
    summary,
  };

  writeFileSync(metricsPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderSummaryCsv(summary), "utf8");
  writeFileSync(markdownPath, renderSummaryMarkdown(run.runId, summary), "utf8");
  console.log(`Computed retrieval metrics for ${inputs.length} executions.`);
  console.log(`Metrics: ${metricsPath}`);
  console.log(`CSV: ${csvPath}`);
  console.log(`Markdown: ${markdownPath}`);
}

if (isEntrypoint(import.meta.url)) {
  try {
    computeRetrievalMetrics();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
