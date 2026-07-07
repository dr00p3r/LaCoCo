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
  baseline_failing_tests: string[];
  post_failing_tests: string[];
  grading_tests_passed: string[];
  m2_invalid: number | null;
  m2_analyzable: number | null;
  m2_unknown: number | null;
  m2_unknown_ratio: number | null;
  m2_hallucination_rate: number | null;
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

function buildCellMetrics(
  rec: GenerationRecord,
  hall: HallucinationRecord | undefined,
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
    baseline_failing_tests: rec.baseline_failing_tests,
    post_failing_tests: rec.post_failing_tests,
    grading_tests_passed: rec.grading_tests_passed,
    m2_invalid: hall?.invalid_calls ?? null,
    m2_analyzable: hall?.analyzable_calls ?? null,
    m2_unknown: hall?.unknown_calls ?? null,
    m2_unknown_ratio: unknownRatio,
    m2_hallucination_rate: m2,
  };
}

function aggregateByStrategy(cells: GenerationCellMetrics[]): Record<string, {
  m1_pass_rate: number;
  m1_regression_pass_rate: number | null;
  m1_grading_pass_rate: number | null;
  m1_target_pass_rate: number;
  m1_regression_introduced_mean: number;
  m1_total: number;
  m1_regression_total: number;
  m2_hallucination_rate: number | null;
  m2_unknown_ratio: number | null;
  m2_total_calls: number;
}> {
  const byStrategy = new Map<string, GenerationCellMetrics[]>();
  for (const c of cells) {
    const list = byStrategy.get(c.strategy_id) ?? [];
    list.push(c);
    byStrategy.set(c.strategy_id, list);
  }

  const out: Record<string, {
    m1_pass_rate: number;
    m1_regression_pass_rate: number | null;
    m1_grading_pass_rate: number | null;
    m1_target_pass_rate: number;
    m1_regression_introduced_mean: number;
    m1_total: number;
    m1_regression_total: number;
    m2_hallucination_rate: number | null;
    m2_unknown_ratio: number | null;
    m2_total_calls: number;
  }> = {};
  for (const [strategy, list] of byStrategy) {
    const total = list.length;
    const passCount = list.filter((c) => c.m1_pass === true).length;
    const targetPassCount = list.filter((c) => c.m1_target_pass === true).length;
    const regCells = list.filter((c) => c.m1_regression_pass !== null);
    const regPass = regCells.filter((c) => c.m1_regression_pass === true).length;
    const gradingCells = list.filter((c) => c.m1_grading_pass !== null);
    const gradingPass = gradingCells.filter((c) => c.m1_grading_pass === true).length;
    const introducedSum = list.reduce((s, c) => s + (c.m1_regression_introduced ?? 0), 0);

    const m2Cells = list.filter((c) => c.m2_hallucination_rate !== null);
    const m2TotalCalls = m2Cells.reduce((s, c) => s + (c.m2_invalid ?? 0) + (c.m2_analyzable ?? 0), 0);
    const m2InvalidSum = m2Cells.reduce((s, c) => s + (c.m2_invalid ?? 0), 0);
    const m2Rate = m2TotalCalls > 0 ? m2InvalidSum / m2TotalCalls : null;
    const m2UnknownSum = m2Cells.reduce((s, c) => s + (c.m2_unknown ?? 0), 0);
    const m2UnknownDen = m2Cells.reduce((s, c) => s + (c.m2_invalid ?? 0) + (c.m2_analyzable ?? 0) + (c.m2_unknown ?? 0), 0);
    const m2UnknownRatio = m2UnknownDen > 0 ? m2UnknownSum / m2UnknownDen : null;

    out[strategy] = {
      m1_pass_rate: total > 0 ? passCount / total : 0,
      m1_regression_pass_rate: regCells.length > 0 ? regPass / regCells.length : null,
      m1_grading_pass_rate: gradingCells.length > 0 ? gradingPass / gradingCells.length : null,
      m1_target_pass_rate: total > 0 ? targetPassCount / total : 0,
      m1_regression_introduced_mean: list.length > 0 ? introducedSum / list.length : 0,
      m1_total: total,
      m1_regression_total: regCells.length,
      m2_hallucination_rate: m2Rate,
      m2_unknown_ratio: m2UnknownRatio,
      m2_total_calls: m2TotalCalls,
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

function renderCsv(byStrategy: Record<string, {
  m1_pass_rate: number;
  m1_regression_pass_rate: number | null;
  m1_grading_pass_rate: number | null;
  m1_target_pass_rate: number;
  m1_regression_introduced_mean: number;
  m1_total: number;
  m1_regression_total: number;
  m2_hallucination_rate: number | null;
  m2_unknown_ratio: number | null;
  m2_total_calls: number;
}>): string {
  const header = ["scope", "scope_id", "metric_id", "value", "n_cells"];
  const rows: Array<Array<string | number>> = [];
  for (const [strategy, agg] of Object.entries(byStrategy)) {
    rows.push(["strategy", strategy, "M1", agg.m1_pass_rate, agg.m1_total]);
    rows.push(["strategy", strategy, "M1_target_pass", agg.m1_target_pass_rate, agg.m1_total]);
    if (agg.m1_regression_total > 0) {
      rows.push(["strategy", strategy, "M1_regression_pass", agg.m1_regression_pass_rate ?? "", agg.m1_regression_total]);
    }
    if (agg.m1_grading_pass_rate !== null) {
      rows.push(["strategy", strategy, "M1_grading_pass", agg.m1_grading_pass_rate, agg.m1_regression_total]);
    }
    rows.push(["strategy", strategy, "M1_regression_introduced_mean", agg.m1_regression_introduced_mean, agg.m1_total]);
    rows.push(["strategy", strategy, "M2", agg.m2_hallucination_rate ?? "", agg.m2_total_calls]);
    rows.push(["strategy", strategy, "M2_unknown_ratio", agg.m2_unknown_ratio ?? "", agg.m2_total_calls]);
  }
  return `${[header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n")}\n`;
}

function renderMarkdown(
  runId: string,
  byStrategy: Record<string, {
    m1_pass_rate: number;
    m1_regression_pass_rate: number | null;
    m1_grading_pass_rate: number | null;
    m1_target_pass_rate: number;
    m1_regression_introduced_mean: number;
    m1_total: number;
    m1_regression_total: number;
    m2_hallucination_rate: number | null;
    m2_unknown_ratio: number | null;
    m2_total_calls: number;
  }>,
  byRepo: Record<string, { unknown_ratio: number | null; total_calls: number; n_cells: number }>,
): string {
  const lines: string[] = [];
  lines.push(`# Generation metrics: ${runId}`);
  lines.push("");
  lines.push("**M1 citable del piloto:** `M1_regression_pass@1` (por estrategia). Las filas 2 y 3 son desglose. `M1_regression_introduced` es diagnostico (cuantos tests nuevos rompio el agente).");
  lines.push("");
  lines.push("## M1 (regresion) y M2 por estrategia");
  lines.push("");
  lines.push("| strategy | n_cells | M1_regression_pass (citable) | M1_target_pass | M1_grading_pass | M1_regression_introduced (mean) | M2 hallucination rate |");
  lines.push("|---|---:|---:|---:|---:|---:|---:|");
  for (const [strategy, agg] of Object.entries(byStrategy)) {
    const regCell = agg.m1_regression_total;
    const reg = regCell > 0 && agg.m1_regression_pass_rate !== null ? agg.m1_regression_pass_rate.toFixed(3) : "N/A";
    const grading = agg.m1_grading_pass_rate !== null ? agg.m1_grading_pass_rate.toFixed(3) : "N/A";
    lines.push(
      `| ${strategy} | ${agg.m1_total} | ${reg} | ${agg.m1_target_pass_rate.toFixed(3)} | ${grading} | ${agg.m1_regression_introduced_mean.toFixed(2)} | ${agg.m2_hallucination_rate === null ? "N/A" : agg.m2_hallucination_rate.toFixed(3)} |`,
    );
  }
  lines.push("");
  lines.push("Notas:");
  lines.push("- `M1_regression_pass` requiere `test_exit_code === 0` y `post_failing_tests` vacio (los tests que fallaban en baseline ahora pasan y el agente no rompio otros).");
  lines.push("- `M1_target_pass` mide solo `test_exit_code === 0` sobre el comando `target_tests` completo; puede ser > `M1_regression_pass` si el comando tiene tests ajenos al bug que el agente arreglo.");
  lines.push("- `M1_grading_pass` se computa solo en celdas con `grading_tests` enumerados en `tasks.yaml`; en otras queda N/A.");
  lines.push("- `M1_regression_introduced` cuenta tests que fallan al final pero NO estaban en baseline_failing — son regresiones introducidas por el agente.");
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

export function computeGenerationMetrics(argv = process.argv.slice(2)): void {
  const options = parseEvalCliOptions(argv, ["--run-id"]);
  const manifests = loadManifests();
  const layout = resolveEvalLayout(manifests.run, options.runId);
  mkdirSync(layout.runDirectory, { recursive: true });

  const generationPath = join(layout.runDirectory, "generation.jsonl");
  const hallucinationPath = join(layout.runDirectory, "hallucinations.jsonl");

  const genRecords = existsSync(generationPath)
    ? readJsonl<GenerationRecord>(generationPath)
    : [];
  const hallRecords = existsSync(hallucinationPath)
    ? readJsonl<HallucinationRecord>(hallucinationPath)
    : [];

  // Build a lookup by (task, strategy, agent)
  const hallLookup = new Map<string, HallucinationRecord>();
  for (const h of hallRecords) {
    hallLookup.set(`${h.task_id}__${h.strategy_id}__${h.agent_id}`, h);
  }

  const cells = genRecords.map((g) => buildCellMetrics(g, hallLookup.get(`${g.task_id}__${g.strategy_id}__${g.agent_id}`)));
  const byStrategy = aggregateByStrategy(cells);
  const byRepo = aggregateByRepoUnknownRatio(cells);

  const output = {
    schema_version: 1,
    run_id: layout.runId,
    generated_at: new Date().toISOString(),
    counts: {
      generation_records: genRecords.length,
      hallucination_records: hallRecords.length,
    },
    by_strategy: byStrategy,
    unknown_ratio_by_repo: byRepo,
    cells,
  };

  const metricsPath = join(layout.runDirectory, "generation-metrics.json");
  const csvPath = join(layout.runDirectory, "generation-summary.csv");
  const mdPath = join(layout.runDirectory, "generation-summary.md");
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
