import { METRIC_IDS, type MetricId, type ScopeSummary } from "./metrics.js";

export interface RetrievalSummary {
  by_strategy: ScopeSummary[];
  by_repo: ScopeSummary[];
  global: ScopeSummary;
}

function csvCell(value: string | number | null): string {
  const text = value === null ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function summaryRows(summary: RetrievalSummary): Array<{
  scope: string;
  scopeId: string;
  metricId: MetricId;
  value: number | null;
  ciLow: number | null;
  ciHigh: number | null;
  ciIterations: number;
  includedTasks: number;
  includedRepos: number;
  excludedTasks: number;
}> {
  const scopes = [
    ...summary.by_strategy.map((entry) => ({ scope: "strategy", entry })),
    ...summary.by_repo.map((entry) => ({ scope: "repo", entry })),
    { scope: "global", entry: summary.global },
  ];
  return scopes.flatMap(({ scope, entry }) =>
    METRIC_IDS.map((metricId) => {
      const metric = entry.metrics[metricId];
      return {
        scope,
        scopeId: entry.scope_id,
        metricId,
        value: metric.value,
        ciLow: metric.ci_low,
        ciHigh: metric.ci_high,
        ciIterations: metric.ci_iterations,
        includedTasks: metric.included_task_values,
        includedRepos: metric.included_repo_values,
        excludedTasks: metric.excluded_task_values,
      };
    }),
  );
}

export function renderSummaryCsv(summary: RetrievalSummary): string {
  const header = [
    "scope",
    "scope_id",
    "metric_id",
    "value",
    "ci_low",
    "ci_high",
    "ci_iterations",
    "included_task_values",
    "included_repo_values",
    "excluded_task_values",
  ];
  const rows = summaryRows(summary).map((row) => [
    row.scope,
    row.scopeId,
    row.metricId,
    row.value,
    row.ciLow,
    row.ciHigh,
    row.ciIterations,
    row.includedTasks,
    row.includedRepos,
    row.excludedTasks,
  ].map(csvCell).join(","));
  return `${[header.join(","), ...rows].join("\n")}\n`;
}

function displayValue(value: number | null): string {
  return value === null ? "N/A" : Number(value.toFixed(6)).toString();
}

function displayCi(low: number | null, high: number | null): string {
  if (low === null || high === null) return "N/A";
  return `[${Number(low.toFixed(4))}, ${Number(high.toFixed(4))}]`;
}

export function renderSummaryMarkdown(runId: string, summary: RetrievalSummary): string {
  const rows = summaryRows(summary).map((row) =>
    `| ${row.scope} | ${row.scopeId} | ${row.metricId} | ${displayValue(row.value)} | ` +
    `${displayCi(row.ciLow, row.ciHigh)} | ` +
    `${row.includedTasks} | ${row.includedRepos} | ${row.excludedTasks} |`,
  );
  return [
    `# Retrieval metrics: ${runId}`,
    "",
    "Primary aggregation: macro by task within each repository, then macro across repositories.",
    "Confidence intervals: bootstrap on task-level values (1000 iterations, seed=42, alpha=0.05).",
    "",
    "| Scope | ID | Metric | Value | 95% CI | Included tasks | Included repos | Excluded tasks |",
    "|---|---|---:|---:|---:|---:|---:|---:|",
    ...rows,
    "",
  ].join("\n");
}
