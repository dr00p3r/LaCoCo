/**
 * consolidate-retrieval-thesis.ts
 *
 * Formatea las métricas de RECUPERACIÓN de un run al formato del capítulo de
 * Resultados de la tesis (calca la Tabla 7: Variante=estrategia, filas de
 * métrica, decimal-coma, IC 95 % como Mínimo/Máximo). Lee el JSON ya computado
 * por compute-retrieval-metrics (`retrieval-metrics[.<variant>].json`) → no
 * recomputa nada, solo reformatea.
 *
 * Métricas mostradas (mismas 5 de la Tabla 7):
 *   EditSiteHit → Acierto de Sitio de Edición
 *   MRR → Rango Recíproco Medio
 *   UsefulContextCoverage → Cobertura de Contexto Útil
 *   ExternalNoiseRate → Tasa de Ruido Externo
 *   Latency → Latencia (ms)
 *
 * Uso: tsx eval/scripts/consolidate-retrieval-thesis.ts \
 *        --run-id 2026-07-11-bench10-mh --manifests-dir eval/manifests/swe-polybench-10repos [--variant baseline]
 * (--variant por defecto `baseline`, que es la que consumió la generación.)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvalCliOptions, isEntrypoint } from "./lib/cli.js";
import { loadManifests } from "./lib/load-manifests.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { resolveManifestsDir } from "./lib/paths.js";

/** Orden y etiqueta de estrategias como en la Tabla 7 (baselines primero, RPR al final). */
const STRATEGY_ORDER: Array<{ id: string; label: string }> = [
  { id: "hybrid", label: "HYBRID" },
  { id: "ictd", label: "ICTD" },
  { id: "clcr", label: "CLCR" },
  { id: "connector", label: "CONNECTOR" },
  { id: "consensus", label: "CONSENSUS" },
  { id: "repograph", label: "REPOGRAPH" },
  { id: "ppr", label: "PPR" },
  { id: "rpr", label: "RPR" },
];

/** Métricas mostradas (id interno → etiqueta tesis, ¿es latencia entera?). */
const METRICS: Array<{ id: string; label: string; latency?: boolean }> = [
  { id: "EditSiteHit", label: "Acierto de Sitio de Edición" },
  { id: "MRR", label: "Rango Recíproco Medio" },
  { id: "UsefulContextCoverage", label: "Cobertura de Contexto Útil" },
  { id: "ExternalNoiseRate", label: "Tasa de Ruido Externo" },
  { id: "Latency", label: "Latencia (ms)", latency: true },
];

const dc = (v: number | null, d = 4): string => (v === null || Number.isNaN(v) ? "N/A" : v.toFixed(d).replace(".", ","));
const di = (v: number | null): string => (v === null ? "N/A" : Math.round(v).toLocaleString("de-DE"));

interface MetricCell { value: number; ci_low: number | null; ci_high: number | null; included_task_values?: number; excluded_task_values?: number }
interface StrategySummary { scope_id: string; metrics: Record<string, MetricCell> }

const baseId = (scopeId: string): string => scopeId.split("@")[0]!;

function renderMarkdown(runId: string, variant: string, byStrategy: StrategySummary[], validity: { valid?: number; invalid_anchor?: number; invalid_index?: number } | undefined): string {
  const byId = new Map<string, StrategySummary>();
  for (const s of byStrategy) byId.set(baseId(s.scope_id), s);

  const L: string[] = [];
  L.push(`# Recuperación — ${runId} (variante ${variant})`);
  L.push("");
  const nNote = validity
    ? `Muestra válida: ${validity.valid ?? "?"} instancias (excluidas por anclaje gold-fuera-del-grafo: ${validity.invalid_anchor ?? 0}; índice no disponible: ${validity.invalid_index ?? 0}).`
    : "";
  L.push("**Tabla**");
  L.push("");
  L.push(`*Resultados de recuperación del benchmark multi-salto de 10 repositorios. Comparación por estrategia. ${nNote} El Acierto de Sitio de Edición, el Rango Recíproco Medio y la Cobertura se agregan sobre las instancias con gold alcanzable en el grafo; la Latencia y la Tasa de Ruido, sobre todas las válidas. Mínimo/Máximo = IC 95 % bootstrap (1000 iteraciones, semilla 42).*`);
  L.push("");
  L.push("| **Variante** | **Métrica** | **Valor** | **Mínimo** | **Máximo** |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const strat of STRATEGY_ORDER) {
    const s = byId.get(strat.id);
    if (!s) continue;
    METRICS.forEach((m, i) => {
      const cell = s.metrics[m.id];
      const variante = i === 0 ? strat.label : "";
      if (!cell) {
        L.push(`| ${variante} | ${m.label} | N/A | N/A | N/A |`);
        return;
      }
      const fmt = m.latency ? di : (v: number | null) => dc(v, 4);
      L.push(`| ${variante} | ${m.label} | ${fmt(cell.value)} | ${fmt(cell.ci_low)} | ${fmt(cell.ci_high)} |`);
    });
  }
  L.push("");
  return L.join("\n");
}

function renderCsv(byStrategy: StrategySummary[]): string {
  const header = ["strategy", "metric", "value", "ci_low", "ci_high", "included_tasks", "excluded_tasks"];
  const esc = (c: string | number): string => (/[",\r\n]/u.test(String(c)) ? `"${String(c).replaceAll('"', '""')}"` : String(c));
  const byId = new Map<string, StrategySummary>();
  for (const s of byStrategy) byId.set(baseId(s.scope_id), s);
  const rows: Array<Array<string | number>> = [];
  for (const strat of STRATEGY_ORDER) {
    const s = byId.get(strat.id);
    if (!s) continue;
    for (const m of METRICS) {
      const c = s.metrics[m.id];
      if (!c) continue;
      rows.push([strat.label, m.id, c.value, c.ci_low ?? "", c.ci_high ?? "", c.included_task_values ?? "", c.excluded_task_values ?? ""]);
    }
  }
  return `${[header.join(","), ...rows.map((r) => r.map(esc).join(","))].join("\n")}\n`;
}

export function consolidateRetrievalThesis(argv = process.argv.slice(2)): void {
  // --variant no es un flag estándar del parser eval → se lee y se retira de argv
  // antes de delegar (parseEvalCliOptions lanza ante argumentos desconocidos).
  const variantIdx = argv.indexOf("--variant");
  const variant = variantIdx >= 0 && argv[variantIdx + 1] ? argv[variantIdx + 1]! : "baseline";
  const cleanArgv = variantIdx >= 0 ? argv.filter((_, i) => i !== variantIdx && i !== variantIdx + 1) : argv;
  const options = parseEvalCliOptions(cleanArgv, ["--run-id", "--manifests-dir"]);
  const manifests = loadManifests(resolveManifestsDir(options.manifestsDir));
  const layout = resolveEvalLayout(manifests.run, options.runId);
  const candidates = [
    join(layout.runDirectory, `retrieval-metrics.${variant}.json`),
    join(layout.runDirectory, "retrieval-metrics.json"),
  ];
  const metricsPath = candidates.find((p) => existsSync(p));
  if (!metricsPath) throw new Error(`no encontré retrieval-metrics para variante '${variant}' en ${layout.runDirectory}`);
  const j = JSON.parse(readFileSync(metricsPath, "utf8")) as {
    summary?: { by_strategy?: StrategySummary[] };
    validity?: { valid?: number; invalid_anchor?: number; invalid_index?: number };
  };
  const byStrategy = j.summary?.by_strategy ?? [];
  if (byStrategy.length === 0) throw new Error(`retrieval-metrics sin summary.by_strategy: ${metricsPath}`);

  const mdPath = join(layout.runDirectory, `retrieval-thesis.${variant}.md`);
  const csvPath = join(layout.runDirectory, `retrieval-thesis.${variant}.csv`);
  writeFileSync(mdPath, renderMarkdown(layout.runId, variant, byStrategy, j.validity), "utf8");
  writeFileSync(csvPath, renderCsv(byStrategy), "utf8");
  console.log(`Fuente:    ${metricsPath}`);
  console.log(`Tesis MD:  ${mdPath}`);
  console.log(`Tesis CSV: ${csvPath}`);
}

if (isEntrypoint(import.meta.url)) {
  try {
    consolidateRetrievalThesis();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
