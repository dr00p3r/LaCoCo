import { asNumber, asRecord, asString } from "./config.js";

/**
 * Métricas de recuperación contra el **patch-evidence gold** (ver
 * `lib/patch-evidence-gold.ts`). Reemplazan a Precision@5/Recall@5, que se
 * eliminaron: el retrieval ya no se mide como fin en sí mismo sino como
 * explicación de la calidad de contexto que llega al agente.
 *
 *  - EditSiteHit           : ¿aparece el edit-site (archivo o símbolo) en top-K?
 *  - PatchEvidenceHit      : ¿aparece CUALQUIER evidencia del patch en top-K?
 *  - MRR                   : rank recíproco del primer elemento de evidencia.
 *  - EditSiteMRR           : rank recíproco del primer elemento estrictamente edit-site.
 *  - UsefulContextCoverage : cobertura del conjunto completo de evidencia.
 *  - ExternalNoiseRate     : proporción de nodos externos/genéricos (`lib#…`) en top-K.
 *  - Latency               : P95 de la latencia total (eficiencia).
 */
export type MetricId =
  | "EditSiteHit"
  | "PatchEvidenceHit"
  | "MRR"
  | "EditSiteMRR"
  | "UsefulContextCoverage"
  | "ExternalNoiseRate"
  | "Latency";

export type MetricStatus =
  | "computed"
  | "excluded_from_gold_metrics"
  | "invalid_gold"
  | "gold_not_in_graph"
  | "index_unavailable"
  | "not_applicable"
  | "failed_execution"
  | "missing_timing";

/**
 * Veredicto de alcanzabilidad del gold edit-site en el grafo indexado, resuelto
 * por el caller (`compute-retrieval-metrics.ts`) abriendo `tensor.sqlite`. Si el
 * gold no está en el grafo (o el índice está vacío/ausente), `EditSiteHit` es
 * estructuralmente imposible: sus métricas de gold se excluyen del agregado en
 * vez de contarse como ceros silenciosos. Por defecto `reachable` para no
 * romper callers/tests que no pasan el veredicto.
 */
export type GoldReachability = "reachable" | "gold_not_in_graph" | "index_unavailable";

export type EvidenceStratum = "edit_site" | "test" | "ref" | "definition";

export interface RankedNodeInput {
  rank: number;
  nodeId: string;
}

export interface RetrievalInputRecord {
  schemaVersion: number;
  runId: string;
  taskId: string;
  repoId: string;
  strategyId: string;
  rankedNodes: RankedNodeInput[];
  totalLatencyMs: number | null;
  exitCode: number | null;
}

/**
 * Gold de patch-evidence resuelto a rutas ABSOLUTAS (los node-ids del retrieval
 * son absolutos). El caller (`compute-retrieval-metrics.ts`) resuelve el gold
 * repo-relativo del manifest contra el repoPath del lock antes de pasarlo aquí.
 *
 * Un símbolo es `absPath#symbol`; un archivo es `absPath`. `editSiteSymbols`
 * puede estar vacío (patch sin nodo mapeable) → el edit-site se compara a nivel
 * archivo.
 */
export interface GoldInput {
  status: string;
  editSiteFiles: string[];
  editSiteSymbols: string[];
  testFiles: string[];
  refNodes: string[];
  definitionNodes: string[];
}

export interface MetricResult {
  status: MetricStatus;
  value: number | null;
  numerator?: number;
  denominator?: number;
}

/** Detalle por-celda no agregado: barrido de K, cobertura por estrato, ranks. */
export interface ExecutionDetails {
  sweep: Array<{
    k: number;
    edit_site_hit: number;
    patch_evidence_hit: number;
    useful_context_coverage: number;
    external_noise_rate: number;
  }>;
  coverage_by_stratum: Record<EvidenceStratum, { hit: number; total: number }>;
  first_edit_site_rank: number | null;
  first_evidence_rank: number | null;
}

export interface ExecutionMetricResult {
  run_id: string;
  task_id: string;
  repo_id: string;
  strategy_id: string;
  exit_code: number | null;
  metrics: Record<MetricId, MetricResult>;
  details?: ExecutionDetails;
}

export interface TaskMetricResult {
  task_id: string;
  repo_id: string;
  strategy_id: string;
  execution_count: number;
  successful_execution_count: number;
  metrics: Record<MetricId, AggregatedMetric>;
}

export interface AggregatedMetric {
  status: MetricStatus;
  value: number | null;
  included: number;
  excluded: number;
  status_counts: Partial<Record<MetricStatus, number>>;
}

export interface SummaryMetric {
  value: number | null;
  ci_low: number | null;
  ci_high: number | null;
  ci_iterations: number;
  included_task_values: number;
  included_repo_values: number;
  excluded_task_values: number;
}

export interface ScopeSummary {
  scope_id: string;
  metrics: Record<MetricId, SummaryMetric>;
}

export const METRIC_IDS: MetricId[] = [
  "EditSiteHit",
  "PatchEvidenceHit",
  "MRR",
  "EditSiteMRR",
  "UsefulContextCoverage",
  "ExternalNoiseRate",
  "Latency",
];

/** K por defecto para el resumen (aproxima el contexto realmente inyectado). */
export const DEFAULT_PRIMARY_CUTOFF = 10;
/** Barrido de K por defecto (curva cobertura vs. tamaño de contexto). */
export const DEFAULT_SWEEP_CUTOFFS = [1, 3, 5, 10, 20];

function nullableNumber(value: unknown, path: string): number | null {
  if (value === null || value === undefined) return null;
  return asNumber(value, path);
}

export function parseRetrievalInput(value: unknown, path: string): RetrievalInputRecord {
  const root = asRecord(value, path);
  const rankedValue = root.ranked_nodes ?? root.chunks;
  if (!Array.isArray(rankedValue)) {
    throw new Error(`${path}.ranked_nodes or ${path}.chunks must be an array`);
  }
  const rankedNodes = rankedValue.map((entry, index) => {
    const nodePath = `${path}.ranked_nodes[${index}]`;
    const node = asRecord(entry, nodePath);
    const nodeId = node.node_id ?? node.nodeId;
    return {
      rank: node.rank === undefined ? index + 1 : asNumber(node.rank, `${nodePath}.rank`),
      nodeId: asString(nodeId, `${nodePath}.node_id or nodeId`),
    };
  });
  const timings = root.timings_ms === undefined
    ? {}
    : asRecord(root.timings_ms, `${path}.timings_ms`);
  const latencyValue = timings.total ?? timings.total_ms ?? timings.totalLatencyMs;
  const totalLatencyMs = nullableNumber(latencyValue, `${path}.timings_ms.total`);
  if (totalLatencyMs !== null && totalLatencyMs < 0) {
    throw new Error(`${path}.timings_ms total must be non-negative`);
  }
  const exitCode = nullableNumber(root.exit_code, `${path}.exit_code`);
  return {
    schemaVersion: asNumber(root.schema_version, `${path}.schema_version`),
    runId: asString(root.run_id, `${path}.run_id`),
    taskId: asString(root.task_id, `${path}.task_id`),
    repoId: asString(root.repo_id, `${path}.repo_id`),
    strategyId: asString(root.strategy_id, `${path}.strategy_id`),
    rankedNodes,
    totalLatencyMs,
    exitCode,
  };
}

function unavailable(status: MetricStatus): MetricResult {
  return { status, value: null };
}

// --- Utilidades de node-id ---------------------------------------------------

/** Parte de ruta de un node-id (`path#symbol` → `path`; sin `#` → todo). */
export function fileOfNodeId(nodeId: string): string {
  const hash = nodeId.indexOf("#");
  return hash === -1 ? nodeId : nodeId.slice(0, hash);
}

/**
 * ¿El node-id es externo/genérico (no un archivo del repo)? Heurística acotada:
 * el prefijo `lib#` (símbolos de librería que emite el retriever) o una ruta
 * dentro de `node_modules`. NO es "todo lo que no es gold": el gold automático
 * nunca captura el 100% del contexto legítimo, así que `1 − coverage ≠ ruido`.
 */
export function isExternalNodeId(nodeId: string): boolean {
  if (nodeId.startsWith("lib#")) return true;
  const file = fileOfNodeId(nodeId);
  return file.includes("/node_modules/");
}

interface TopKSets {
  nodeIds: Set<string>;
  files: Set<string>;
}

function topKSets(nodes: RankedNodeInput[], cutoff: number, internalOnly = false): TopKSets {
  const nodeIds = new Set<string>();
  const files = new Set<string>();
  for (const { rank, nodeId } of nodes) {
    if (rank < 1 || rank > cutoff) continue;
    if (internalOnly && isExternalNodeId(nodeId)) continue;
    nodeIds.add(nodeId);
    files.add(fileOfNodeId(nodeId));
  }
  return { nodeIds, files };
}

// --- Ítems de cobertura (estratificados) -------------------------------------

export interface EvidenceItem {
  stratum: EvidenceStratum;
  kind: "file" | "node";
  value: string;
}

/**
 * Construye el conjunto de ítems de evidencia para UsefulContextCoverage,
 * evitando doble conteo: cada archivo editado aporta sus símbolos (si mapearon)
 * o, si no, el archivo mismo (fallback file-level).
 */
export function buildCoverageItems(gold: GoldInput): EvidenceItem[] {
  const items: EvidenceItem[] = [];
  const filesWithSymbol = new Set(gold.editSiteSymbols.map(fileOfNodeId));
  for (const sym of gold.editSiteSymbols) items.push({ stratum: "edit_site", kind: "node", value: sym });
  for (const file of gold.editSiteFiles) {
    if (!filesWithSymbol.has(file)) items.push({ stratum: "edit_site", kind: "file", value: file });
  }
  for (const test of gold.testFiles) items.push({ stratum: "test", kind: "file", value: test });
  for (const ref of gold.refNodes) items.push({ stratum: "ref", kind: "node", value: ref });
  for (const def of gold.definitionNodes) items.push({ stratum: "definition", kind: "node", value: def });
  const seen = new Map<string, EvidenceItem>();
  for (const item of items) seen.set(`${item.stratum} ${item.kind} ${item.value}`, item);
  return [...seen.values()];
}

function itemHit(item: EvidenceItem, sets: TopKSets): boolean {
  return item.kind === "node" ? sets.nodeIds.has(item.value) : sets.files.has(item.value);
}

// --- Primitivas de métrica ---------------------------------------------------

export function editSiteHitAtK(nodes: RankedNodeInput[], gold: GoldInput, cutoff: number): boolean {
  const sets = topKSets(nodes, cutoff);
  const symbols = new Set(gold.editSiteSymbols);
  const files = new Set(gold.editSiteFiles);
  for (const id of sets.nodeIds) if (symbols.has(id)) return true;
  for (const file of sets.files) if (files.has(file)) return true;
  return false;
}

export function patchEvidenceHitAtK(nodes: RankedNodeInput[], gold: GoldInput, cutoff: number): boolean {
  // internalOnly: un nodo `lib#…` recuperado NUNCA cuenta como evidencia.
  const sets = topKSets(nodes, cutoff, true);
  const nodeGold = new Set([...gold.editSiteSymbols, ...gold.refNodes, ...gold.definitionNodes]);
  const fileGold = new Set([...gold.editSiteFiles, ...gold.testFiles]);
  for (const id of sets.nodeIds) if (nodeGold.has(id)) return true;
  for (const file of sets.files) if (fileGold.has(file)) return true;
  return false;
}

function firstMatchingRank(
  nodes: RankedNodeInput[],
  nodeGold: Set<string>,
  fileGold: Set<string>,
): number | null {
  let best: number | null = null;
  for (const { rank, nodeId } of nodes) {
    if (rank < 1) continue;
    if (nodeGold.has(nodeId) || fileGold.has(fileOfNodeId(nodeId))) {
      if (best === null || rank < best) best = rank;
    }
  }
  return best;
}

/** MRR sobre toda la evidencia. Sin hit ⇒ 0 (la tarea se cuenta igual). */
export function mrrEvidence(nodes: RankedNodeInput[], gold: GoldInput): { value: number; rank: number | null } {
  const nodeGold = new Set([...gold.editSiteSymbols, ...gold.refNodes, ...gold.definitionNodes]);
  const fileGold = new Set([...gold.editSiteFiles, ...gold.testFiles]);
  const rank = firstMatchingRank(nodes.filter((n) => !isExternalNodeId(n.nodeId)), nodeGold, fileGold);
  return { value: rank === null ? 0 : 1 / rank, rank };
}

/** MRR sobre el edit-site estricto (archivo o símbolo editado). */
export function mrrEditSite(nodes: RankedNodeInput[], gold: GoldInput): { value: number; rank: number | null } {
  const rank = firstMatchingRank(nodes, new Set(gold.editSiteSymbols), new Set(gold.editSiteFiles));
  return { value: rank === null ? 0 : 1 / rank, rank };
}

export interface CoverageResult {
  value: number;
  numerator: number;
  denominator: number;
  byStratum: Record<EvidenceStratum, { hit: number; total: number }>;
}

export function usefulContextCoverageAtK(
  nodes: RankedNodeInput[],
  items: EvidenceItem[],
  cutoff: number,
): CoverageResult {
  const sets = topKSets(nodes, cutoff);
  const byStratum: Record<EvidenceStratum, { hit: number; total: number }> = {
    edit_site: { hit: 0, total: 0 },
    test: { hit: 0, total: 0 },
    ref: { hit: 0, total: 0 },
    definition: { hit: 0, total: 0 },
  };
  let hits = 0;
  for (const item of items) {
    byStratum[item.stratum].total += 1;
    if (itemHit(item, sets)) {
      hits += 1;
      byStratum[item.stratum].hit += 1;
    }
  }
  const denominator = items.length;
  return {
    value: denominator === 0 ? 0 : hits / denominator,
    numerator: hits,
    denominator,
    byStratum,
  };
}

export function externalNoiseRateAtK(nodes: RankedNodeInput[], cutoff: number): MetricResult {
  const inTopK = nodes.filter(({ rank }) => rank >= 1 && rank <= cutoff);
  const denominator = inTopK.length;
  if (denominator === 0) return { status: "computed", value: 0, numerator: 0, denominator: 0 };
  const external = inTopK.filter(({ nodeId }) => isExternalNodeId(nodeId)).length;
  return { status: "computed", value: external / denominator, numerator: external, denominator };
}

function hasEditSite(gold: GoldInput): boolean {
  return gold.editSiteFiles.length > 0 || gold.editSiteSymbols.length > 0;
}

export function computeExecutionMetrics(
  record: RetrievalInputRecord,
  gold: GoldInput,
  primaryCutoff = DEFAULT_PRIMARY_CUTOFF,
  sweepCutoffs: number[] = DEFAULT_SWEEP_CUTOFFS,
  reachability: GoldReachability = "reachable",
): ExecutionMetricResult {
  const base = {
    run_id: record.runId,
    task_id: record.taskId,
    repo_id: record.repoId,
    strategy_id: record.strategyId,
    exit_code: record.exitCode,
  };

  if (record.exitCode !== 0) {
    const failed = unavailable("failed_execution");
    return {
      ...base,
      metrics: {
        EditSiteHit: failed,
        PatchEvidenceHit: failed,
        MRR: failed,
        EditSiteMRR: failed,
        UsefulContextCoverage: failed,
        ExternalNoiseRate: failed,
        Latency: failed,
      },
    };
  }

  const latency: MetricResult = record.totalLatencyMs === null
    ? unavailable("missing_timing")
    : { status: "computed", value: record.totalLatencyMs };

  if (gold.status !== "ready") {
    const excluded = unavailable("excluded_from_gold_metrics");
    return {
      ...base,
      metrics: {
        EditSiteHit: excluded,
        PatchEvidenceHit: excluded,
        MRR: excluded,
        EditSiteMRR: excluded,
        UsefulContextCoverage: excluded,
        ExternalNoiseRate: latency.status === "computed" ? externalNoiseRateAtK(record.rankedNodes, primaryCutoff) : excluded,
        Latency: latency,
      },
    };
  }

  if (!hasEditSite(gold)) {
    const invalid = unavailable("invalid_gold");
    return {
      ...base,
      metrics: {
        EditSiteHit: invalid,
        PatchEvidenceHit: invalid,
        MRR: invalid,
        EditSiteMRR: invalid,
        UsefulContextCoverage: invalid,
        ExternalNoiseRate: externalNoiseRateAtK(record.rankedNodes, primaryCutoff),
        Latency: latency,
      },
    };
  }

  // Gate de alcanzabilidad: el gold edit-site existe en el manifest pero no en el
  // grafo indexado (o el índice está vacío/ausente) → el hit es imposible. Se
  // excluyen las métricas dependientes de gold; ExternalNoiseRate/Latency (que no
  // dependen del gold) se mantienen.
  if (reachability !== "reachable") {
    const excluded = unavailable(reachability);
    return {
      ...base,
      metrics: {
        EditSiteHit: excluded,
        PatchEvidenceHit: excluded,
        MRR: excluded,
        EditSiteMRR: excluded,
        UsefulContextCoverage: excluded,
        ExternalNoiseRate: externalNoiseRateAtK(record.rankedNodes, primaryCutoff),
        Latency: latency,
      },
    };
  }

  const items = buildCoverageItems(gold);
  const evidence = mrrEvidence(record.rankedNodes, gold);
  const editSite = mrrEditSite(record.rankedNodes, gold);
  const coverage = usefulContextCoverageAtK(record.rankedNodes, items, primaryCutoff);
  const noise = externalNoiseRateAtK(record.rankedNodes, primaryCutoff);

  const sweep = sweepCutoffs.map((k) => {
    const cov = usefulContextCoverageAtK(record.rankedNodes, items, k);
    return {
      k,
      edit_site_hit: editSiteHitAtK(record.rankedNodes, gold, k) ? 1 : 0,
      patch_evidence_hit: patchEvidenceHitAtK(record.rankedNodes, gold, k) ? 1 : 0,
      useful_context_coverage: cov.value,
      external_noise_rate: externalNoiseRateAtK(record.rankedNodes, k).value ?? 0,
    };
  });

  return {
    ...base,
    metrics: {
      EditSiteHit: {
        status: "computed",
        value: editSiteHitAtK(record.rankedNodes, gold, primaryCutoff) ? 1 : 0,
      },
      PatchEvidenceHit: {
        status: "computed",
        value: patchEvidenceHitAtK(record.rankedNodes, gold, primaryCutoff) ? 1 : 0,
      },
      MRR: { status: "computed", value: evidence.value },
      EditSiteMRR: { status: "computed", value: editSite.value },
      UsefulContextCoverage: {
        status: "computed",
        value: coverage.value,
        numerator: coverage.numerator,
        denominator: coverage.denominator,
      },
      ExternalNoiseRate: noise,
      Latency: latency,
    },
    details: {
      sweep,
      coverage_by_stratum: coverage.byStratum,
      first_edit_site_rank: editSite.rank,
      first_evidence_rank: evidence.rank,
    },
  };
}

export function percentile(values: number[], percentileValue: number): number | null {
  if (values.length === 0) return null;
  if (percentileValue < 0 || percentileValue > 100) {
    throw new Error("percentile must be between 0 and 100");
  }
  const sorted = [...values].sort((left, right) => left - right);
  const position = (percentileValue / 100) * (sorted.length - 1);
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sorted[lowerIndex]!;
  const upper = sorted[upperIndex]!;
  return lower + (upper - lower) * (position - lowerIndex);
}

/**
 * Mulberry32 PRNG: 32-bit seedable, deterministic, fast.
 * Used to make bootstrap CIs reproducible across runs.
 */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function sampleWithReplacement<T>(values: readonly T[], rng: () => number): T[] {
  const size = values.length;
  const out: T[] = new Array(size);
  for (let index = 0; index < size; index += 1) {
    out[index] = values[Math.floor(rng() * size)]!;
  }
  return out;
}

export interface BootstrapOptions {
  iterations?: number;
  alpha?: number;
  seed?: number;
}

export interface BootstrapResult {
  ci_low: number | null;
  ci_high: number | null;
  iterations: number;
}

/**
 * Bootstrap CI for a continuous estimator (mean of a sample). Resamples
 * `values` with replacement `iterations` times and returns the
 * [alpha/2, 1 - alpha/2] percentile interval of the per-iteration mean.
 * Returns nulls when fewer than 2 distinct values exist (degenerate
 * distribution; CI collapses to a point).
 */
export function bootstrapMean(
  values: readonly number[],
  options: BootstrapOptions = {},
): BootstrapResult {
  const iterations = options.iterations ?? 1000;
  const alpha = options.alpha ?? 0.05;
  const seed = options.seed ?? 42;
  if (values.length < 2) {
    return { ci_low: null, ci_high: null, iterations };
  }
  const distinct = new Set(values);
  if (distinct.size < 2) {
    return { ci_low: null, ci_high: null, iterations };
  }
  const rng = mulberry32(seed);
  const means = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample = sampleWithReplacement(values, rng);
    let total = 0;
    for (const value of resample) total += value;
    means[iteration] = total / resample.length;
  }
  return {
    ci_low: percentile(means, (alpha / 2) * 100),
    ci_high: percentile(means, (1 - alpha / 2) * 100),
    iterations,
  };
}

/**
 * Bootstrap CI for a binomial proportion (e.g. pass rate over n trials).
 * Treats `successes / n` as a Bernoulli sample and resamples the binary
 * outcomes `iterations` times. Returns nulls when n < 2 or when the
 * sample is degenerate (all pass or all fail).
 */
export function bootstrapRate(
  successes: number,
  total: number,
  options: BootstrapOptions = {},
): BootstrapResult {
  const iterations = options.iterations ?? 1000;
  const alpha = options.alpha ?? 0.05;
  const seed = options.seed ?? 42;
  if (total < 2 || successes < 0 || successes > total) {
    return { ci_low: null, ci_high: null, iterations };
  }
  if (successes === 0 || successes === total) {
    return { ci_low: null, ci_high: null, iterations };
  }
  const outcomes: number[] = new Array<number>(total);
  for (let index = 0; index < total; index += 1) {
    outcomes[index] = index < successes ? 1 : 0;
  }
  const rng = mulberry32(seed);
  const rates = new Array<number>(iterations);
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample = sampleWithReplacement(outcomes, rng);
    let count = 0;
    for (const outcome of resample) count += outcome;
    rates[iteration] = count / resample.length;
  }
  return {
    ci_low: percentile(rates, (alpha / 2) * 100),
    ci_high: percentile(rates, (1 - alpha / 2) * 100),
    iterations,
  };
}

function statusCounts(results: MetricResult[]): Partial<Record<MetricStatus, number>> {
  const counts: Partial<Record<MetricStatus, number>> = {};
  for (const result of results) counts[result.status] = (counts[result.status] ?? 0) + 1;
  return counts;
}

function fallbackStatus(results: MetricResult[]): MetricStatus {
  const priority: MetricStatus[] = [
    "invalid_gold",
    "not_applicable",
    "excluded_from_gold_metrics",
    "failed_execution",
    "missing_timing",
  ];
  return priority.find((status) => results.some((result) => result.status === status)) ?? "missing_timing";
}

function aggregateMetric(results: MetricResult[], metricId: MetricId): AggregatedMetric {
  const values = results
    .filter((result): result is MetricResult & { value: number } =>
      result.status === "computed" && result.value !== null,
    )
    .map(({ value }) => value);
  return {
    status: values.length > 0 ? "computed" : fallbackStatus(results),
    value: metricId === "Latency" ? percentile(values, 95) : mean(values),
    included: values.length,
    excluded: results.length - values.length,
    status_counts: statusCounts(results),
  };
}

export function groupByTask(executions: ExecutionMetricResult[]): TaskMetricResult[] {
  const groups = new Map<string, ExecutionMetricResult[]>();
  for (const execution of executions) {
    const key = `${execution.task_id} ${execution.repo_id} ${execution.strategy_id}`;
    const current = groups.get(key) ?? [];
    current.push(execution);
    groups.set(key, current);
  }
  return [...groups.values()].map((group) => {
    const first = group[0]!;
    return {
      task_id: first.task_id,
      repo_id: first.repo_id,
      strategy_id: first.strategy_id,
      execution_count: group.length,
      successful_execution_count: group.filter(({ exit_code }) => exit_code === 0).length,
      metrics: Object.fromEntries(
        METRIC_IDS.map((id) => [id, aggregateMetric(group.map(({ metrics }) => metrics[id]), id)]),
      ) as Record<MetricId, AggregatedMetric>,
    };
  }).sort((left, right) =>
    left.repo_id.localeCompare(right.repo_id) ||
    left.task_id.localeCompare(right.task_id) ||
    left.strategy_id.localeCompare(right.strategy_id),
  );
}

function mean(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, value) => total + value, 0) / values.length;
}

function summarizeMetric(groups: TaskMetricResult[], metricId: MetricId): SummaryMetric {
  const computed = groups.filter(({ metrics }) => metrics[metricId].value !== null);
  const repoValues = new Map<string, number[]>();
  for (const group of computed) {
    const values = repoValues.get(group.repo_id) ?? [];
    values.push(group.metrics[metricId].value!);
    repoValues.set(group.repo_id, values);
  }
  const macroRepoValues = [...repoValues.values()]
    .map((values) => mean(values))
    .filter((value): value is number => value !== null);
  const aggregated = mean(macroRepoValues);
  // Bootstrap sobre los valores task-level (no sobre los promedios de repo) preserva
  // la variabilidad intra-repo y reporta la incertidumbre del estimador macro.
  const flatTaskValues = computed.map((group) => group.metrics[metricId].value!);
  const ci = bootstrapMean(flatTaskValues);
  return {
    value: aggregated,
    ci_low: ci.ci_low,
    ci_high: ci.ci_high,
    ci_iterations: ci.iterations,
    included_task_values: computed.length,
    included_repo_values: macroRepoValues.length,
    excluded_task_values: groups.length - computed.length,
  };
}

function scopeSummary(scopeId: string, groups: TaskMetricResult[]): ScopeSummary {
  return {
    scope_id: scopeId,
    metrics: Object.fromEntries(
      METRIC_IDS.map((id) => [id, summarizeMetric(groups, id)]),
    ) as Record<MetricId, SummaryMetric>,
  };
}

export function summarizeTaskMetrics(taskResults: TaskMetricResult[]): {
  by_strategy: ScopeSummary[];
  by_repo: ScopeSummary[];
  global: ScopeSummary;
} {
  const strategies = [...new Set(taskResults.map(({ strategy_id }) => strategy_id))].sort();
  const repos = [...new Set(taskResults.map(({ repo_id }) => repo_id))].sort();
  return {
    by_strategy: strategies.map((strategy) =>
      scopeSummary(strategy, taskResults.filter(({ strategy_id }) => strategy_id === strategy)),
    ),
    by_repo: repos.map((repo) =>
      scopeSummary(repo, taskResults.filter(({ repo_id }) => repo_id === repo)),
    ),
    global: scopeSummary("global", taskResults),
  };
}
