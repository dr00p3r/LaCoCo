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
import { PROJECT_ROOT, resolveManifestsDir } from "./lib/paths.js";
import { renderSummaryCsv, renderSummaryMarkdown } from "./lib/summary.js";

interface MetricsCliOptions {
  runId?: string;
  runDir?: string;
  inputFile?: string;
  manifestsDir?: string;
  strict?: boolean;
}

function parseOptions(argv: string[]): MetricsCliOptions {
  let runId: string | undefined;
  let runDir: string | undefined;
  let inputFile: string | undefined;
  let manifestsDir: string | undefined;
  let strict = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    // --strict es un flag sin valor: convierte la advertencia de todo-cero (guard de
    // invalidez silenciosa) en un exit≠0 para usarlo en CI/gates.
    if (argument === "--strict") {
      strict = true;
      continue;
    }
    if (
      argument !== "--run-id" &&
      argument !== "--run-dir" &&
      argument !== "--input-file" &&
      argument !== "--manifests-dir"
    ) {
      throw new Error(`unknown argument: ${String(argument)}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    if (argument === "--run-id") runId = value;
    else if (argument === "--run-dir") runDir = value;
    else if (argument === "--manifests-dir") manifestsDir = value;
    else inputFile = value;
    index += 1;
  }
  if ((runId === undefined) === (runDir === undefined)) {
    throw new Error("provide exactly one of --run-id or --run-dir");
  }
  const base = runId === undefined ? { runDir: runDir!, strict } : { runId, strict };
  // --input-file (default retrieval.jsonl) permite medir sobre una variante
  // normalizada (p. ej. retrieval.normalized.jsonl) sin mutar el JSONL crudo.
  const withInput = inputFile === undefined ? base : { ...base, inputFile };
  return manifestsDir === undefined ? withInput : { ...withInput, manifestsDir };
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

export interface AllZeroGuard {
  triggered: boolean;
  eligibleCells: number;
  message: string | null;
}

/**
 * Guard de invalidez silenciosa. Si hay celdas elegibles (M3 computada, es decir
 * gold `ready` + exit 0) pero la precisión temprana (M3), el MRR (M5) y el multi-hop
 * (M6) agregados son 0 en TODAS, casi siempre es un desajuste de árbol/prefijo (el
 * gold se resolvió contra un repoPath que no es el árbol donde corrió el retrieval)
 * o un gold mal resuelto — no un run genuinamente malo, que suele dejar algo de MRR
 * no-cero en alguna estrategia. M6 se ignora si no tiene celdas computadas (tareas
 * sin multihop gold → not_applicable).
 */
export function detectAllZeroRetrieval(
  summary: ReturnType<typeof summarizeTaskMetrics>,
): AllZeroGuard {
  const global = summary.global.metrics;
  const eligibleCells = global.M3.included_task_values;
  const m6HasCells = global.M6.included_task_values > 0;
  const triggered =
    eligibleCells > 0 &&
    global.M3.value === 0 &&
    global.M5.value === 0 &&
    (!m6HasCells || global.M6.value === 0);
  return {
    triggered,
    eligibleCells,
    message: triggered
      ? `⚠ VALIDEZ: ${eligibleCells} celda(s) elegible(s) con M3/M5/M6=0 en TODAS — ` +
        "probable desajuste de árbol/prefijo (revisa el repoPath del lock vs los ids de " +
        "ranked_nodes) o gold mal resuelto. Pasa --strict para fallar (exit≠0) en este caso."
      : null,
  };
}

export function computeRetrievalMetrics(argv = process.argv.slice(2)): void {
  const options = parseOptions(argv);
  const manifests = loadManifests(resolveManifestsDir(options.manifestsDir));
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
  // El lock vive DENTRO del propio run dir (`prepare_repos` lo escribe ahí). En modo
  // --run-id eso coincide con layout.lockFile; en --run-dir apunta al dir provisto.
  // Resolverlo contra run.runDirectory hace la resolución del gold correcta en ambos
  // modos y testeable sin depender de eval/runs/.
  const lockPath = join(run.runDirectory, basename(layout.lockFile));
  const lockRepoPathById = new Map<string, string>();
  if (existsSync(lockPath)) {
    for (const repository of readRepositoriesLock(lockPath).repositories) {
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

  // Guard de invalidez silenciosa: advierte (o falla con --strict) si todas las
  // celdas elegibles dan M3/M5/M6=0 — señal clásica de desajuste de árbol/prefijo.
  const guard = detectAllZeroRetrieval(summary);
  if (guard.triggered) {
    console.error(guard.message);
    if (options.strict === true) {
      throw new Error("retrieval metrics all-zero guard failed under --strict");
    }
  }
}

if (isEntrypoint(import.meta.url)) {
  try {
    computeRetrievalMetrics();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
