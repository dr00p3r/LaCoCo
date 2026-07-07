import { basename, isAbsolute, join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { asNumber, asRecord, asString } from "./lib/config.js";
import { isEntrypoint } from "./lib/cli.js";
import { readJsonl } from "./lib/jsonl.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { loadManifests } from "./lib/load-manifests.js";
import { PROJECT_ROOT } from "./lib/paths.js";
import { computeSemanticProfileMetrics, type SemanticProfileMetricSet } from "./lib/semantic-profile-metrics.js";

interface Options { runId?: string; runDir?: string; }

export function computeSemanticMetrics(argv = process.argv.slice(2)): void {
  const options = parseOptions(argv);
  const manifests = loadManifests();
  const runDirectory = options.runId
    ? resolveEvalLayout(manifests.run, options.runId).runDirectory
    : isAbsolute(options.runDir!) ? resolve(options.runDir!) : resolve(PROJECT_ROOT, options.runDir!);
  const runId = options.runId ?? basename(runDirectory);
  const taskById = new Map(manifests.tasks.tasks.map((task) => [task.id, task]));
  const inputPath = join(runDirectory, "retrieval.jsonl");
  const executions = readJsonl(inputPath).map(({ line, value }) => {
    const root = asRecord(value, `${inputPath}:${line}`);
    const taskId = asString(root.task_id, `${inputPath}:${line}.task_id`);
    const task = taskById.get(taskId);
    if (!task) throw new Error(`${inputPath}:${line}: unknown task ${taskId}`);
    const classification = root.classification === null ? null : asRecord(root.classification, `${inputPath}:${line}.classification`);
    const grounding = root.grounding === null ? null : asRecord(root.grounding, `${inputPath}:${line}.grounding`);
    const groundingEnabled = grounding?.enabled === true;
    const candidateTerms = grounding?.candidateTerms;
    const unsupported = grounding?.initialUnsupportedClauses;
    if (candidateTerms !== undefined && !Array.isArray(candidateTerms)) throw new Error("grounding.candidateTerms must be an array");
    if (unsupported !== undefined && !Array.isArray(unsupported)) throw new Error("grounding.initialUnsupportedClauses must be an array");
    const metrics = computeSemanticProfileMetrics({
      exitCode: root.exit_code === null ? null : asNumber(root.exit_code, `${inputPath}:${line}.exit_code`),
      cleanQuery: classification === null ? null : asString(classification.cleanQuery, `${inputPath}:${line}.classification.cleanQuery`),
      candidateTerms: groundingEnabled
        ? (candidateTerms ?? []).map((entry, index) => asString(entry, `candidateTerms[${index}]`))
        : [],
      unsupportedClauses: groundingEnabled
        ? (unsupported ?? []).map((entry, index) => asString(entry, `unsupported[${index}]`))
        : [],
      repairCount: groundingEnabled ? asNumber(grounding!.repairCount, "grounding.repairCount") : null,
      groundingDurationMs: !groundingEnabled || grounding?.durationMs === null
        ? null
        : asNumber(grounding!.durationMs, "grounding.durationMs"),
    }, {
      status: task.translation_gold.status,
      relevantTerms: task.translation_gold.relevant_terms,
    });
    return {
      task_id: taskId,
      repo_id: asString(root.repo_id, `${inputPath}:${line}.repo_id`),
      strategy_id: asString(root.strategy_id, `${inputPath}:${line}.strategy_id`),
      sanitizer_variant: asString(root.sanitizer_variant, `${inputPath}:${line}.sanitizer_variant`),
      metrics,
    };
  });
  const summary = summarize(executions);
  const output = { schema_version: 1, run_id: runId, generated_at: new Date().toISOString(), executions, summary };
  writeFileSync(join(runDirectory, "semantic-profile-metrics.json"), `${JSON.stringify(output, null, 2)}\n`);
  writeFileSync(join(runDirectory, "semantic-profile-summary.csv"), renderCsv(summary));
  writeFileSync(join(runDirectory, "semantic-profile-summary.md"), renderMarkdown(runId, summary));
  console.log(`Computed semantic profile metrics for ${executions.length} executions.`);
}

function summarize(executions: Array<{
  sanitizer_variant: string;
  repo_id: string;
  task_id: string;
  metrics: SemanticProfileMetricSet;
}>): Record<string, Record<string, number | null>> {
  const variants = new Map<string, typeof executions>();
  for (const execution of executions) {
    const entries = variants.get(execution.sanitizer_variant) ?? [];
    entries.push(execution);
    variants.set(execution.sanitizer_variant, entries);
  }
  return Object.fromEntries([...variants].map(([variant, entries]) => {
    const names = new Set(entries.flatMap(({ metrics }) => Object.keys(metrics) as Array<keyof SemanticProfileMetricSet>));
    const metrics = Object.fromEntries([...names].map((name) => {
      const taskValues = new Map<string, number[]>();
      for (const entry of entries) {
        const metric = entry.metrics[name];
        if (metric.status !== "computed" || metric.value === null) continue;
        const key = `${entry.repo_id}\0${entry.task_id}`;
        const values = taskValues.get(key) ?? [];
        values.push(metric.value);
        taskValues.set(key, values);
      }
      const repoValues = new Map<string, number[]>();
      for (const [key, values] of taskValues) {
        const repoId = key.split("\0", 1)[0]!;
        const mean = average(values);
        const tasks = repoValues.get(repoId) ?? [];
        tasks.push(mean);
        repoValues.set(repoId, tasks);
      }
      const repoMeans = [...repoValues.values()].map(average);
      return [name, repoMeans.length === 0 ? null : average(repoMeans)];
    }));
    return [variant, metrics];
  }));
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function renderCsv(summary: Record<string, Record<string, number | null>>): string {
  const rows = ["sanitizer_variant,metric,value"];
  for (const [variant, metrics] of Object.entries(summary)) {
    for (const [metric, value] of Object.entries(metrics)) rows.push(`${variant},${metric},${value ?? ""}`);
  }
  return `${rows.join("\n")}\n`;
}

function renderMarkdown(runId: string, summary: Record<string, Record<string, number | null>>): string {
  const rows = Object.entries(summary).flatMap(([variant, metrics]) =>
    Object.entries(metrics).map(([metric, value]) => `| ${variant} | ${metric} | ${value ?? "-"} |`));
  return `# Semantic Profile A/B: ${runId}\n\n| Variant | Metric | Value |\n|---|---|---:|\n${rows.join("\n")}\n`;
}

function parseOptions(argv: string[]): Options {
  if (argv.length !== 2 || (argv[0] !== "--run-id" && argv[0] !== "--run-dir") || !argv[1]) {
    throw new Error("usage: --run-id <id> | --run-dir <path>");
  }
  return argv[0] === "--run-id" ? { runId: argv[1] } : { runDir: argv[1] };
}

if (isEntrypoint(import.meta.url)) {
  try { computeSemanticMetrics(); } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
