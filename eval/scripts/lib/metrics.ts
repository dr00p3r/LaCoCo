import { asNumber, asRecord, asString } from "./config.js";

export type MetricId = "M3" | "M4" | "M5" | "M6" | "M7";
export type MetricStatus =
  | "computed"
  | "excluded_from_gold_metrics"
  | "invalid_gold"
  | "not_applicable"
  | "failed_execution"
  | "missing_timing";

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

export interface GoldInput {
  status: string;
  relevantNodes: string[];
  multihopNodes: string[];
}

export interface MetricResult {
  status: MetricStatus;
  value: number | null;
  numerator?: number;
  denominator?: number;
}

export interface ExecutionMetricResult {
  run_id: string;
  task_id: string;
  repo_id: string;
  strategy_id: string;
  exit_code: number | null;
  metrics: Record<MetricId, MetricResult>;
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
  included_task_values: number;
  included_repo_values: number;
  excluded_task_values: number;
}

export interface ScopeSummary {
  scope_id: string;
  metrics: Record<MetricId, SummaryMetric>;
}

const METRIC_IDS: MetricId[] = ["M3", "M4", "M5", "M6", "M7"];

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

function intersectionCount(nodes: RankedNodeInput[], relevant: Set<string>, cutoff: number): number {
  const retrieved = new Set(
    nodes.filter(({ rank }) => rank >= 1 && rank <= cutoff).map(({ nodeId }) => nodeId),
  );
  let count = 0;
  for (const nodeId of relevant) {
    if (retrieved.has(nodeId)) count += 1;
  }
  return count;
}

export function precisionAtK(
  nodes: RankedNodeInput[],
  relevantNodes: Iterable<string>,
  cutoff: number,
): number {
  return intersectionCount(nodes, new Set(relevantNodes), cutoff) / cutoff;
}

export function recallAtK(
  nodes: RankedNodeInput[],
  relevantNodes: Iterable<string>,
  cutoff: number,
): number {
  const relevant = new Set(relevantNodes);
  return relevant.size === 0 ? 0 : intersectionCount(nodes, relevant, cutoff) / relevant.size;
}

export function mrr(nodes: RankedNodeInput[], relevantNodes: Iterable<string>): number {
  const relevant = new Set(relevantNodes);
  const firstRank = nodes
    .filter(({ nodeId, rank }) => rank >= 1 && relevant.has(nodeId))
    .reduce<number | null>((best, { rank }) => best === null || rank < best ? rank : best, null);
  return firstRank === null ? 0 : 1 / firstRank;
}

export function multiHopRecallAtK(
  nodes: RankedNodeInput[],
  multihopNodes: Iterable<string>,
  cutoff: number,
): MetricResult {
  const multihop = new Set(multihopNodes);
  if (multihop.size === 0) return unavailable("not_applicable");
  const intersection = intersectionCount(nodes, multihop, cutoff);
  return {
    status: "computed",
    value: intersection / multihop.size,
    numerator: intersection,
    denominator: multihop.size,
  };
}

export function computeExecutionMetrics(
  record: RetrievalInputRecord,
  gold: GoldInput,
  precisionCutoff = 5,
  multihopCutoff = 20,
): ExecutionMetricResult {
  if (record.exitCode !== 0) {
    const failed = unavailable("failed_execution");
    return {
      run_id: record.runId,
      task_id: record.taskId,
      repo_id: record.repoId,
      strategy_id: record.strategyId,
      exit_code: record.exitCode,
      metrics: { M3: failed, M4: failed, M5: failed, M6: failed, M7: failed },
    };
  }

  const latency = record.totalLatencyMs === null
    ? unavailable("missing_timing")
    : { status: "computed", value: record.totalLatencyMs } satisfies MetricResult;

  if (gold.status !== "ready") {
    const excluded = unavailable("excluded_from_gold_metrics");
    return {
      run_id: record.runId,
      task_id: record.taskId,
      repo_id: record.repoId,
      strategy_id: record.strategyId,
      exit_code: record.exitCode,
      metrics: { M3: excluded, M4: excluded, M5: excluded, M6: excluded, M7: latency },
    };
  }

  const relevant = new Set(gold.relevantNodes);
  const multihop = new Set(gold.multihopNodes);
  let m3: MetricResult;
  let m4: MetricResult;
  let m5: MetricResult;
  if (relevant.size === 0) {
    m3 = unavailable("invalid_gold");
    m4 = unavailable("invalid_gold");
    m5 = unavailable("invalid_gold");
  } else {
    const intersection = intersectionCount(record.rankedNodes, relevant, precisionCutoff);
    m3 = {
      status: "computed",
      value: precisionAtK(record.rankedNodes, relevant, precisionCutoff),
      numerator: intersection,
      denominator: precisionCutoff,
    };
    m4 = {
      status: "computed",
      value: recallAtK(record.rankedNodes, relevant, precisionCutoff),
      numerator: intersection,
      denominator: relevant.size,
    };
    m5 = { status: "computed", value: mrr(record.rankedNodes, relevant) };
  }

  const m6 = multiHopRecallAtK(record.rankedNodes, multihop, multihopCutoff);

  return {
    run_id: record.runId,
    task_id: record.taskId,
    repo_id: record.repoId,
    strategy_id: record.strategyId,
    exit_code: record.exitCode,
    metrics: { M3: m3, M4: m4, M5: m5, M6: m6, M7: latency },
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
    value: metricId === "M7" ? percentile(values, 95) : mean(values),
    included: values.length,
    excluded: results.length - values.length,
    status_counts: statusCounts(results),
  };
}

export function groupByTask(executions: ExecutionMetricResult[]): TaskMetricResult[] {
  const groups = new Map<string, ExecutionMetricResult[]>();
  for (const execution of executions) {
    const key = `${execution.task_id}\u0000${execution.repo_id}\u0000${execution.strategy_id}`;
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
  return {
    value: mean(macroRepoValues),
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
