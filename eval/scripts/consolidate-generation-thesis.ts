/**
 * consolidate-generation-thesis.ts
 *
 * Consolida los resultados de GENERACIÓN en tablas listas para pegar en el
 * capítulo de Resultados (formato tesis: decimal-coma, 4 decimales, IC 95 %
 * bootstrap como Mínimo/Máximo). Salidas en el directorio del run:
 *   - generation-thesis.md   (tablas ordenadas para Resultados)
 *   - generation-thesis.csv  (CSV ancho con TODO, precisión completa)
 *
 * Panel de métricas (acordado): M6 Pasa (Pass@1 justo, graded), Coste, Tiempo,
 * ToolCalls, N_Read y Adopción MCP. Tokens (M7) se excluye por no ser comparable
 * cross-model (Sonnet usa prompt-caching; DeepSeek no).
 *
 * JUSTICIA DE MEDICIÓN:
 *  - Pass@1 = pass / celdas gradadas (excluye inválidas de harness y sin-entrega
 *    del agente; ver compute-generation-metrics.classifyMeasurement).
 *  - La telemetría de Sonnet (coste/tool-calls) NO está en generation.jsonl sino
 *    en el stdout stream-json de cada celda → se parsea aquí en vuelo (read-only,
 *    sin mutar el jsonl). DeepSeek (opencode) ya trae los campos en el jsonl.
 *  - Modelos: claude-code* se filtra a sonnet (descarta haiku n≈3); opencode* a
 *    deepseek. El strategy_id se normaliza a su base (sin sufijo `@variante`).
 *
 * Uso: tsx eval/scripts/consolidate-generation-thesis.ts \
 *        --run-id 2026-07-11-bench10-mh --manifests-dir eval/manifests/swe-polybench-10repos
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvalCliOptions, isEntrypoint } from "./lib/cli.js";
import { loadManifests } from "./lib/load-manifests.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { resolveManifestsDir } from "./lib/paths.js";
import type { GenerationRecord } from "./lib/generation-record.js";
import { aggregateByStrategy, buildCellMetrics } from "./compute-generation-metrics.js";
import { bootstrapMean, bootstrapRate } from "./lib/metrics.js";

/**
 * Escenarios (modelo × modo). El eje de comparación de las tablas es la
 * ESTRATEGIA (la herramienta: sin-contexto vs connector vs consensus). El modelo
 * NO es un eje de comparación: cada escenario es un banco de prueba independiente
 * (replicación), y se presenta en su propia tabla para no inducir comparación
 * cruzada entre modelos.
 */
const ARMS: Array<{ agent: string; modelMatch: (m: string) => boolean; model: string; mode: string; label: string; mcp: boolean }> = [
  { agent: "claude-code", modelMatch: (m) => m === "sonnet", model: "Sonnet", mode: "directo", label: "Sonnet · directo", mcp: false },
  { agent: "claude-code", modelMatch: (m) => m === "haiku", model: "Haiku", mode: "directo", label: "Haiku · directo", mcp: false },
  { agent: "claude-code-mcp", modelMatch: (m) => m === "sonnet", model: "Sonnet", mode: "MCP", label: "Sonnet · MCP", mcp: true },
  { agent: "opencode", modelMatch: (m) => m.includes("deepseek"), model: "DeepSeek", mode: "directo", label: "DeepSeek · directo", mcp: false },
  { agent: "opencode_mcp", modelMatch: (m) => m.includes("deepseek"), model: "DeepSeek", mode: "MCP", label: "DeepSeek · MCP", mcp: true },
];

const STRATEGIES = ["no_context", "connector", "consensus"] as const;
const STRATEGY_LABEL: Record<string, string> = {
  no_context: "Sin contexto",
  connector: "Connector",
  consensus: "Consensus",
};

const baseStrategy = (s: string): string => s.split("@")[0]!;
/** Decimal-coma, N decimales (formato tesis). */
const dc = (v: number | null, d = 4): string => (v === null || Number.isNaN(v) ? "N/A" : v.toFixed(d).replace(".", ","));
/** Entero con separador de miles estilo tesis (2.454). */
const di = (v: number | null): string => (v === null ? "N/A" : Math.round(v).toLocaleString("de-DE"));

/** Telemetría normalizada de una celda (vocabulario común cross-model). */
interface CellTelemetry {
  cost: number | null;
  durationS: number;
  toolTotal: number | null;
  read: number | null;
  grep: number | null;
  edit: number | null;
  retrieve: number | null;
}

/** Parsea el stdout stream-json de una celda Claude Code → telemetría normalizada. */
function parseClaudeStdout(path: string): Omit<CellTelemetry, "durationS"> {
  const out = { cost: null as number | null, toolTotal: 0, read: 0, grep: 0, edit: 0, retrieve: 0 };
  if (!existsSync(path)) return { ...out, toolTotal: null, read: null, grep: null, edit: null, retrieve: null };
  let sawResult = false;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let ev: unknown;
    try { ev = JSON.parse(line); } catch { continue; }
    const e = ev as { type?: string; message?: { content?: Array<{ type?: string; name?: string }> }; total_cost_usd?: number };
    if (e.type === "assistant" && e.message?.content) {
      for (const c of e.message.content) {
        if (c.type !== "tool_use") continue;
        const name = c.name ?? "?";
        out.toolTotal += 1;
        if (name.includes("lacoco") || name.includes("retrieve")) out.retrieve += 1;
        else if (name === "Read") out.read += 1;
        else if (name === "Grep" || name === "Glob") out.grep += 1;
        else if (name === "Edit" || name === "Write") out.edit += 1;
      }
    } else if (e.type === "result") {
      sawResult = true;
      out.cost = e.total_cost_usd ?? null;
    }
  }
  // Sin evento result → la celda no terminó limpia; telemetría de tools no fiable.
  if (!sawResult) return { cost: null, toolTotal: null, read: null, grep: null, edit: null, retrieve: null };
  return out;
}

/** Telemetría normalizada desde el registro opencode (campos ya en el jsonl). */
function opencodeTelemetry(r: GenerationRecord): Omit<CellTelemetry, "durationS"> {
  const bt = r.tool_calls?.by_tool ?? null;
  if (!r.tool_calls || !bt) {
    return { cost: r.cost_usd ?? null, toolTotal: null, read: null, grep: null, edit: null, retrieve: null };
  }
  return {
    cost: r.cost_usd ?? null,
    toolTotal: r.tool_calls.total,
    read: bt.read ?? 0,
    grep: (bt.grep ?? 0) + (bt.glob ?? 0),
    edit: (bt.edit ?? 0) + (bt.write ?? 0),
    retrieve: bt.lacoco_lacoco_retrieve ?? 0,
  };
}

function cellTelemetry(runDir: string, r: GenerationRecord): CellTelemetry {
  const durationS = r.agent_duration_ms / 1000;
  const base = r.agent_id.startsWith("claude-code")
    ? parseClaudeStdout(join(runDir, "generation-artifacts", r.task_id, r.strategy_id, r.agent_id, "agent.stdout.log"))
    : opencodeTelemetry(r);
  return { ...base, durationS };
}

interface Row {
  arm: string;
  model: string;
  mode: string;
  mcp: boolean;
  strategy: string;
  n_total: number;
  graded: number;
  harness_invalid: number;
  agent_fault: number;
  pass_graded: number | null;
  pass_graded_lo: number | null;
  pass_graded_hi: number | null;
  pass_attributable: number | null;
  m1_legacy: number;
  // Eficiencia (media [IC]); n_tel = celdas con telemetría fiable.
  n_tel: number;
  cost: number | null; cost_lo: number | null; cost_hi: number | null;
  duration: number | null; duration_lo: number | null; duration_hi: number | null;
  tools: number | null; tools_lo: number | null; tools_hi: number | null;
  read: number | null; read_lo: number | null; read_hi: number | null;
  adoption: number | null; adoption_lo: number | null; adoption_hi: number | null; // solo MCP
}

function collectRows(all: GenerationRecord[], runDir: string): Row[] {
  const rows: Row[] = [];
  for (const arm of ARMS) {
    const armRecs = all.filter((r) => r.agent_id === arm.agent && arm.modelMatch(r.model_id));
    const cells = armRecs.map((r) => {
      const cell = buildCellMetrics(r, undefined);
      cell.strategy_id = baseStrategy(r.strategy_id);
      return cell;
    });
    const agg = aggregateByStrategy(cells);
    for (const strat of STRATEGIES) {
      const a = agg[strat];
      if (!a) continue;
      const stratRecs = armRecs.filter((r) => baseStrategy(r.strategy_id) === strat);
      const tel = stratRecs.map((r) => cellTelemetry(runDir, r));
      const withTel = tel.filter((t) => t.toolTotal !== null);
      const costs = tel.map((t) => t.cost).filter((v): v is number => v !== null);
      const durs = tel.map((t) => t.durationS);
      const toolsV = withTel.map((t) => t.toolTotal as number);
      const readsV = withTel.map((t) => t.read as number);
      const meanCi = (vals: number[]): [number | null, number | null, number | null] => {
        if (vals.length === 0) return [null, null, null];
        const m = vals.reduce((s, v) => s + v, 0) / vals.length;
        const ci = bootstrapMean(vals);
        return [m, ci.ci_low, ci.ci_high];
      };
      const [cost, costLo, costHi] = meanCi(costs);
      const [dur, durLo, durHi] = meanCi(durs);
      const [tools, toolsLo, toolsHi] = meanCi(toolsV);
      const [read, readLo, readHi] = meanCi(readsV);
      // Adopción: fracción de celdas (con telemetría) que llamó al MCP ≥1 vez.
      let adoption: number | null = null, adoptionLo: number | null = null, adoptionHi: number | null = null;
      if (arm.mcp && withTel.length > 0) {
        const used = withTel.filter((t) => (t.retrieve ?? 0) > 0).length;
        adoption = used / withTel.length;
        const ci = bootstrapRate(used, withTel.length);
        adoptionLo = ci.ci_low; adoptionHi = ci.ci_high;
      }
      rows.push({
        arm: arm.label, model: arm.model, mode: arm.mode, mcp: arm.mcp, strategy: strat,
        n_total: a.m1_total, graded: a.graded_count,
        harness_invalid: a.harness_invalid_count, agent_fault: a.agent_fault_count,
        pass_graded: a.pass_at_1_graded,
        pass_graded_lo: a.pass_at_1_graded_ci?.ci_low ?? null,
        pass_graded_hi: a.pass_at_1_graded_ci?.ci_high ?? null,
        pass_attributable: a.pass_at_1_attributable,
        m1_legacy: a.m1_pass_rate,
        n_tel: withTel.length,
        cost, cost_lo: costLo, cost_hi: costHi,
        duration: dur, duration_lo: durLo, duration_hi: durHi,
        tools, tools_lo: toolsLo, tools_hi: toolsHi,
        read, read_lo: readLo, read_hi: readHi,
        adoption, adoption_lo: adoptionLo, adoption_hi: adoptionHi,
      });
    }
  }
  return rows;
}

/** Una fila de métrica (Métrica | Valor | Mínimo | Máximo) para el formato Tabla-7. */
interface MetricRow { name: string; value: string; lo: string; hi: string }

/** Métricas por estrategia de un escenario, en orden de presentación. */
function metricRows(r: Row): MetricRow[] {
  const m: MetricRow[] = [
    { name: "Pass@1", value: dc(r.pass_graded), lo: dc(r.pass_graded_lo), hi: dc(r.pass_graded_hi) },
    { name: "Coste (USD)", value: dc(r.cost, 3), lo: dc(r.cost_lo, 3), hi: dc(r.cost_hi, 3) },
    { name: "Tiempo (s)", value: di(r.duration), lo: di(r.duration_lo), hi: di(r.duration_hi) },
    { name: "ToolCalls", value: dc(r.tools, 1), lo: dc(r.tools_lo, 1), hi: dc(r.tools_hi, 1) },
    { name: "N_Read", value: dc(r.read, 1), lo: dc(r.read_lo, 1), hi: dc(r.read_hi, 1) },
  ];
  if (r.mcp) m.push({ name: "Adopción MCP", value: dc(r.adoption), lo: dc(r.adoption_lo), hi: dc(r.adoption_hi) });
  return m;
}

/** Tabla de un escenario en formato Tabla-7: Variante=estrategia, filas de métrica. */
function renderScenarioTable(rows: Row[], armLabel: string, tableNo: number): string[] {
  const L: string[] = [];
  const scen = rows.filter((r) => r.arm === armLabel).sort((a, b) => STRATEGIES.indexOf(a.strategy as typeof STRATEGIES[number]) - STRATEGIES.indexOf(b.strategy as typeof STRATEGIES[number]));
  if (scen.length === 0) return L;
  const nRange = `n gradadas = ${scen.map((r) => r.graded).join("/")} (sin-contexto/connector/consensus)`;
  L.push(`**Tabla ${tableNo}**`);
  L.push("");
  L.push(`*Resultados de generación — escenario ${armLabel}. Comparación por estrategia de recuperación (la herramienta). Pass@1 sobre celdas gradadas; ${nRange}. Coste en USD list-price por tarea; N_Read = lecturas de archivo. Mínimo/Máximo = IC 95 % bootstrap (1000 iteraciones, semilla 42).*`);
  L.push("");
  L.push("| **Variante** | **Métrica** | **Valor** | **Mínimo** | **Máximo** |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const r of scen) {
    const mr = metricRows(r);
    mr.forEach((row, i) => {
      const variante = i === 0 ? STRATEGY_LABEL[r.strategy] : "";
      L.push(`| ${variante} | ${row.name} | ${row.value} | ${row.lo} | ${row.hi} |`);
    });
  }
  L.push("");
  return L;
}

function renderMarkdown(rows: Row[]): string {
  const L: string[] = [];
  L.push("# Resultados de generación (comparación de la herramienta)");
  L.push("");
  L.push("> Eje de comparación = **la estrategia de recuperación** (Sin contexto = línea base sin la herramienta; Connector y Consensus = estrategias de LaCoCo). El modelo NO se compara entre sí: cada escenario (modelo × modo) es una réplica independiente en su propia tabla. Orden sugerido en Resultados: primero recuperación (Tablas 7–12, ya en el documento), luego estas tablas de generación.");
  L.push("");
  // Una tabla por escenario (modelo × modo), en el orden de ARMS.
  let tableNo = 13;
  for (const arm of ARMS) {
    for (const line of renderScenarioTable(rows, arm.label, tableNo)) L.push(line);
    tableNo += 1;
  }
  // Tabla de cobertura (denominador transparente) para las 4 escenas juntas.
  L.push(`**Tabla ${tableNo}**`);
  L.push("");
  L.push("*Cobertura de medición (denominador del Pass@1). `Gradadas` entran al Pass@1; `Harness inv.` = rotura del benchmark igual para todo agente (excluida); `Fallo agente` = el agente no entregó solución medible (excluida del titular). Pass@1 atribuible = pass / (gradadas + fallo agente).*");
  L.push("");
  L.push("| **Escenario** | **Estrategia** | **n total** | **Gradadas** | **Harness inv.** | **Fallo agente** | **Pass@1 atrib.** |");
  L.push("| --- | --- | --- | --- | --- | --- | --- |");
  let prev = "";
  for (const r of rows) {
    const cell = r.arm === prev ? "" : r.arm; prev = r.arm;
    L.push(`| ${cell} | ${STRATEGY_LABEL[r.strategy]} | ${r.n_total} | ${r.graded} | ${r.harness_invalid} | ${r.agent_fault} | ${dc(r.pass_attributable)} |`);
  }
  L.push("");
  return L.join("\n");
}

function renderCsv(rows: Row[]): string {
  const header = [
    "arm", "strategy", "n_total", "graded", "harness_invalid", "agent_fault",
    "pass_at_1_graded", "pass_graded_ci_low", "pass_graded_ci_high", "pass_at_1_attributable", "m1_pass_rate_legacy",
    "n_tel", "cost_usd_mean", "cost_ci_low", "cost_ci_high",
    "duration_s_mean", "duration_ci_low", "duration_ci_high",
    "tool_calls_mean", "tool_calls_ci_low", "tool_calls_ci_high",
    "n_read_mean", "n_read_ci_low", "n_read_ci_high",
    "mcp_adoption", "adoption_ci_low", "adoption_ci_high",
  ];
  const f = (v: number | null): string => (v === null ? "" : String(v));
  const esc = (c: string | number): string => (/[",\r\n]/u.test(String(c)) ? `"${String(c).replaceAll('"', '""')}"` : String(c));
  const body = rows.map((r) => [
    r.arm, r.strategy, r.n_total, r.graded, r.harness_invalid, r.agent_fault,
    f(r.pass_graded), f(r.pass_graded_lo), f(r.pass_graded_hi), f(r.pass_attributable), f(r.m1_legacy),
    r.n_tel, f(r.cost), f(r.cost_lo), f(r.cost_hi),
    f(r.duration), f(r.duration_lo), f(r.duration_hi),
    f(r.tools), f(r.tools_lo), f(r.tools_hi),
    f(r.read), f(r.read_lo), f(r.read_hi),
    f(r.adoption), f(r.adoption_lo), f(r.adoption_hi),
  ].map(esc).join(","));
  return `${[header.join(","), ...body].join("\n")}\n`;
}

export function consolidateGenerationThesis(argv = process.argv.slice(2)): void {
  const options = parseEvalCliOptions(argv, ["--run-id", "--manifests-dir"]);
  const manifests = loadManifests(resolveManifestsDir(options.manifestsDir));
  const layout = resolveEvalLayout(manifests.run, options.runId);
  const generationPath = join(layout.runDirectory, "generation.jsonl");
  if (!existsSync(generationPath)) throw new Error(`not found: ${generationPath}`);
  const all = readFileSync(generationPath, "utf8")
    .split("\n").filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as GenerationRecord);

  const rows = collectRows(all, layout.runDirectory);
  const mdPath = join(layout.runDirectory, "generation-thesis.md");
  const csvPath = join(layout.runDirectory, "generation-thesis.csv");
  writeFileSync(mdPath, renderMarkdown(rows), "utf8");
  writeFileSync(csvPath, renderCsv(rows), "utf8");
  console.log(`Tesis MD:  ${mdPath}`);
  console.log(`Tesis CSV: ${csvPath}`);
}

if (isEntrypoint(import.meta.url)) {
  try {
    consolidateGenerationThesis();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
