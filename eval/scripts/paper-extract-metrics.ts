/**
 * Extractor de la matriz del documento: 5 variantes x estrategias x 5 metricas.
 * Lee los retrieval-metrics<variant>.json de los dos run-dirs (jina/minilm) y
 * arma una tabla maestra con las 5 metricas pedidas (EditSiteHit, MRR,
 * UsefulContextCoverage, ExternalNoiseRate, Latency-P95) por (variante, estrategia).
 *
 *   npx tsx eval/scripts/paper-extract-metrics.ts
 *
 * Emite Markdown a stdout y escribe eval/runs/_paper_logs/matriz.md y matriz.csv.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const METRICS = ["EditSiteHit", "MRR", "UsefulContextCoverage", "ExternalNoiseRate", "Latency"] as const;
const ES_LABEL: Record<string, string> = {
  EditSiteHit: "Acierto de Sitio de Edicion",
  MRR: "Rango Reciproco Medio",
  UsefulContextCoverage: "Cobertura de Contexto Util",
  ExternalNoiseRate: "Tasa de Ruido Externo",
  Latency: "Latencia (P95, ms)",
};

// (numero de variante, etiqueta, run-dir, sufijo de sanitizer variant en el filename)
const ARMS: Array<{ n: number; label: string; dir: string; variant: string }> = [
  { n: 1, label: "MiniLM · Determinista", dir: "eval/runs/paper-minilm-det", variant: "deterministic" },
  { n: 2, label: "MiniLM · SLM Intermediario", dir: "eval/runs/paper-minilm-base", variant: "baseline" },
  { n: 3, label: "Jina · Determinista", dir: "eval/runs/paper-jina-det", variant: "deterministic" },
  { n: 4, label: "Jina · SLM Intermediario", dir: "eval/runs/paper-jina-base", variant: "baseline" },
  { n: 5, label: "Jina · SLM + Perfil Semantico", dir: "eval/runs/paper-jina-grnd", variant: "grounded" },
];

function fmt(v: unknown, isLatency: boolean): string {
  if (typeof v !== "number" || Number.isNaN(v)) return "—";
  return isLatency ? Math.round(v).toString() : v.toFixed(3);
}

function loadArm(dir: string, variant: string): any | null {
  // compute-retrieval-metrics escribe retrieval-metrics.<variant>.json (sufijo = ".<sanitizer variant>")
  for (const name of [`retrieval-metrics.${variant}.json`, `retrieval-metrics${variant}.json`]) {
    const p = `${dir}/${name}`;
    if (existsSync(p)) return { path: p, data: JSON.parse(readFileSync(p, "utf8")) };
  }
  return null;
}

const mdLines: string[] = ["# Matriz de recuperacion — documento (multi-hop, 3 repos x 5 casos = 15)", ""];
const csvRows: string[] = ["variante_n,variante,estrategia,EditSiteHit,MRR,UsefulContextCoverage,ExternalNoiseRate,Latency_p95_ms,n_valid,n_excluded"];

for (const arm of ARMS) {
  const loaded = loadArm(arm.dir, arm.variant);
  mdLines.push(`## Variante ${arm.n} — ${arm.label}`);
  if (!loaded) {
    mdLines.push(`_pendiente: no existe retrieval-metrics para ${arm.dir} / ${arm.variant}_`, "");
    continue;
  }
  const m = loaded.data;
  const v = m.validity ?? {};
  mdLines.push(
    `_fuente: ${loaded.path} · validez: valid=${v.valid ?? "?"} invalid_anchor=${v.invalid_anchor ?? "?"} invalid_index=${v.invalid_index ?? "?"}_`,
    "",
    "| Estrategia | " + METRICS.map((k) => ES_LABEL[k]).join(" | ") + " | n |",
    "|" + "---|".repeat(METRICS.length + 2),
  );
  const rows: any[] = m.summary?.by_strategy ?? [];
  rows.sort((a, b) => String(a.scope_id).localeCompare(String(b.scope_id)));
  for (const r of rows) {
    const strat = String(r.scope_id ?? "?").split("@")[0]; // quita sufijo @variante
    const cells = METRICS.map((k) => fmt(r.metrics?.[k]?.value, k === "Latency"));
    const nVal = r.metrics?.EditSiteHit?.included_task_values ?? "?";
    const nExc = r.metrics?.EditSiteHit?.excluded_task_values ?? 0;
    mdLines.push(`| ${strat} | ${cells.join(" | ")} | ${nVal} |`);
    csvRows.push(
      [arm.n, `"${arm.label}"`, strat, ...METRICS.map((k) => {
        const val = r.metrics?.[k]?.value;
        return typeof val === "number" ? (k === "Latency" ? Math.round(val) : val.toFixed(4)) : "";
      }), nVal, nExc].join(","),
    );
  }
  mdLines.push("");
}

const out = mdLines.join("\n");
writeFileSync("eval/runs/_paper_logs/matriz.md", out + "\n", "utf8");
writeFileSync("eval/runs/_paper_logs/matriz.csv", csvRows.join("\n") + "\n", "utf8");
console.log(out);
console.log("\n-> eval/runs/_paper_logs/matriz.md  +  matriz.csv");
