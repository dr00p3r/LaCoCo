import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { isEntrypoint, parseEvalCliOptions } from "./lib/cli.js";
import { asNumber, asRecord, asString, asStringArray } from "./lib/config.js";
import { findGraphDatabase, openGraphLookup, type GraphLookup } from "./lib/graph-reader.js";
import { readJsonl } from "./lib/jsonl.js";
import { resolveEvalLayout } from "./lib/layout.js";
import type { EvalLayout } from "./lib/layout.js";
import { loadManifests } from "./lib/load-manifests.js";
import {
  type ExecutionMetricResult,
  type EvidenceStratum,
  DEFAULT_SWEEP_CUTOFFS,
  computeExecutionMetrics,
  isExternalNodeId,
  parseRetrievalInput,
} from "./lib/metrics.js";
import { buildPatchEvidenceGoldInput } from "./compute-retrieval-metrics.js";
import { resolveNodeId } from "./lib/node-id.js";
import {
  getManifestPaths,
  MANIFESTS_DIR,
  PROJECT_ROOT,
  resolveManifestsDir,
} from "./lib/paths.js";
import { readRepositoriesLock, type LockedRepository } from "./lib/repo-lock.js";
import {
  analyzeRetrievalCell,
  summarizeRetrievalDiagnostics,
  type RetrievalCellAnalysis,
} from "./lib/retrieval-analysis.js";
import type { StrategyDefinition, TaskDefinition } from "./lib/types.js";

type CheckStatus = "ok" | "warn" | "fail";

interface DoctorCheck {
  id: string;
  status: CheckStatus;
  message: string;
  details?: unknown;
}

interface DoctorSelection {
  split: string;
  repos: string[];
  tasks: string[];
  strategies: string[];
  sanitizer_variants: string[];
  expected_cells: number;
}

interface BenchmarkDoctorReport {
  schema_version: 1;
  run_id: string;
  generated_at: string;
  inputs: {
    manifests_dir: string;
    tasks_manifest: string;
    metrics_manifest: string;
    run_directory: string;
    retrieval_jsonl: string;
    repos_lock: string;
  };
  selection: DoctorSelection;
  checks: DoctorCheck[];
  retrieval_analysis: {
    cells: RetrievalCellAnalysis[];
    by_strategy: ReturnType<typeof summarizeRetrievalDiagnostics>;
  };
  graph_distance_profile: GraphDistanceProfile[];
}

const DEFAULT_MANIFESTS_DIR = "eval/manifests/swe-polybench";

function resolveDoctorManifestsDir(raw: string | undefined): string {
  return resolveManifestsDir(raw) ?? resolveManifestsDir(process.env.LACOCO_EVAL_MANIFESTS_DIR) ??
    resolve(PROJECT_ROOT, DEFAULT_MANIFESTS_DIR);
}

function splitRecord(runManifest: Record<string, unknown>, splitName: string): Record<string, unknown> {
  const splits = asRecord(runManifest.splits, "run.yaml.splits");
  const split = splits[splitName];
  if (split === undefined) {
    throw new Error(`split not found: ${splitName}`);
  }
  return asRecord(split, `run.yaml.splits.${splitName}`);
}

function runMode(runManifest: Record<string, unknown>): string {
  const run = asRecord(runManifest.run, "run.yaml.run");
  return asString(run.mode, "run.yaml.run.mode");
}

function optionalSet(source: Record<string, unknown>, key: string, path: string): Set<string> | null {
  return source[key] === undefined ? null : new Set(asStringArray(source[key], `${path}.${key}`));
}

function retrievalStrategies(runManifest: Record<string, unknown>, split: Record<string, unknown>, splitName: string): Set<string> {
  const phases = asRecord(runManifest.phases, "run.yaml.phases");
  const retrieval = asRecord(phases.retrieval, "run.yaml.phases.retrieval");
  const phaseStrategies = new Set(
    asStringArray(retrieval.include_strategies, "run.yaml.phases.retrieval.include_strategies"),
  );
  const splitStrategies = optionalSet(split, "strategies", `run.yaml.splits.${splitName}`);
  return splitStrategies === null
    ? phaseStrategies
    : new Set([...phaseStrategies].filter((id) => splitStrategies.has(id)));
}

function sanitizerVariants(runManifest: Record<string, unknown>, split: Record<string, unknown>, splitName: string): string[] {
  const phases = asRecord(runManifest.phases, "run.yaml.phases");
  const retrieval = asRecord(phases.retrieval, "run.yaml.phases.retrieval");
  const values = split.sanitizer_variants === undefined
    ? asStringArray(retrieval.sanitizer_variants, "run.yaml.phases.retrieval.sanitizer_variants")
    : asStringArray(split.sanitizer_variants, `run.yaml.splits.${splitName}.sanitizer_variants`);
  return values;
}

function selectedTasks(
  tasks: TaskDefinition[],
  split: Record<string, unknown>,
  splitName: string,
  filters: { repoId: string | undefined; taskId: string | undefined },
): TaskDefinition[] {
  const repoIds = optionalSet(split, "repo_ids", `run.yaml.splits.${splitName}`);
  const taskIds = optionalSet(split, "task_ids", `run.yaml.splits.${splitName}`);
  const requireGoldStatus = split.require_gold_status === undefined
    ? null
    : asString(split.require_gold_status, `run.yaml.splits.${splitName}.require_gold_status`);
  return tasks.filter((task) =>
    task.enabled !== false &&
    (requireGoldStatus === null || task.gold.status === requireGoldStatus) &&
    (repoIds === null || repoIds.has(task.repo_id)) &&
    (taskIds === null || taskIds.has(task.id)) &&
    (filters.repoId === undefined || task.repo_id === filters.repoId) &&
    (filters.taskId === undefined || task.id === filters.taskId),
  );
}

function selectedStrategies(
  strategies: StrategyDefinition[],
  strategyIds: Set<string>,
  strategyIdFilter: string | undefined,
): Array<StrategyDefinition & { lacoco_strategy: string }> {
  return strategies.filter((strategy): strategy is StrategyDefinition & { lacoco_strategy: string } =>
    strategy.enabled &&
    strategy.retrieval_enabled &&
    strategy.lacoco_strategy !== null &&
    strategyIds.has(strategy.id) &&
    (strategyIdFilter === undefined || strategy.id === strategyIdFilter),
  );
}

function expectedRecordStrategyId(strategyId: string, sanitizerVariant: string): string {
  return sanitizerVariant === "deterministic" || sanitizerVariant === "agent_intermediary"
    ? strategyId
    : `${strategyId}@${sanitizerVariant}`;
}

function indexNames(reposManifest: Record<string, unknown>): { graphDbName: string; vectorDirectoryName: string } {
  const defaults = asRecord(reposManifest.defaults, "repos.yaml.defaults");
  const lacocoIndex = asRecord(defaults.lacoco_index, "repos.yaml.defaults.lacoco_index");
  return {
    graphDbName: asString(lacocoIndex.graph_db_name, "repos.yaml.defaults.lacoco_index.graph_db_name"),
    vectorDirectoryName: asString(
      lacocoIndex.vector_dir_name,
      "repos.yaml.defaults.lacoco_index.vector_dir_name",
    ),
  };
}

function check(status: CheckStatus, id: string, message: string, details?: unknown): DoctorCheck {
  return details === undefined ? { id, status, message } : { id, status, message, details };
}

function resolveDoctorLayout(
  runManifest: Parameters<typeof resolveEvalLayout>[0],
  options: { runId: string | undefined; runDir: string | undefined },
): EvalLayout {
  if (options.runDir === undefined) {
    return resolveEvalLayout(runManifest, options.runId);
  }
  if (options.runId !== undefined) {
    throw new Error("provide only one of --run-id or --run-dir");
  }
  const runDirectory = isAbsolute(options.runDir)
    ? resolve(options.runDir)
    : resolve(PROJECT_ROOT, options.runDir);
  const base = resolveEvalLayout(runManifest, basename(runDirectory));
  return {
    ...base,
    runDirectory,
    artifactsDirectory: join(runDirectory, "artifacts"),
    generationArtifactsDirectory: join(runDirectory, "generation-artifacts"),
    lockFile: join(runDirectory, "repos.lock.json"),
    prepareLogsDirectory: join(runDirectory, "logs", "prepare"),
    indexLogsDirectory: join(runDirectory, "logs", "index"),
  };
}

function lockedRepoPath(
  repoId: string,
  lockedById: Map<string, LockedRepository>,
  fallbackReposDirectory: string,
): string {
  return lockedById.get(repoId)?.repoPath ?? join(fallbackReposDirectory, repoId);
}

function readLockCheck(lockPath: string, runId: string): {
  checks: DoctorCheck[];
  repositories: LockedRepository[];
} {
  if (!existsSync(lockPath)) {
    return {
      checks: [check("fail", "repos_lock", `repos.lock.json not found: ${lockPath}`)],
      repositories: [],
    };
  }
  const lock = readRepositoriesLock(lockPath);
  const status = lock.runId === runId ? "ok" : "fail";
  return {
    checks: [
      check(status, "repos_lock", `repos.lock.json loaded with ${lock.repositories.length} repositories`, {
        lock_run_id: lock.runId,
      }),
    ],
    repositories: lock.repositories,
  };
}

/** Datos por celda para el perfil de distancia de grafo (diagnóstico). */
interface DistanceCell {
  strategyId: string;
  repoId: string;
  /** Anclas edit-site absolutas (símbolos + archivos editados). */
  anchors: string[];
  /** Node-ids internos recuperados en top-K primario. */
  retrievedInternal: string[];
}

function analyzeRecords(
  retrievalPath: string,
  runId: string,
  tasksById: Map<string, TaskDefinition>,
  lockedById: Map<string, LockedRepository>,
  reposDirectory: string,
  primaryCutoff: number,
  sweepCutoffs: number[],
): {
  checks: DoctorCheck[];
  analyses: RetrievalCellAnalysis[];
  executions: ExecutionMetricResult[];
  observedCells: Set<string>;
  distanceCells: DistanceCell[];
} {
  if (!existsSync(retrievalPath)) {
    return {
      checks: [check("fail", "retrieval_jsonl", `retrieval.jsonl not found: ${retrievalPath}`)],
      analyses: [],
      executions: [],
      observedCells: new Set(),
      distanceCells: [],
    };
  }
  const analyses: RetrievalCellAnalysis[] = [];
  const executions: ExecutionMetricResult[] = [];
  const observedCells = new Set<string>();
  const distanceCells: DistanceCell[] = [];
  const cellErrors: string[] = [];
  for (const { line, value } of readJsonl(retrievalPath)) {
    const path = `${retrievalPath}:${line}`;
    const record = parseRetrievalInput(value, path);
    if (record.runId !== runId) {
      cellErrors.push(`${path}: run_id ${record.runId} does not match ${runId}`);
      continue;
    }
    observedCells.add(`${record.taskId}\u0000${record.strategyId}`);
    const task = tasksById.get(record.taskId);
    if (task === undefined) {
      cellErrors.push(`${path}: unknown task_id ${record.taskId}`);
      continue;
    }
    const repoPath = lockedRepoPath(task.repo_id, lockedById, reposDirectory);
    const gold = buildPatchEvidenceGoldInput(task.gold.status, task.gold.patch_evidence, repoPath);
    analyses.push(analyzeRetrievalCell(record, value, gold));
    executions.push(computeExecutionMetrics(record, gold, primaryCutoff, sweepCutoffs));
    if (gold.status === "ready") {
      distanceCells.push({
        strategyId: record.strategyId,
        repoId: task.repo_id,
        anchors: [...gold.editSiteSymbols, ...gold.editSiteFiles],
        retrievedInternal: record.rankedNodes
          .filter(({ rank, nodeId }) => rank >= 1 && rank <= primaryCutoff && !isExternalNodeId(nodeId))
          .map(({ nodeId }) => nodeId),
      });
    }
    const raw = asRecord(value, path);
    const error = raw.error;
    if (record.exitCode !== 0 || error !== null) {
      cellErrors.push(`${record.taskId} x ${record.strategyId}: exit=${String(record.exitCode)} error=${JSON.stringify(error)}`);
    }
    const artifactPaths = raw.artifact_paths === undefined
      ? null
      : asRecord(raw.artifact_paths, `${path}.artifact_paths`);
    const contextJson = artifactPaths === null
      ? null
      : asString(artifactPaths.context_json, `${path}.artifact_paths.context_json`);
    if (contextJson === null || !existsSync(resolve(PROJECT_ROOT, contextJson))) {
      cellErrors.push(`${record.taskId} x ${record.strategyId}: missing context.json`);
    }
  }
  return {
    checks: [
      check(
        cellErrors.length === 0 ? "ok" : "fail",
        "retrieval_cells",
        `${analyses.length} retrieval cell(s) parsed; ${cellErrors.length} issue(s)`,
        cellErrors,
      ),
    ],
    analyses,
    executions,
    observedCells,
    distanceCells,
  };
}

/**
 * Resumen de cobertura estratificada + rank del primer gold, derivado de
 * `execution.details`. Da la lectura "qué estrato se recupera y qué tan temprano"
 * que el resumen macro agrega en un solo número.
 */
function checkCoverageSummary(executions: ExecutionMetricResult[]): DoctorCheck {
  const strata: EvidenceStratum[] = ["edit_site", "test", "ref", "definition"];
  const totals: Record<EvidenceStratum, { hit: number; total: number }> = {
    edit_site: { hit: 0, total: 0 },
    test: { hit: 0, total: 0 },
    ref: { hit: 0, total: 0 },
    definition: { hit: 0, total: 0 },
  };
  const editSiteRanks: number[] = [];
  let editSiteMissing = 0;
  let measured = 0;
  for (const execution of executions) {
    const details = execution.details;
    if (details === undefined) continue;
    measured += 1;
    for (const stratum of strata) {
      totals[stratum].hit += details.coverage_by_stratum[stratum].hit;
      totals[stratum].total += details.coverage_by_stratum[stratum].total;
    }
    if (details.first_edit_site_rank === null) editSiteMissing += 1;
    else editSiteRanks.push(details.first_edit_site_rank);
  }
  const coverageByStratum = Object.fromEntries(
    strata.map((stratum) => {
      const { hit, total } = totals[stratum];
      return [stratum, { hit, total, coverage: total === 0 ? null : hit / total }];
    }),
  );
  const sortedRanks = [...editSiteRanks].sort((a, b) => a - b);
  const medianRank = sortedRanks.length === 0
    ? null
    : sortedRanks[Math.floor((sortedRanks.length - 1) / 2)]!;
  return check(
    "ok",
    "patch_evidence_coverage",
    `${measured} celda(s) con detalle; edit-site rank mediana=${medianRank ?? "N/A"}, ` +
      `${editSiteMissing} sin edit-site en top-K`,
    {
      coverage_by_stratum: coverageByStratum,
      edit_site_first_rank: { median: medianRank, missing: editSiteMissing, measured: editSiteRanks.length },
    },
  );
}

function checkExpectedCells(
  selected: DoctorSelection,
  observedCells: Set<string>,
): DoctorCheck {
  const missing: string[] = [];
  for (const taskId of selected.tasks) {
    for (const strategyId of selected.strategies) {
      for (const variant of selected.sanitizer_variants) {
        const expected = expectedRecordStrategyId(strategyId, variant);
        if (!observedCells.has(`${taskId}\u0000${expected}`)) {
          missing.push(`${taskId} x ${expected}`);
        }
      }
    }
  }
  return check(
    missing.length === 0 ? "ok" : "fail",
    "expected_cells",
    `${selected.expected_cells} expected cell(s); ${missing.length} missing`,
    missing,
  );
}

function checkIndexes(
  repoIds: string[],
  indexesDirectory: string,
  graphDbName: string,
  vectorDirectoryName: string,
): DoctorCheck {
  const missing: string[] = [];
  for (const repoId of repoIds) {
    const graph = join(indexesDirectory, repoId, graphDbName);
    const vectors = join(indexesDirectory, repoId, vectorDirectoryName);
    if (!existsSync(graph)) missing.push(`${repoId}: missing graph DB ${graph}`);
    if (!existsSync(vectors)) missing.push(`${repoId}: missing LanceDB ${vectors}`);
  }
  return check(
    missing.length === 0 ? "ok" : "fail",
    "indexes",
    `${repoIds.length} selected repo index set(s) checked; ${missing.length} missing path(s)`,
    missing,
  );
}

/** Node-id absoluto de un símbolo del gold (`${abs(file)}#${symbol}`). */
function symbolNode(file: string, symbol: string, repoPath: string): string {
  return resolveNodeId(`${file}#${symbol}`, repoPath);
}

/**
 * Salud del PATCH-EVIDENCE gold (fuente principal, sin grafo). Diagnostica gold
 * ausente, edit-site vacío, dominado por archivos sin símbolo (fallback file-level),
 * refs sin resolver, y archivos del gold inexistentes tras resolver el lock.
 */
function checkPatchEvidence(
  tasks: TaskDefinition[],
  lockedById: Map<string, LockedRepository>,
  reposDirectory: string,
): DoctorCheck {
  const hard: string[] = [];
  const soft: string[] = [];
  const ready = tasks.filter(({ gold }) => gold.status === "ready");
  for (const task of ready) {
    const evidence = task.gold.patch_evidence;
    if (evidence === undefined) {
      hard.push(`${task.id}: gold.status ready but no patch_evidence (fuente principal ausente)`);
      continue;
    }
    const editSiteCount = evidence.edited_files.length + evidence.edited_symbols.length;
    if (editSiteCount === 0) {
      hard.push(`${task.id}: patch_evidence sin edit-site (ni archivos ni símbolos)`);
    } else if (editSiteCount === 1) {
      soft.push(`${task.id}: edit-site unitario (techo de discriminación bajo)`);
    }
    if (evidence.resolution.fell_back_to_file_level) {
      soft.push(`${task.id}: gold dominado por archivos sin símbolo (fallback file-level)`);
    }
    if (evidence.resolution.unresolved_refs.length > 0) {
      soft.push(`${task.id}: ${evidence.resolution.unresolved_refs.length} ref(s) introducida(s) sin resolver a definición interna`);
    }
    const repoPath = lockedRepoPath(task.repo_id, lockedById, reposDirectory);
    for (const file of evidence.edited_files) {
      if (!existsSync(resolveNodeId(file, repoPath))) {
        hard.push(`${task.id}: archivo editado del gold no existe tras resolver el lock: ${file}`);
      }
    }
  }
  const status: CheckStatus = hard.length > 0 ? "fail" : soft.length > 0 ? "warn" : "ok";
  return check(
    status,
    "patch_evidence_health",
    `${ready.length} ready task(s); ${hard.length} problema(s), ${soft.length} nota(s)`,
    { hard, soft },
  );
}

/**
 * DIAGNÓSTICO de grafo (nunca hace fallar el run): ¿los símbolos edit-site del
 * patch-evidence existen como nodos en el grafo? Si faltan, es señal de que el
 * grafo no cubre el edit-site — dato útil, no un fallo de gate.
 */
function checkGraphDiagnostic(
  tasks: TaskDefinition[],
  lockedById: Map<string, LockedRepository>,
  reposDirectory: string,
  indexesDirectory: string,
  graphDbName: string,
): DoctorCheck {
  const notes: string[] = [];
  const ready = tasks.filter(({ gold }) => gold.status === "ready" && gold.patch_evidence !== undefined);
  const graphByRepo = new Map<string, GraphLookup | null>();
  try {
    for (const task of ready) {
      const repoPath = lockedRepoPath(task.repo_id, lockedById, reposDirectory);
      const symbolNodes = (task.gold.patch_evidence?.edited_symbols ?? []).map((ref) =>
        symbolNode(ref.file, ref.symbol, repoPath),
      );
      if (symbolNodes.length === 0) continue;
      if (!graphByRepo.has(task.repo_id)) {
        const graphPath = findGraphDatabase(undefined, indexesDirectory, task.repo_id, graphDbName);
        graphByRepo.set(task.repo_id, graphPath === null ? null : openGraphLookup(graphPath));
      }
      const graph = graphByRepo.get(task.repo_id) ?? null;
      if (graph === null) {
        notes.push(`${task.id}: grafo no disponible (perfil de distancia se omite)`);
        continue;
      }
      for (const missing of graph.findMissingNodeIds(symbolNodes)) {
        notes.push(`${task.id}: símbolo edit-site ausente del grafo: ${missing}`);
      }
    }
  } finally {
    for (const graph of graphByRepo.values()) graph?.close();
  }
  // status warn/ok: el grafo es diagnóstico, no gatea.
  return check(
    notes.length === 0 ? "ok" : "warn",
    "graph_diagnostic",
    `${ready.length} ready task(s) contra el grafo (diagnóstico); ${notes.length} nota(s)`,
    notes,
  );
}

/** Buckets de distancia de grafo retrieved↔edit-site, por estrategia. */
export interface GraphDistanceProfile {
  strategy_id: string;
  /** Nodos internos top-K con anclas edit-site presentes en el grafo. */
  measured_nodes: number;
  buckets: Record<string, number>;
}

function bucketFor(distance: number | null): string {
  if (distance === null) return "unreachable";
  if (distance >= 4) return "4+";
  return String(distance);
}

/**
 * Perfil de distancia de grafo (diagnóstico). Para cada nodo interno recuperado
 * en top-K, la distancia MÍNIMA a cualquier ancla edit-site presente en el grafo;
 * con patches multi-archivo eso es "mínima a cualquier edit-site". Los resultados
 * de `distancesFrom` se cachean por (repo, ancla) porque el BFS es caro.
 */
function computeGraphDistanceProfiles(
  cells: DistanceCell[],
  indexesDirectory: string,
  graphDbName: string,
): GraphDistanceProfile[] {
  const byStrategy = new Map<string, { buckets: Record<string, number>; measured: number }>();
  const graphByRepo = new Map<string, GraphLookup | null>();
  const distanceCache = new Map<string, Map<string, number>>();
  try {
    for (const cell of cells) {
      if (!graphByRepo.has(cell.repoId)) {
        const graphPath = findGraphDatabase(undefined, indexesDirectory, cell.repoId, graphDbName);
        graphByRepo.set(cell.repoId, graphPath === null ? null : openGraphLookup(graphPath));
      }
      const graph = graphByRepo.get(cell.repoId) ?? null;
      if (graph === null) continue;
      // Solo anclas de tipo símbolo (los archivos no son nodos del grafo).
      const anchors = cell.anchors.filter((a) => a.includes("#"));
      if (anchors.length === 0) continue;
      let distanceMaps: Map<string, number>[];
      try {
        distanceMaps = anchors.map((anchor) => {
        const key = `${cell.repoId} ${anchor}`;
        let map = distanceCache.get(key);
        if (map === undefined) {
          map = graph.distancesFrom(anchor);
          distanceCache.set(key, map);
        }
        return map;
      });
      } catch {
        // Grafo sin tabla de aristas o BFS fallido → se omite el perfil de esta celda.
        continue;
      }
      const entry = byStrategy.get(cell.strategyId) ?? { buckets: {}, measured: 0 };
      for (const nodeId of cell.retrievedInternal) {
        let best: number | null = null;
        for (const map of distanceMaps) {
          const d = map.get(nodeId);
          if (d !== undefined && (best === null || d < best)) best = d;
        }
        const bucket = bucketFor(best);
        entry.buckets[bucket] = (entry.buckets[bucket] ?? 0) + 1;
        entry.measured += 1;
      }
      byStrategy.set(cell.strategyId, entry);
    }
  } finally {
    for (const graph of graphByRepo.values()) graph?.close();
  }
  return [...byStrategy.entries()]
    .map(([strategy_id, { buckets, measured }]) => ({ strategy_id, measured_nodes: measured, buckets }))
    .sort((a, b) => a.strategy_id.localeCompare(b.strategy_id));
}

function renderMarkdown(report: BenchmarkDoctorReport): string {
  const lines = [
    `# Benchmark doctor: ${report.run_id}`,
    "",
    `- Manifests: \`${report.inputs.manifests_dir}\``,
    `- Split: \`${report.selection.split}\``,
    `- Expected cells: ${report.selection.expected_cells}`,
    `- Parsed cells: ${report.retrieval_analysis.cells.length}`,
    "",
    "## Checks",
    "",
    "| check | status | message |",
    "|---|---|---|",
    ...report.checks.map(({ id, status, message }) => `| ${id} | ${status} | ${message.replaceAll("|", "\\|")} |`),
    "",
    "## Strategy diagnostics",
    "",
    "| strategy | cells | failed | excluded | single-gold | missing gold | RPR external | url | diff | evidence statuses |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---|",
    ...report.retrieval_analysis.by_strategy.map((item) =>
      `| ${item.strategy_id} | ${item.cells} | ${item.failed_cells} | ${item.excluded_cells} | ` +
      `${item.single_gold_cells} | ${item.no_gold_in_candidates} | ${item.rpr_external_terminal_nodes} | ` +
      `${item.query_noise.has_url} | ${item.query_noise.has_diff_block} | ` +
      `${JSON.stringify(item.evidence_status_counts).replaceAll("|", "\\|")} |`
    ),
    "",
    "## Graph distance profile (diagnostic)",
    "",
    "Distance (in edges) from each internal top-K node to the nearest edit-site anchor.",
    "",
    "| strategy | measured nodes | buckets (0/1/2/3/4+/unreachable) |",
    "|---|---:|---|",
    ...report.graph_distance_profile.map((item) =>
      `| ${item.strategy_id} | ${item.measured_nodes} | ${JSON.stringify(item.buckets).replaceAll("|", "\\|")} |`
    ),
    "",
  ];
  return `${lines.join("\n")}\n`;
}

export function runBenchmarkDoctor(argv = process.argv.slice(2)): BenchmarkDoctorReport {
  const options = parseEvalCliOptions(argv, [
    "--run-id",
    "--run-dir",
    "--repo-id",
    "--task-id",
    "--strategy-id",
    "--split",
    "--manifests-dir",
    "--strict",
  ]);
  const manifestsDirectory = resolveDoctorManifestsDir(options.manifestsDir);
  const manifestPaths = getManifestPaths(manifestsDirectory);
  const manifests = loadManifests(manifestsDirectory);
  const splitName = options.split ?? runMode(manifests.run);
  const split = splitRecord(manifests.run, splitName);
  const strategyIds = retrievalStrategies(manifests.run, split, splitName);
  const variants = sanitizerVariants(manifests.run, split, splitName);
  let tasks = selectedTasks(manifests.tasks.tasks, split, splitName, {
    repoId: options.repoId,
    taskId: options.taskId,
  });
  const strategies = selectedStrategies(manifests.strategies.strategies, strategyIds, options.strategyId);
  const layout = resolveDoctorLayout(manifests.run, { runId: options.runId, runDir: options.runDir });
  const lockPath = join(layout.runDirectory, basename(layout.lockFile));
  const lockResult = readLockCheck(lockPath, layout.runId);
  const lockedById = new Map(lockResult.repositories.map((repository) => [repository.id, repository]));
  if (options.repoId === undefined && lockedById.size > 0) {
    tasks = tasks.filter((task) => lockedById.has(task.repo_id));
  }
  const selectedRepoIds = [...new Set(tasks.map(({ repo_id }) => repo_id))].sort();
  const selected: DoctorSelection = {
    split: splitName,
    repos: selectedRepoIds,
    tasks: tasks.map(({ id }) => id).sort(),
    strategies: strategies.map(({ id }) => id).sort(),
    sanitizer_variants: [...variants].sort(),
    expected_cells: tasks.length * strategies.length * variants.length,
  };
  const { graphDbName, vectorDirectoryName } = indexNames(manifests.repos);
  const aggregation = asRecord(manifests.metrics.aggregation_policy, "metrics.yaml.aggregation_policy");
  const primaryCutoff = asNumber(
    aggregation.ranking_cutoff_primary,
    "metrics.yaml.aggregation_policy.ranking_cutoff_primary",
  );
  const sweepCutoffs = Array.isArray(aggregation.ranking_cutoff_sweep)
    ? aggregation.ranking_cutoff_sweep.map((value, index) =>
        asNumber(value, `metrics.yaml.aggregation_policy.ranking_cutoff_sweep[${index}]`),
      )
    : DEFAULT_SWEEP_CUTOFFS;
  const retrievalPath = join(layout.runDirectory, "retrieval.jsonl");
  const analyses = analyzeRecords(
    retrievalPath,
    layout.runId,
    new Map(manifests.tasks.tasks.map((task) => [task.id, task])),
    lockedById,
    layout.reposDirectory,
    primaryCutoff,
    sweepCutoffs,
  );
  const lockRepoIssues = selectedRepoIds.filter((repoId) => !lockedById.has(repoId));
  const checks = [
    ...lockResult.checks,
    check(
      lockRepoIssues.length === 0 ? "ok" : "fail",
      "selected_repos_locked",
      `${selectedRepoIds.length} selected repo(s); ${lockRepoIssues.length} missing from lock`,
      lockRepoIssues,
    ),
    checkIndexes(selectedRepoIds, layout.indexesDirectory, graphDbName, vectorDirectoryName),
    checkPatchEvidence(tasks, lockedById, layout.reposDirectory),
    checkGraphDiagnostic(tasks, lockedById, layout.reposDirectory, layout.indexesDirectory, graphDbName),
    checkCoverageSummary(analyses.executions),
    ...analyses.checks,
    checkExpectedCells(selected, analyses.observedCells),
  ];
  const graphDistanceProfile = computeGraphDistanceProfiles(
    analyses.distanceCells,
    layout.indexesDirectory,
    graphDbName,
  );
  const report: BenchmarkDoctorReport = {
    schema_version: 1,
    run_id: layout.runId,
    generated_at: new Date().toISOString(),
    inputs: {
      manifests_dir: relative(PROJECT_ROOT, manifestsDirectory === MANIFESTS_DIR ? MANIFESTS_DIR : manifestsDirectory),
      tasks_manifest: relative(PROJECT_ROOT, manifestPaths.tasks),
      metrics_manifest: relative(PROJECT_ROOT, manifestPaths.metrics),
      run_directory: relative(PROJECT_ROOT, layout.runDirectory),
      retrieval_jsonl: relative(PROJECT_ROOT, retrievalPath),
      repos_lock: relative(PROJECT_ROOT, lockPath),
    },
    selection: selected,
    checks,
    retrieval_analysis: {
      cells: analyses.analyses,
      by_strategy: summarizeRetrievalDiagnostics(analyses.analyses, analyses.executions),
    },
    graph_distance_profile: graphDistanceProfile,
  };

  mkdirSync(dirname(join(layout.runDirectory, "benchmark-doctor.json")), { recursive: true });
  writeFileSync(
    join(layout.runDirectory, "benchmark-doctor.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  writeFileSync(join(layout.runDirectory, "benchmark-doctor.md"), renderMarkdown(report), "utf8");

  if (options.strict === true && checks.some(({ status }) => status === "fail")) {
    throw new Error("benchmark doctor failed under --strict");
  }
  return report;
}

if (isEntrypoint(import.meta.url)) {
  try {
    const report = runBenchmarkDoctor();
    console.log(`Benchmark doctor: ${join(PROJECT_ROOT, report.inputs.run_directory, "benchmark-doctor.json")}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
