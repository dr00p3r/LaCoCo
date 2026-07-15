/**
 * compute-generation-metrics.ts
 *
 * Calcula las 4 sub-metricas de M1 (modo regresion) y M2 (Hallucination Rate)
 * a partir de:
 *   - generation.jsonl  (M1 inputs: agent_exit_code, test_exit_code, patch_applied,
 *                         timeout, baseline_failing_tests, post_failing_tests,
 *                         grading_tests_passed, regression_introduced_failures)
 *   - hallucinations.jsonl  (M2 inputs: invalid_calls, analyzable_calls, unknown_calls)
 *
 * Salida: generation-metrics.json + summary.csv/md adicionales.
 *
 * Convenciones (M1 regresion):
 *  - M1_regression_pass (citable)  = baseline_failing_tests vacio
 *                                     ∧ test_exit_code === 0
 *                                     ∧ patch_applied
 *                                     ∧ !timeout
 *  - M1_grading_pass               = todos los grading_tests pasan tras el agente
 *  - M1_target_pass                = test_exit_code === 0
 *  - M1_regression_introduced      = post_failing − baseline_failing
 *
 * Modo legacy (sin regression metadata): cae al M1 clasico
 * (test_exit_code === 0 && patch_applied && !timeout).
 *
 * M2: invalid_calls / (invalid_calls + analyzable_calls); unknown_calls excluded.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvalCliOptions, isEntrypoint } from "./lib/cli.js";
import { loadManifests } from "./lib/load-manifests.js";
import { resolveEvalLayout } from "./lib/layout.js";
import type { GenerationRecord } from "./lib/generation-record.js";
import { bootstrapMean, bootstrapRate, percentile } from "./lib/metrics.js";
import { resolveManifestsDir } from "./lib/paths.js";

type Ci = { ci_low: number | null; ci_high: number | null; iterations: number };

/** Agregado por estrategia (M1/M2 + panel de tiempo/costo del agente). */
interface StrategyAggregate {
  m1_pass_rate: number;
  m1_pass_rate_ci: Ci;
  m1_regression_pass_rate: number | null;
  m1_regression_pass_rate_ci: Ci | null;
  m1_grading_pass_rate: number | null;
  m1_target_pass_rate: number;
  m1_regression_introduced_mean: number;
  m1_regression_introduced_mean_ci: Ci;
  m1_total: number;
  m1_regression_total: number;
  m1_unknown_runner_count: number;
  m2_hallucination_rate: number | null;
  m2_hallucination_rate_ci: Ci | null;
  m2_unknown_ratio: number | null;
  m2_total_calls: number;
  // --- Panel norte (role: agent_outcome) ---
  // El agente recibe el contexto YA inyectado (sin hook vivo), asi que
  // agent_duration_ms excluye la recuperacion. El total end-to-end suma el
  // overhead de recuperacion (retrieval.jsonl timings_ms.total; 0 para no_context)
  // para la lectura justa vs no_context.
  agent_duration_ms_mean: number | null;
  agent_duration_ms_p95: number | null;
  retrieval_overhead_ms_mean: number;
  end_to_end_ms_mean: number | null;
  end_to_end_ms_p95: number | null;
  cost_usd_mean: number | null;
  cost_usd_total: number | null;
  cost_cells: number;
  // Esfuerzo del agente independiente del costo (parseado del stream de opencode).
  tokens_total_mean: number | null;
  tokens_total_sum: number | null;
  tool_calls_mean: number | null;
  // Perfil de herramientas: media por herramienta a traves de las celdas con telemetria.
  by_tool_mean: Record<string, number>;
  effort_cells: number;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((s, v) => s + v, 0) / values.length;
}

interface HallucinationRecord {
  schema_version: 1;
  run_id: string;
  task_id: string;
  repo_id: string;
  strategy_id: string;
  agent_id: string;
  files_analyzed: string[];
  invalid_calls: number;
  analyzable_calls: number;
  unknown_calls: number;
  invalid_symbols: Array<{ symbol: string; file: string; line: number }>;
  notes: string[];
}

interface GenerationCellMetrics {
  cell_id: string;
  task_id: string;
  repo_id: string;
  strategy_id: string;
  agent_id: string;
  model_id: string;
  m1_pass: boolean | null;
  m1_regression_pass: boolean | null;
  m1_grading_pass: boolean | null;
  m1_target_pass: boolean | null;
  m1_regression_introduced: number;
  m1_test_exit_code: number | null;
  m1_patch_applied: boolean;
  m1_agent_exit_code: number | null;
  m1_timeout: boolean;
  m1_runner_error: "unknown_runner" | null;
  baseline_failing_tests: string[];
  post_failing_tests: string[];
  grading_tests_passed: string[];
  m2_invalid: number | null;
  m2_analyzable: number | null;
  m2_unknown: number | null;
  m2_unknown_ratio: number | null;
  m2_hallucination_rate: number | null;
  // Tiempo/costo del agente + overhead de recuperacion (join con retrieval.jsonl).
  agent_duration_ms: number;
  cost_usd: number | null;
  retrieval_overhead_ms: number;
  end_to_end_ms: number;
  // Esfuerzo del agente (null si el registro no trae telemetria: v3 historicos / no-opencode).
  tokens_total: number | null;
  tool_calls_total: number | null;
  tool_calls_by_tool: Record<string, number> | null;
}

/** Registro de retrieval (subset): timings para el join end-to-end. */
interface RetrievalTimingRecord {
  task_id: string;
  strategy_id: string;
  timings_ms?: { total?: number | null } | null;
}

function readJsonl<T>(path: string): T[] {
  if (!existsSync(path)) {
    throw new Error(`not found: ${path}`);
  }
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as T);
}

function isPass(rec: GenerationRecord): { pass: boolean; reason: string } {
  if (rec.timeout) return { pass: false, reason: "timeout" };
  if (!rec.patch_applied) return { pass: false, reason: "no_patch" };
  if (rec.test_exit_code === null) return { pass: false, reason: "no_tests" };
  if (rec.test_exit_code === 0) return { pass: true, reason: "tests_passed" };
  return { pass: false, reason: `tests_failed_exit_${String(rec.test_exit_code)}` };
}

export function computeRegressionMetrics(rec: GenerationRecord): {
  regressionPass: boolean | null;
  gradingPass: boolean | null;
  targetPass: boolean | null;
  introduced: number;
} {
  const hasRegression = rec.baseline_failing_tests.length > 0
    || rec.post_failing_tests.length > 0
    || rec.grading_tests_passed.length > 0
    || rec.regression_introduced_failures.length > 0;
  if (!hasRegression) {
    return { regressionPass: null, gradingPass: null, targetPass: null, introduced: 0 };
  }
  if (rec.timeout || !rec.patch_applied || rec.test_exit_code === null) {
    return { regressionPass: false, gradingPass: false, targetPass: false, introduced: rec.regression_introduced_failures.length };
  }
  const regressionPass = rec.test_exit_code === 0 && rec.post_failing_tests.length === 0;
  const gradingPass = rec.post_failing_tests.length === 0
    && rec.grading_tests_passed.length > 0;
  const targetPass = rec.test_exit_code === 0;
  return {
    regressionPass,
    gradingPass: gradingPass ? gradingPass : (rec.grading_tests_passed.length > 0 ? false : null),
    targetPass,
    introduced: rec.regression_introduced_failures.length,
  };
}

function buildCellMetricsInternal(
  rec: GenerationRecord,
  hall: HallucinationRecord | undefined,
  retrievalOverheadMs = 0,
): GenerationCellMetrics {
  const pass = isPass(rec);
  const regression = computeRegressionMetrics(rec);
  const total = (hall?.invalid_calls ?? 0) + (hall?.analyzable_calls ?? 0);
  const unknownRatio = hall ? hall.unknown_calls / Math.max(1, hall.invalid_calls + hall.analyzable_calls + hall.unknown_calls) : null;
  const m2 = hall && total > 0 ? hall.invalid_calls / total : null;
  return {
    cell_id: `${rec.task_id}__${rec.strategy_id}__${rec.agent_id}__${rec.model_id}`,
    task_id: rec.task_id,
    repo_id: rec.repo_id,
    strategy_id: rec.strategy_id,
    agent_id: rec.agent_id,
    model_id: rec.model_id,
    m1_pass: pass.pass,
    m1_regression_pass: regression.regressionPass,
    m1_grading_pass: regression.gradingPass,
    m1_target_pass: regression.targetPass,
    m1_regression_introduced: regression.introduced,
    m1_test_exit_code: rec.test_exit_code,
    m1_patch_applied: rec.patch_applied,
    m1_agent_exit_code: rec.agent_exit_code,
    m1_timeout: rec.timeout,
    m1_runner_error: rec.runner_error ?? null,
    baseline_failing_tests: rec.baseline_failing_tests,
    post_failing_tests: rec.post_failing_tests,
    grading_tests_passed: rec.grading_tests_passed,
    m2_invalid: hall?.invalid_calls ?? null,
    m2_analyzable: hall?.analyzable_calls ?? null,
    m2_unknown: hall?.unknown_calls ?? null,
    m2_unknown_ratio: unknownRatio,
    m2_hallucination_rate: m2,
    agent_duration_ms: rec.agent_duration_ms,
    cost_usd: rec.cost_usd,
    retrieval_overhead_ms: retrievalOverheadMs,
    end_to_end_ms: retrievalOverheadMs + rec.agent_duration_ms,
    tokens_total: rec.tokens?.total ?? null,
    tool_calls_total: rec.tool_calls?.total ?? null,
    tool_calls_by_tool: rec.tool_calls?.by_tool ?? null,
  };
}

export function aggregateByStrategy(cells: GenerationCellMetrics[]): Record<string, StrategyAggregate> {
  const byStrategy = new Map<string, GenerationCellMetrics[]>();
  for (const c of cells) {
    const list = byStrategy.get(c.strategy_id) ?? [];
    list.push(c);
    byStrategy.set(c.strategy_id, list);
  }

  const out: Record<string, StrategyAggregate> = {};
  for (const [strategy, list] of byStrategy) {
    const total = list.length;
    const passCount = list.filter((c) => c.m1_pass === true).length;
    const targetPassCount = list.filter((c) => c.m1_target_pass === true).length;
    const regCells = list.filter((c) => c.m1_regression_pass !== null);
    const regPass = regCells.filter((c) => c.m1_regression_pass === true).length;
    const gradingCells = list.filter((c) => c.m1_grading_pass !== null);
    const gradingPass = gradingCells.filter((c) => c.m1_grading_pass === true).length;
    const introducedValues = list.map((c) => c.m1_regression_introduced ?? 0);
    const introducedSum = introducedValues.reduce((s, v) => s + v, 0);
    // Celdas donde el runner de tests no pudo parsear la salida: cuentan como
    // negativos en m1_pass (exit null) y se reportan aparte para que el lector
    // vea cuanto del M1 es ruido de harness vs. fallo real del agente. Usamos
    // el campo explicito `runner_error` para distinguir del caso legitimo en
    // que test_exit_code es null por otras razones (p. ej. tests no corridos).
    const unknownRunnerCount = list.filter((c) => c.m1_runner_error === "unknown_runner").length;

    const m2Cells = list.filter((c) => c.m2_hallucination_rate !== null);
    const m2TotalCalls = m2Cells.reduce((s, c) => s + (c.m2_invalid ?? 0) + (c.m2_analyzable ?? 0), 0);
    const m2InvalidSum = m2Cells.reduce((s, c) => s + (c.m2_invalid ?? 0), 0);
    const m2Rate = m2TotalCalls > 0 ? m2InvalidSum / m2TotalCalls : null;
    const m2UnknownSum = m2Cells.reduce((s, c) => s + (c.m2_unknown ?? 0), 0);
    const m2UnknownDen = m2Cells.reduce((s, c) => s + (c.m2_invalid ?? 0) + (c.m2_analyzable ?? 0) + (c.m2_unknown ?? 0), 0);
    const m2UnknownRatio = m2UnknownDen > 0 ? m2UnknownSum / m2UnknownDen : null;

    const m1PassCi = bootstrapRate(passCount, total);
    const m1RegressionCi = regCells.length > 0 ? bootstrapRate(regPass, regCells.length) : null;
    const m1IntroducedCi = bootstrapMean(introducedValues);
    const m2Ci = m2Rate === null || m2TotalCalls < 2
      ? null
      : bootstrapRate(m2InvalidSum, m2TotalCalls);

    // Panel norte: tiempo/costo. end_to_end incluye el overhead de recuperacion
    // (0 para no_context). Costo solo sobre celdas que lo reportan (opencode).
    const agentDurations = list.map((c) => c.agent_duration_ms);
    const endToEnd = list.map((c) => c.end_to_end_ms);
    const overheadValues = list.map((c) => c.retrieval_overhead_ms);
    const costValues = list.map((c) => c.cost_usd).filter((v): v is number => v !== null);

    // Esfuerzo del agente (tokens/tool-calls): solo celdas con telemetria. by_tool_mean
    // promedia el conteo de cada herramienta sobre esas celdas (ausencia = 0).
    const effortCells = list.filter((c) => c.tool_calls_total !== null || c.tokens_total !== null);
    const tokenValues = list.map((c) => c.tokens_total).filter((v): v is number => v !== null);
    const toolCallValues = list.map((c) => c.tool_calls_total).filter((v): v is number => v !== null);
    const toolNames = new Set<string>();
    for (const c of effortCells) for (const t of Object.keys(c.tool_calls_by_tool ?? {})) toolNames.add(t);
    const byToolMean: Record<string, number> = {};
    if (effortCells.length > 0) {
      for (const name of toolNames) {
        const sum = effortCells.reduce((s, c) => s + (c.tool_calls_by_tool?.[name] ?? 0), 0);
        byToolMean[name] = sum / effortCells.length;
      }
    }

    out[strategy] = {
      m1_pass_rate: total > 0 ? passCount / total : 0,
      m1_pass_rate_ci: m1PassCi,
      m1_regression_pass_rate: regCells.length > 0 ? regPass / regCells.length : null,
      m1_regression_pass_rate_ci: m1RegressionCi,
      m1_grading_pass_rate: gradingCells.length > 0 ? gradingPass / gradingCells.length : null,
      m1_target_pass_rate: total > 0 ? targetPassCount / total : 0,
      m1_regression_introduced_mean: list.length > 0 ? introducedSum / list.length : 0,
      m1_regression_introduced_mean_ci: m1IntroducedCi,
      m1_total: total,
      m1_regression_total: regCells.length,
      m1_unknown_runner_count: unknownRunnerCount,
      m2_hallucination_rate: m2Rate,
      m2_hallucination_rate_ci: m2Ci,
      m2_unknown_ratio: m2UnknownRatio,
      m2_total_calls: m2TotalCalls,
      agent_duration_ms_mean: mean(agentDurations),
      agent_duration_ms_p95: percentile(agentDurations, 95),
      retrieval_overhead_ms_mean: mean(overheadValues) ?? 0,
      end_to_end_ms_mean: mean(endToEnd),
      end_to_end_ms_p95: percentile(endToEnd, 95),
      cost_usd_mean: mean(costValues),
      cost_usd_total: costValues.length > 0 ? costValues.reduce((s, v) => s + v, 0) : null,
      cost_cells: costValues.length,
      tokens_total_mean: mean(tokenValues),
      tokens_total_sum: tokenValues.length > 0 ? tokenValues.reduce((s, v) => s + v, 0) : null,
      tool_calls_mean: mean(toolCallValues),
      by_tool_mean: byToolMean,
      effort_cells: effortCells.length,
    };
  }
  return out;
}

function aggregateByRepoUnknownRatio(cells: GenerationCellMetrics[]): Record<string, { unknown_ratio: number | null; total_calls: number; n_cells: number }> {
  const byRepo = new Map<string, GenerationCellMetrics[]>();
  for (const c of cells) {
    if (c.m2_unknown_ratio === null) continue;
    const list = byRepo.get(c.repo_id) ?? [];
    list.push(c);
    byRepo.set(c.repo_id, list);
  }
  const out: Record<string, { unknown_ratio: number | null; total_calls: number; n_cells: number }> = {};
  for (const [repo, list] of byRepo) {
    const totalCalls = list.reduce((s, c) => s + (c.m2_invalid ?? 0) + (c.m2_analyzable ?? 0) + (c.m2_unknown ?? 0), 0);
    const unknownSum = list.reduce((s, c) => s + (c.m2_unknown ?? 0), 0);
    out[repo] = {
      unknown_ratio: totalCalls > 0 ? unknownSum / totalCalls : null,
      total_calls: totalCalls,
      n_cells: list.length,
    };
  }
  return out;
}

function csvCell(value: string | number | boolean | null): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function renderCsv(byStrategy: Record<string, StrategyAggregate>): string {
  const header = [
    "scope",
    "scope_id",
    "metric_id",
    "value",
    "ci_low",
    "ci_high",
    "ci_iterations",
    "n_cells",
  ];
  const rows: Array<Array<string | number>> = [];
  const pushCi = (scope: string, id: string, metric: string, value: number | null, n: number, ci: { ci_low: number | null; ci_high: number | null; iterations: number } | null) => {
    rows.push([scope, id, metric, value ?? "", ci?.ci_low ?? "", ci?.ci_high ?? "", ci?.iterations ?? "", n]);
  };
  for (const [strategy, agg] of Object.entries(byStrategy)) {
    pushCi("strategy", strategy, "M1", agg.m1_pass_rate, agg.m1_total, agg.m1_pass_rate_ci);
    pushCi("strategy", strategy, "M1_target_pass", agg.m1_target_pass_rate, agg.m1_total, null);
    if (agg.m1_regression_total > 0) {
      pushCi("strategy", strategy, "M1_regression_pass", agg.m1_regression_pass_rate, agg.m1_regression_total, agg.m1_regression_pass_rate_ci);
    }
    if (agg.m1_grading_pass_rate !== null) {
      pushCi("strategy", strategy, "M1_grading_pass", agg.m1_grading_pass_rate, agg.m1_regression_total, null);
    }
    pushCi("strategy", strategy, "M1_regression_introduced_mean", agg.m1_regression_introduced_mean, agg.m1_total, agg.m1_regression_introduced_mean_ci);
    pushCi("strategy", strategy, "M2", agg.m2_hallucination_rate, agg.m2_total_calls, agg.m2_hallucination_rate_ci);
    pushCi("strategy", strategy, "M2_unknown_ratio", agg.m2_unknown_ratio, agg.m2_total_calls, null);
    // Panel norte: tiempo/costo (sin CI).
    pushCi("strategy", strategy, "AgentDurationMs_mean", agg.agent_duration_ms_mean, agg.m1_total, null);
    pushCi("strategy", strategy, "AgentDurationMs_p95", agg.agent_duration_ms_p95, agg.m1_total, null);
    pushCi("strategy", strategy, "RetrievalOverheadMs_mean", agg.retrieval_overhead_ms_mean, agg.m1_total, null);
    pushCi("strategy", strategy, "EndToEndMs_mean", agg.end_to_end_ms_mean, agg.m1_total, null);
    pushCi("strategy", strategy, "EndToEndMs_p95", agg.end_to_end_ms_p95, agg.m1_total, null);
    pushCi("strategy", strategy, "CostUsd_mean", agg.cost_usd_mean, agg.cost_cells, null);
    pushCi("strategy", strategy, "CostUsd_total", agg.cost_usd_total, agg.cost_cells, null);
    // Esfuerzo del agente independiente del costo (tokens/tool-calls) + perfil por herramienta.
    pushCi("strategy", strategy, "TokensTotal_mean", agg.tokens_total_mean, agg.effort_cells, null);
    pushCi("strategy", strategy, "TokensTotal_sum", agg.tokens_total_sum, agg.effort_cells, null);
    pushCi("strategy", strategy, "ToolCalls_mean", agg.tool_calls_mean, agg.effort_cells, null);
    for (const [tool, meanCount] of Object.entries(agg.by_tool_mean)) {
      pushCi("strategy", strategy, `ToolCalls_${tool}_mean`, meanCount, agg.effort_cells, null);
    }
  }
  return `${[header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n")}\n`;
}

function fmtMs(value: number | null): string {
  return value === null ? "N/A" : Math.round(value).toLocaleString("en-US");
}

function fmtUsd(value: number | null): string {
  return value === null ? "N/A" : `$${value.toFixed(6)}`;
}

function renderMarkdown(
  runId: string,
  byStrategy: Record<string, StrategyAggregate>,
  byRepo: Record<string, { unknown_ratio: number | null; total_calls: number; n_cells: number }>,
): string {
  const lines: string[] = [];
  lines.push(`# Generation metrics: ${runId}`);
  lines.push("");
  lines.push("**M1 medible:** `M1_pass_rate` (legacy, `test_exit_code === 0 && patch_applied && !timeout`). Para `M1_regression_pass@1` citable se requiere metadata `regression:` en `tasks.yaml` (no emitido por swe-polybench). `M1_regression_introduced` es diagnostico (cuantos tests nuevos rompio el agente). IC 95% via bootstrap (1000 iter, seed=42).");
  lines.push("");
  lines.push("## M1 y M2 por estrategia");
  lines.push("");
  lines.push("| strategy | n_cells | M1_pass_rate [95% CI] | M1_target_pass | M1_regression_pass [CI] | M1_regression_introduced [CI] | M1_unknown_runner | M2 hallucination_rate [CI] |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|");
  for (const [strategy, agg] of Object.entries(byStrategy)) {
    const regCell = agg.m1_regression_total;
    const reg = regCell > 0 && agg.m1_regression_pass_rate !== null ? agg.m1_regression_pass_rate.toFixed(3) : "N/A";
    const regCi = regCell > 0 && agg.m1_regression_pass_rate_ci !== null
      ? `[${agg.m1_regression_pass_rate_ci.ci_low?.toFixed(3) ?? "?"}, ${agg.m1_regression_pass_rate_ci.ci_high?.toFixed(3) ?? "?"}]`
      : "N/A";
    const ciPass = `[${agg.m1_pass_rate_ci.ci_low?.toFixed(3) ?? "?"}, ${agg.m1_pass_rate_ci.ci_high?.toFixed(3) ?? "?"}]`;
    const ciIntro = `[${agg.m1_regression_introduced_mean_ci.ci_low?.toFixed(2) ?? "?"}, ${agg.m1_regression_introduced_mean_ci.ci_high?.toFixed(2) ?? "?"}]`;
    const m2 = agg.m2_hallucination_rate === null ? "N/A" : agg.m2_hallucination_rate.toFixed(3);
    const m2Ci = agg.m2_hallucination_rate_ci
      ? `[${agg.m2_hallucination_rate_ci.ci_low?.toFixed(3) ?? "?"}, ${agg.m2_hallucination_rate_ci.ci_high?.toFixed(3) ?? "?"}]`
      : "N/A";
    lines.push(
      `| ${strategy} | ${agg.m1_total} | ${agg.m1_pass_rate.toFixed(3)} ${ciPass} | ${agg.m1_target_pass_rate.toFixed(3)} | ${reg} ${regCi} | ${agg.m1_regression_introduced_mean.toFixed(2)} ${ciIntro} | ${agg.m1_unknown_runner_count} | ${m2} ${m2Ci} |`,
    );
  }
  lines.push("");
  lines.push("Notas:");
  lines.push("- `M1_pass_rate` es la unica variante de M1 medible cuando el manifest no incluye `regression:` (caso swe-polybench). Mide `test_exit_code === 0 && patch_applied && !timeout`.");
  lines.push("- `M1_target_pass` mide solo `test_exit_code === 0` sobre el comando `target_tests` completo; puede ser > `M1_pass_rate` cuando exit=0 pero hay otros criterios en juego.");
  lines.push("- `M1_regression_pass` se computa solo en celdas con `baseline_failing_tests`; en otras queda N/A.");
  lines.push("- `M1_regression_introduced` cuenta tests que fallan al final pero NO estaban en baseline_failing — son regresiones introducidas por el agente.");
  lines.push("- `M1_unknown_runner` cuenta celdas con `test_exit_code === null && patch_applied && !timeout`: tests no parseables (timeout, formato no soportado). Inflar este contador es se\~nal de que el harness perdio tests, no de fallo del agente.");
  lines.push("");
  lines.push("## Tiempo y costo por estrategia (panel norte)");
  lines.push("");
  lines.push("El agente recibe el contexto YA inyectado (sin hook vivo): `agent` excluye la recuperacion. `overhead` = `retrieval.jsonl` timings_ms.total (sanitizer+retrieval; 0 para `no_context`). `end-to-end` = overhead + agente = costo real del flujo asistido.");
  lines.push("");
  lines.push("| strategy | n_cells | overhead ms (mean) | agent ms (mean / p95) | end-to-end ms (mean / p95) | cost usd (mean / total) | cost cells |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const [strategy, agg] of Object.entries(byStrategy)) {
    lines.push(
      `| ${strategy} | ${agg.m1_total} | ${fmtMs(agg.retrieval_overhead_ms_mean)} | ` +
        `${fmtMs(agg.agent_duration_ms_mean)} / ${fmtMs(agg.agent_duration_ms_p95)} | ` +
        `${fmtMs(agg.end_to_end_ms_mean)} / ${fmtMs(agg.end_to_end_ms_p95)} | ` +
        `${fmtUsd(agg.cost_usd_mean)} / ${fmtUsd(agg.cost_usd_total)} | ${agg.cost_cells} |`,
    );
  }
  lines.push("");
  lines.push("## Esfuerzo del agente por estrategia (tokens y tool-calls)");
  lines.push("");
  lines.push("Ejes de esfuerzo INDEPENDIENTES del costo (parseados del stream `--format json` de opencode), útiles cuando el proveedor no reporta `cost`. `by_tool` promedia el conteo de cada herramienta sobre las celdas con telemetría (p.ej. `grep`, `bash`, `read`).");
  lines.push("");
  // Union de herramientas presentes en cualquier estrategia, orden estable.
  const allTools = [...new Set(Object.values(byStrategy).flatMap((a) => Object.keys(a.by_tool_mean)))].sort();
  const toolHeader = allTools.map((t) => `${t} (mean)`).join(" | ");
  lines.push(`| strategy | effort cells | tokens (mean / sum) | tool-calls (mean)${allTools.length > 0 ? ` | ${toolHeader}` : ""} |`);
  lines.push(`|---|---:|---:|---:|${allTools.map(() => "---:|").join("")}`);
  const fmtNum = (v: number | null): string => (v === null ? "N/A" : Math.round(v).toLocaleString("en-US"));
  const fmtMean = (v: number): string => v.toFixed(1);
  for (const [strategy, agg] of Object.entries(byStrategy)) {
    const toolCols = allTools.map((t) => fmtMean(agg.by_tool_mean[t] ?? 0)).join(" | ");
    lines.push(
      `| ${strategy} | ${agg.effort_cells} | ${fmtNum(agg.tokens_total_mean)} / ${fmtNum(agg.tokens_total_sum)} | ` +
        `${agg.tool_calls_mean === null ? "N/A" : fmtMean(agg.tool_calls_mean)}${allTools.length > 0 ? ` | ${toolCols}` : ""} |`,
    );
  }
  lines.push("");
  lines.push("## M2 unknown_ratio by repo (diagnostic)");
  lines.push("");
  lines.push("| repo | n_cells | unknown ratio | total calls | flag |");
  lines.push("|---|---:|---:|---:|---|");
  for (const [repo, agg] of Object.entries(byRepo)) {
    const flag = agg.unknown_ratio !== null && agg.unknown_ratio > 0.3 ? "**WARN (noisy)**" : "ok";
    lines.push(`| ${repo} | ${agg.n_cells} | ${agg.unknown_ratio === null ? "N/A" : agg.unknown_ratio.toFixed(3)} | ${agg.total_calls} | ${flag} |`);
  }
  lines.push("");
  return lines.join("\n");
}

export function buildCellMetrics(
  rec: GenerationRecord,
  hall: HallucinationRecord | undefined,
  retrievalOverheadMs = 0,
): GenerationCellMetrics {
  return buildCellMetricsInternal(rec, hall, retrievalOverheadMs);
}

export function computeGenerationMetrics(argv = process.argv.slice(2)): void {
  const options = parseEvalCliOptions(argv, ["--run-id", "--manifests-dir", "--agent-id", "--strategy-id"]);
  const manifests = loadManifests(resolveManifestsDir(options.manifestsDir));
  const layout = resolveEvalLayout(manifests.run, options.runId);
  mkdirSync(layout.runDirectory, { recursive: true });

  const generationPath = join(layout.runDirectory, "generation.jsonl");
  const hallucinationPath = join(layout.runDirectory, "hallucinations.jsonl");

  const retrievalPath = join(layout.runDirectory, "retrieval.jsonl");

  // --agent-id / --strategy-id filtran generation.jsonl a un brazo antes de agregar,
  // porque aggregateByStrategy agrupa solo por strategy_id (mezclaría plain-vs-mcp y
  // los 2 modelos). El strategy_id del record puede llevar sufijo de variante
  // (`connector@baseline`) → match tolerante. Las salidas se sufijan para no pisarse.
  const matchesFilter = (g: GenerationRecord): boolean =>
    (options.agentId === undefined || g.agent_id === options.agentId) &&
    (options.strategyId === undefined ||
      g.strategy_id === options.strategyId ||
      g.strategy_id.startsWith(`${options.strategyId}@`));
  const genRecords = (existsSync(generationPath)
    ? readJsonl<GenerationRecord>(generationPath)
    : []
  ).filter(matchesFilter);
  if ((options.agentId !== undefined || options.strategyId !== undefined) && genRecords.length === 0) {
    throw new Error(
      `no generation records match agent=${options.agentId ?? "*"} strategy=${options.strategyId ?? "*"} in ${generationPath}`,
    );
  }
  const hallRecords = existsSync(hallucinationPath)
    ? readJsonl<HallucinationRecord>(hallucinationPath)
    : [];

  // Build a lookup by (task, strategy, agent)
  const hallLookup = new Map<string, HallucinationRecord>();
  for (const h of hallRecords) {
    hallLookup.set(`${h.task_id}__${h.strategy_id}__${h.agent_id}`, h);
  }

  // Overhead de recuperacion por (task, strategy) desde retrieval.jsonl (timings_ms.total).
  // El strategy_id une directo (incluye la variante, p. ej. `hybrid@grounded`).
  // `no_context` no tiene registro → overhead 0. Se registra cuantas celdas
  // (no-no_context) quedaron sin match para no ocultar overhead ausente.
  const retrievalOverhead = new Map<string, number>();
  if (existsSync(retrievalPath)) {
    for (const r of readJsonl<RetrievalTimingRecord>(retrievalPath)) {
      const totalMs = r.timings_ms?.total;
      if (typeof totalMs === "number") {
        retrievalOverhead.set(`${r.task_id}__${r.strategy_id}`, totalMs);
      }
    }
  }
  let missingOverhead = 0;
  const cells = genRecords.map((g) => {
    const overhead = g.strategy_id === "no_context"
      ? 0
      : retrievalOverhead.get(`${g.task_id}__${g.strategy_id}`);
    if (overhead === undefined && g.strategy_id !== "no_context") missingOverhead += 1;
    return buildCellMetricsInternal(
      g,
      hallLookup.get(`${g.task_id}__${g.strategy_id}__${g.agent_id}`),
      overhead ?? 0,
    );
  });
  if (missingOverhead > 0) {
    console.warn(
      `⚠ ${missingOverhead} celda(s) de generación sin registro de retrieval para el overhead ` +
        `(end-to-end usa overhead=0 en esas). ¿Corriste eval:retrieval de la variante antes de generar?`,
    );
  }
  const byStrategy = aggregateByStrategy(cells);
  const byRepo = aggregateByRepoUnknownRatio(cells);

  const output = {
    schema_version: 2,
    run_id: layout.runId,
    generated_at: new Date().toISOString(),
    bootstrap: {
      iterations: 1000,
      alpha: 0.05,
      seed: 42,
      notes: "IC bootstrap (1000 iter, seed=42, alpha=0.05). m1_pass_rate y m1_regression_pass usan bootstrapRate (binomial); m1_regression_introduced_mean usa bootstrapMean. m2_hallucination_rate usa bootstrapRate sobre (invalid_calls, total_calls).",
    },
    counts: {
      generation_records: genRecords.length,
      hallucination_records: hallRecords.length,
    },
    by_strategy: byStrategy,
    unknown_ratio_by_repo: byRepo,
    cells,
  };

  const filterSuffix = [options.agentId, options.strategyId]
    .filter((value): value is string => value !== undefined)
    .map((value) => `.${value}`)
    .join("");
  const metricsPath = join(layout.runDirectory, `generation-metrics${filterSuffix}.json`);
  const csvPath = join(layout.runDirectory, `generation-summary${filterSuffix}.csv`);
  const mdPath = join(layout.runDirectory, `generation-summary${filterSuffix}.md`);
  writeFileSync(metricsPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  writeFileSync(csvPath, renderCsv(byStrategy), "utf8");
  writeFileSync(mdPath, renderMarkdown(layout.runId, byStrategy, byRepo), "utf8");
  console.log(`Generation metrics: ${metricsPath}`);
  console.log(`Summary CSV: ${csvPath}`);
  console.log(`Summary MD: ${mdPath}`);
}

if (isEntrypoint(import.meta.url)) {
  try {
    computeGenerationMetrics();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
