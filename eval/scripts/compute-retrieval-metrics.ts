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
  DEFAULT_SWEEP_CUTOFFS,
  groupByTask,
  METRIC_IDS,
  parseRetrievalInput,
  summarizeTaskMetrics,
  type GoldInput,
} from "./lib/metrics.js";
import { resolveNodeId } from "./lib/node-id.js";
import type { PatchEvidenceGold, SymbolRef } from "./lib/types.js";
import { getManifestPaths, MANIFESTS_DIR, PROJECT_ROOT, resolveManifestsDir } from "./lib/paths.js";
import {
  analyzeRetrievalCell,
  summarizeRetrievalDiagnostics,
  type RetrievalCellAnalysis,
} from "./lib/retrieval-analysis.js";
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

/** Node-id absoluto de un símbolo del gold (`${abs(file)}#${symbol}`). */
function symbolNodeId(ref: SymbolRef, repoPath: string): string {
  return resolveNodeId(`${ref.file}#${ref.symbol}`, repoPath);
}

/**
 * Resuelve el patch-evidence gold repo-relativo del manifest a rutas absolutas
 * (para comparar contra los node-ids del retrieval, que son absolutos). Un gold
 * ausente o un `status` no-ready produce edit-site vacío → las métricas de gold
 * quedan excluidas/invalidas, no un crash.
 */
export function buildPatchEvidenceGoldInput(
  status: string,
  evidence: PatchEvidenceGold | undefined,
  repoPath: string,
): GoldInput {
  if (evidence === undefined) {
    return {
      status,
      editSiteFiles: [],
      editSiteSymbols: [],
      testFiles: [],
      refNodes: [],
      definitionNodes: [],
    };
  }
  return {
    status,
    editSiteFiles: evidence.edited_files.map((file) => resolveNodeId(file, repoPath)),
    editSiteSymbols: evidence.edited_symbols.map((ref) => symbolNodeId(ref, repoPath)),
    testFiles: evidence.touched_tests.map((file) => resolveNodeId(file, repoPath)),
    refNodes: evidence.introduced_refs.map((ref) => symbolNodeId(ref, repoPath)),
    definitionNodes: evidence.resolved_definitions.map((ref) => symbolNodeId(ref, repoPath)),
  };
}

export interface AllZeroGuard {
  triggered: boolean;
  eligibleCells: number;
  message: string | null;
}

/**
 * Guard de invalidez silenciosa. Si hay celdas elegibles (EditSiteHit computada,
 * es decir gold `ready` con edit-site + exit 0) pero el EditSiteHit, el EditSiteMRR
 * y el PatchEvidenceHit agregados son 0 en TODAS, casi siempre es un desajuste de
 * árbol/prefijo (el gold se resolvió contra un repoPath que no es el árbol donde
 * corrió el retrieval) o un gold mal resuelto — no un run genuinamente malo, que
 * suele dejar algo de señal no-cero en alguna estrategia.
 */
export function detectAllZeroRetrieval(
  summary: ReturnType<typeof summarizeTaskMetrics>,
): AllZeroGuard {
  const global = summary.global.metrics;
  const eligibleCells = global.EditSiteHit.included_task_values;
  const triggered =
    eligibleCells > 0 &&
    global.EditSiteHit.value === 0 &&
    global.EditSiteMRR.value === 0 &&
    global.PatchEvidenceHit.value === 0;
  return {
    triggered,
    eligibleCells,
    message: triggered
      ? `⚠ VALIDEZ: ${eligibleCells} celda(s) elegible(s) con EditSiteHit/EditSiteMRR/PatchEvidenceHit=0 ` +
        "en TODAS — probable desajuste de árbol/prefijo (revisa el repoPath del lock vs los ids de " +
        "ranked_nodes) o gold mal resuelto. Pasa --strict para fallar (exit≠0) en este caso."
      : null,
  };
}

export function computeRetrievalMetrics(argv = process.argv.slice(2)): void {
  const options = parseOptions(argv);
  const manifestsDirectory = resolveManifestsDir(options.manifestsDir) ?? MANIFESTS_DIR;
  const manifestPaths = getManifestPaths(manifestsDirectory);
  const manifests = loadManifests(manifestsDirectory);
  const run = resolveRun(options, manifests.run);
  const aggregation = asRecord(
    manifests.metrics.aggregation_policy,
    "metrics.yaml.aggregation_policy",
  );
  const availableMetrics = new Set(manifests.metrics.metrics.map(({ id }) => id));
  for (const metricId of METRIC_IDS) {
    if (!availableMetrics.has(metricId)) {
      throw new Error(`metrics.yaml is missing required retrieval metric ${metricId}`);
    }
  }
  const primaryCutoff = asNumber(
    aggregation.ranking_cutoff_primary,
    "metrics.yaml.aggregation_policy.ranking_cutoff_primary",
  );
  // Barrido de K opcional (curva cobertura/hit vs. tamaño de contexto). Si no se
  // declara en el manifest, se usa el barrido por defecto de metrics.ts.
  const sweepCutoffs = Array.isArray(aggregation.ranking_cutoff_sweep)
    ? aggregation.ranking_cutoff_sweep.map((value, index) =>
        asNumber(value, `metrics.yaml.aggregation_policy.ranking_cutoff_sweep[${index}]`),
      )
    : DEFAULT_SWEEP_CUTOFFS;
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

  const retrievalAnalysis: RetrievalCellAnalysis[] = [];
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
    const gold = buildPatchEvidenceGoldInput(task.gold.status, task.gold.patch_evidence, repoPath);
    retrievalAnalysis.push(analyzeRetrievalCell(record, value, gold));
    return computeExecutionMetrics(record, gold, primaryCutoff, sweepCutoffs);
  });

  const taskResults = groupByTask(inputs);
  const summary = summarizeTaskMetrics(taskResults);
  const output = {
    schema_version: 2,
    run_id: run.runId,
    generated_at: new Date().toISOString(),
    aggregation_policy: "macro_by_task_then_repo",
    gold_source: "patch_evidence",
    cutoffs: {
      primary_k: primaryCutoff,
      sweep_k: sweepCutoffs,
      latency_percentile: 95,
    },
    bootstrap: {
      iterations: 1000,
      alpha: 0.05,
      seed: 42,
      notes: "IC bootstrap sobre valores task-level; CI es [alpha/2, 1-alpha/2] percentil de la media re-sampleada con mulberry32(seed=42). Degenerate (n<2 o unico valor) => ci_low/ci_high = null.",
    },
    inputs: {
      retrieval_jsonl: relative(PROJECT_ROOT, inputPath),
      tasks_manifest: relative(PROJECT_ROOT, manifestPaths.tasks),
      metrics_manifest: relative(PROJECT_ROOT, manifestPaths.metrics),
      manifests_dir: relative(PROJECT_ROOT, manifestsDirectory),
    },
    counts: {
      executions: inputs.length,
      task_repo_strategy_groups: taskResults.length,
    },
    executions: inputs,
    retrieval_analysis: {
      cells: retrievalAnalysis,
      by_strategy: summarizeRetrievalDiagnostics(retrievalAnalysis, inputs),
    },
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
