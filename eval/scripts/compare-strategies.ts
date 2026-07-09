/**
 * compare-strategies.ts  (Fase 3)
 *
 * Construye la tabla comparativa de M1 (Pass@1) y M2 (Hallucination Rate) de cada
 * estrategia de retrieval CONTRA el baseline `no_context`, a partir del artefacto
 * ya calculado por `compute-generation-metrics.ts`:
 *
 *     eval/runs/<run-id>/generation-metrics.json
 *
 * NO recalcula M1/M2 ni redefine sus convenciones: consume `by_strategy` y `cells`
 * de ese JSON y solo deriva los deltas y la vista pareada por tarea. Así, si cambia
 * la definición de una métrica, cambia en un único sitio (compute-generation-metrics).
 *
 * Salida (aditiva, no pisa nada de compute-generation-metrics):
 *   - phase3-comparison.md   tabla legible por estrategia + vista pareada por tarea
 *   - phase3-comparison.csv  formato largo para hojas de cálculo
 *
 * Uso (ejecutar SOLO cuando el piloto haya terminado y exista generation-metrics.json):
 *   npm run eval:metrics:generation -- --run-id <run-id>     # produce generation-metrics.json
 *   node --import tsx eval/scripts/compare-strategies.ts --run-id <run-id>
 *
 * Convención de lectura de deltas:
 *   ΔM1 > 0  → la estrategia resuelve más tareas que no_context (mejor).
 *   ΔM2 < 0  → la estrategia alucina menos que no_context (mejor).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvalCliOptions, isEntrypoint } from "./lib/cli.js";
import { loadManifests } from "./lib/load-manifests.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { resolveManifestsDir } from "./lib/paths.js";

/** Estrategia base contra la que se comparan las demás. */
const BASELINE = "no_context";

/** Orden preferido de columnas/filas; estrategias no listadas van al final, ordenadas. */
const STRATEGY_ORDER = ["no_context", "hybrid", "ictd", "clcr", "rpr", "agentic"];

interface StrategyAgg {
  m1_pass_rate: number;
  m1_total: number;
  m2_hallucination_rate: number | null;
  m2_unknown_ratio: number | null;
  m2_total_calls: number;
  // Panel norte de tiempo/costo (compute-generation-metrics.ts). Opcionales para
  // leer generation-metrics.json históricos (schema previo sin estos campos).
  agent_duration_ms_mean?: number | null;
  retrieval_overhead_ms_mean?: number;
  end_to_end_ms_mean?: number | null;
  end_to_end_ms_p95?: number | null;
  cost_usd_mean?: number | null;
  cost_usd_total?: number | null;
  cost_cells?: number;
}

interface CellMetrics {
  cell_id: string;
  task_id: string;
  repo_id: string;
  strategy_id: string;
  agent_id: string;
  m1_pass: boolean | null;
  m2_invalid: number | null;
  m2_analyzable: number | null;
  m2_unknown: number | null;
  m2_unknown_ratio: number | null;
  m2_hallucination_rate: number | null;
}

interface GenerationMetrics {
  schema_version: number;
  run_id: string;
  generated_at: string;
  by_strategy: Record<string, StrategyAgg>;
  cells: CellMetrics[];
}

function readJson<T>(path: string): T {
  if (!existsSync(path)) {
    throw new Error(
      `not found: ${path}\n` +
        `Ejecuta primero: npm run eval:metrics:generation -- --run-id <run-id>`,
    );
  }
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

/** Ordena las estrategias por STRATEGY_ORDER; el resto alfabético al final. */
function orderStrategies(ids: string[]): string[] {
  return [...ids].sort((a, b) => {
    const ia = STRATEGY_ORDER.indexOf(a);
    const ib = STRATEGY_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

function fmtRate(value: number | null): string {
  return value === null ? "N/A" : value.toFixed(3);
}

function fmtMs(value: number | null | undefined): string {
  return value === null || value === undefined ? "N/A" : Math.round(value).toLocaleString("en-US");
}

function fmtUsd(value: number | null | undefined): string {
  return value === null || value === undefined ? "N/A" : `$${value.toFixed(6)}`;
}

function fmtDeltaMs(value: number | null | undefined, base: number | null | undefined): string {
  if (value === null || value === undefined || base === null || base === undefined) return "N/A";
  const d = value - base;
  return `${d > 0 ? "+" : ""}${Math.round(d).toLocaleString("en-US")}`;
}

function fmtDeltaUsd(value: number | null | undefined, base: number | null | undefined): string {
  if (value === null || value === undefined || base === null || base === undefined) return "N/A";
  const d = value - base;
  return `${d > 0 ? "+" : ""}${d.toFixed(6)}`;
}

/** Delta con signo explícito; null si alguno de los operandos falta. */
function fmtDelta(value: number | null, base: number | null): string {
  if (value === null || base === null) return "N/A";
  const delta = value - base;
  const sign = delta > 0 ? "+" : "";
  return `${sign}${delta.toFixed(3)}`;
}

function delta(value: number | null, base: number | null): number | null {
  return value === null || base === null ? null : value - base;
}

/** Anota si el delta es mejor (▲), peor (▼) o igual (=) según la dirección deseada. */
function trend(d: number | null, betterWhenPositive: boolean): string {
  if (d === null) return "";
  if (Math.abs(d) < 1e-9) return "=";
  const good = betterWhenPositive ? d > 0 : d < 0;
  return good ? "▲" : "▼";
}

interface PairedFlip {
  strategy: string;
  fail_to_pass: number; // baseline falla, estrategia pasa (ganancia)
  pass_to_fail: number; // baseline pasa, estrategia falla (regresión)
  unchanged: number;
  paired_tasks: number; // tareas con celda en baseline Y en la estrategia
}

/** Cuenta transiciones de M1 por tarea respecto del baseline. */
function computeFlips(
  cells: CellMetrics[],
  strategies: string[],
): PairedFlip[] {
  const byTaskStrategy = new Map<string, boolean | null>();
  for (const c of cells) {
    byTaskStrategy.set(`${c.task_id}__${c.strategy_id}`, c.m1_pass);
  }
  const tasks = [...new Set(cells.map((c) => c.task_id))];

  const flips: PairedFlip[] = [];
  for (const strategy of strategies) {
    if (strategy === BASELINE) continue;
    let failToPass = 0;
    let passToFail = 0;
    let unchanged = 0;
    let paired = 0;
    for (const task of tasks) {
      const base = byTaskStrategy.get(`${task}__${BASELINE}`);
      const strat = byTaskStrategy.get(`${task}__${strategy}`);
      if (base === undefined || strat === undefined) continue;
      paired += 1;
      if (base === false && strat === true) failToPass += 1;
      else if (base === true && strat === false) passToFail += 1;
      else unchanged += 1;
    }
    flips.push({
      strategy,
      fail_to_pass: failToPass,
      pass_to_fail: passToFail,
      unchanged,
      paired_tasks: paired,
    });
  }
  return flips;
}

function cellPassSymbol(pass: boolean | null | undefined): string {
  if (pass === undefined) return "·"; // no hubo celda
  if (pass === null) return "—"; // celda sin veredicto M1
  return pass ? "✅" : "❌";
}

function renderMarkdown(metrics: GenerationMetrics): string {
  const strategies = orderStrategies(Object.keys(metrics.by_strategy));
  const base = metrics.by_strategy[BASELINE];
  const lines: string[] = [];

  lines.push(`# Fase 3 — comparación de estrategias vs \`${BASELINE}\`: ${metrics.run_id}`);
  lines.push("");
  lines.push(`Fuente: \`generation-metrics.json\` (generado ${metrics.generated_at}).`);
  lines.push("");

  if (base === undefined) {
    lines.push(
      `> ⚠️ No hay celdas para el baseline \`${BASELINE}\` en este run. ` +
        `Se muestran valores absolutos sin deltas.`,
    );
    lines.push("");
  }

  // --- Tabla agregada por estrategia ---
  lines.push("## M1 / M2 por estrategia (con delta vs baseline)");
  lines.push("");
  lines.push(
    "| estrategia | n | M1 pass | ΔM1 | | M2 halluc | ΔM2 | | M2 calls |",
  );
  lines.push("|---|---:|---:|---:|:-:|---:|---:|:-:|---:|");
  for (const s of strategies) {
    const agg = metrics.by_strategy[s];
    if (agg === undefined) continue;
    const isBase = s === BASELINE;
    const dM1 = base ? delta(agg.m1_pass_rate, base.m1_pass_rate) : null;
    const dM2 = base ? delta(agg.m2_hallucination_rate, base.m2_hallucination_rate) : null;
    const label = isBase ? `\`${s}\` (base)` : `\`${s}\``;
    const dM1Cell = isBase ? "—" : fmtDelta(agg.m1_pass_rate, base?.m1_pass_rate ?? null);
    const dM2Cell = isBase ? "—" : fmtDelta(agg.m2_hallucination_rate, base?.m2_hallucination_rate ?? null);
    lines.push(
      `| ${label} | ${agg.m1_total} | ${fmtRate(agg.m1_pass_rate)} | ${dM1Cell} | ` +
        `${isBase ? "" : trend(dM1, true)} | ${fmtRate(agg.m2_hallucination_rate)} | ` +
        `${dM2Cell} | ${isBase ? "" : trend(dM2, false)} | ${agg.m2_total_calls} |`,
    );
  }
  lines.push("");
  lines.push("_ΔM1 > 0 = más tareas resueltas (mejor). ΔM2 < 0 = menos alucinación (mejor)._");
  lines.push("");

  // --- Panel norte: tiempo y costo end-to-end vs baseline ---
  lines.push("## Tiempo y costo vs baseline (end-to-end)");
  lines.push("");
  lines.push(
    "El agente recibe el contexto YA inyectado, así que `agent` excluye la recuperación. " +
      "`end-to-end` = overhead de recuperación (0 para `no_context`) + agente = costo real del flujo asistido. " +
      "ΔE2E vs `no_context`: **< 0 = el contexto se paga solo** (el flujo asistido es más rápido en total).",
  );
  lines.push("");
  lines.push(
    "| estrategia | n | overhead ms | agent ms | end-to-end ms | ΔE2E | | cost usd | ΔCost | |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|:-:|---:|---:|:-:|");
  for (const s of strategies) {
    const agg = metrics.by_strategy[s];
    if (agg === undefined) continue;
    const isBase = s === BASELINE;
    const label = isBase ? `\`${s}\` (base)` : `\`${s}\``;
    const dE2E = base ? delta(agg.end_to_end_ms_mean ?? null, base.end_to_end_ms_mean ?? null) : null;
    const dCost = base ? delta(agg.cost_usd_mean ?? null, base.cost_usd_mean ?? null) : null;
    lines.push(
      `| ${label} | ${agg.m1_total} | ${fmtMs(agg.retrieval_overhead_ms_mean)} | ` +
        `${fmtMs(agg.agent_duration_ms_mean)} | ${fmtMs(agg.end_to_end_ms_mean)} | ` +
        `${isBase ? "—" : fmtDeltaMs(agg.end_to_end_ms_mean, base?.end_to_end_ms_mean)} | ` +
        `${isBase ? "" : trend(dE2E, false)} | ${fmtUsd(agg.cost_usd_mean)} | ` +
        `${isBase ? "—" : fmtDeltaUsd(agg.cost_usd_mean, base?.cost_usd_mean)} | ` +
        `${isBase ? "" : trend(dCost, false)} |`,
    );
  }
  lines.push("");
  lines.push("_ΔE2E < 0 y ΔCost < 0 = mejor (menos tiempo/costo total que `no_context`)._");
  lines.push("");

  // --- Vista pareada por tarea: M1 ---
  const tasks = [...new Map(metrics.cells.map((c) => [c.task_id, c.repo_id]))].sort(
    (a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]),
  );
  const passByCell = new Map<string, boolean | null>();
  const m2ByCell = new Map<string, number | null>();
  for (const c of metrics.cells) {
    passByCell.set(`${c.task_id}__${c.strategy_id}`, c.m1_pass);
    m2ByCell.set(`${c.task_id}__${c.strategy_id}`, c.m2_hallucination_rate);
  }

  lines.push("## M1 pareado por tarea");
  lines.push("");
  lines.push(`| tarea | repo | ${strategies.map((s) => `\`${s}\``).join(" | ")} |`);
  lines.push(`|---|---|${strategies.map(() => ":-:").join("|")}|`);
  for (const [taskId, repoId] of tasks) {
    const cellsRow = strategies.map((s) => cellPassSymbol(passByCell.get(`${taskId}__${s}`)));
    lines.push(`| ${taskId} | ${repoId} | ${cellsRow.join(" | ")} |`);
  }
  lines.push("");
  lines.push("_✅ pasa · ❌ falla · — sin veredicto · · celda ausente._");
  lines.push("");

  // --- Vista pareada por tarea: M2 ---
  lines.push("## M2 (hallucination rate) por tarea");
  lines.push("");
  lines.push(`| tarea | repo | ${strategies.map((s) => `\`${s}\``).join(" | ")} |`);
  lines.push(`|---|---|${strategies.map(() => "---:").join("|")}|`);
  for (const [taskId, repoId] of tasks) {
    const cellsRow = strategies.map((s) => fmtRate(m2ByCell.get(`${taskId}__${s}`) ?? null));
    lines.push(`| ${taskId} | ${repoId} | ${cellsRow.join(" | ")} |`);
  }
  lines.push("");

  // --- Resumen de transiciones (paired flips) ---
  const flips = computeFlips(metrics.cells, strategies);
  lines.push("## Transiciones de M1 vs baseline (por tarea pareada)");
  lines.push("");
  lines.push("| estrategia | tareas pareadas | fail→pass (ganancia) | pass→fail (regresión) | sin cambio | ganancia neta |");
  lines.push("|---|---:|---:|---:|---:|---:|");
  for (const f of flips) {
    const net = f.fail_to_pass - f.pass_to_fail;
    const netSign = net > 0 ? "+" : "";
    lines.push(
      `| \`${f.strategy}\` | ${f.paired_tasks} | ${f.fail_to_pass} | ${f.pass_to_fail} | ` +
        `${f.unchanged} | ${netSign}${net} |`,
    );
  }
  lines.push("");
  lines.push(
    `> Nota: con ${tasks.length} tareas en el piloto, las tasas agregadas son gruesas; ` +
      `la vista pareada y la ganancia neta son la señal más fiable para decidir si ampliar a 5 estrategias.`,
  );
  lines.push("");

  return lines.join("\n");
}

function csvCell(value: string | number | null): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function renderCsv(metrics: GenerationMetrics): string {
  const strategies = orderStrategies(Object.keys(metrics.by_strategy));
  const base = metrics.by_strategy[BASELINE];
  const header = ["scope", "strategy", "metric", "value", "baseline_value", "delta", "n"];
  const rows: Array<Array<string | number | null>> = [];
  for (const s of strategies) {
    const agg = metrics.by_strategy[s];
    if (agg === undefined) continue;
    const isBase = s === BASELINE;
    rows.push([
      "strategy",
      s,
      "M1",
      agg.m1_pass_rate,
      base?.m1_pass_rate ?? null,
      isBase ? null : delta(agg.m1_pass_rate, base?.m1_pass_rate ?? null),
      agg.m1_total,
    ]);
    rows.push([
      "strategy",
      s,
      "M2",
      agg.m2_hallucination_rate,
      base?.m2_hallucination_rate ?? null,
      isBase ? null : delta(agg.m2_hallucination_rate, base?.m2_hallucination_rate ?? null),
      agg.m2_total_calls,
    ]);
    rows.push([
      "strategy",
      s,
      "EndToEndMs",
      agg.end_to_end_ms_mean ?? null,
      base?.end_to_end_ms_mean ?? null,
      isBase ? null : delta(agg.end_to_end_ms_mean ?? null, base?.end_to_end_ms_mean ?? null),
      agg.m1_total,
    ]);
    rows.push([
      "strategy",
      s,
      "CostUsd",
      agg.cost_usd_mean ?? null,
      base?.cost_usd_mean ?? null,
      isBase ? null : delta(agg.cost_usd_mean ?? null, base?.cost_usd_mean ?? null),
      agg.cost_cells ?? 0,
    ]);
  }
  return `${[header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n")}\n`;
}

export function compareStrategies(argv = process.argv.slice(2)): void {
  const options = parseEvalCliOptions(argv, ["--run-id", "--manifests-dir"]);
  const manifests = loadManifests(resolveManifestsDir(options.manifestsDir));
  const layout = resolveEvalLayout(manifests.run, options.runId);

  const metricsPath = join(layout.runDirectory, "generation-metrics.json");
  const metrics = readJson<GenerationMetrics>(metricsPath);

  const mdPath = join(layout.runDirectory, "phase3-comparison.md");
  const csvPath = join(layout.runDirectory, "phase3-comparison.csv");
  writeFileSync(mdPath, renderMarkdown(metrics), "utf8");
  writeFileSync(csvPath, renderCsv(metrics), "utf8");
  console.log(`Phase 3 comparison MD:  ${mdPath}`);
  console.log(`Phase 3 comparison CSV: ${csvPath}`);
}

if (isEntrypoint(import.meta.url)) {
  try {
    compareStrategies();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
