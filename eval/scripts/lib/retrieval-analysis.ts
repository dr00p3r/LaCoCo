import { asNumber, asRecord, asString } from "./config.js";
import { fileOfNodeId, type ExecutionMetricResult, type GoldInput, type RetrievalInputRecord } from "./metrics.js";

export type RetrievalAnalysisWarning =
  | "single_gold_precision_ceiling"
  | "rpr_external_terminal_nodes"
  | "no_gold_in_candidates";

export interface RetrievalCellAnalysis {
  run_id: string;
  task_id: string;
  repo_id: string;
  strategy_id: string;
  gold_rank: number | null;
  gold_in_top5: boolean;
  gold_in_top20: boolean;
  retrieved_count: number;
  external_node_count: number;
  top_external_nodes: string[];
  query_length: number;
  clean_query_length: number | null;
  has_url: boolean;
  has_diff_block: boolean;
  warnings: RetrievalAnalysisWarning[];
}

export interface StrategyRetrievalDiagnostic {
  strategy_id: string;
  cells: number;
  failed_cells: number;
  excluded_cells: number;
  single_gold_cells: number;
  no_gold_in_candidates: number;
  rpr_external_terminal_nodes: number;
  gold_top_rank: {
    rank1: number;
    top5: number;
    top20: number;
    missing: number;
  };
  evidence_status_counts: Record<string, number>;
  query_noise: {
    has_url: number;
    has_diff_block: number;
  };
}

function optionalString(value: unknown, path: string): string | null {
  if (value === undefined || value === null) return null;
  return asString(value, path);
}

function rawQuery(raw: unknown): string {
  const root = asRecord(raw, "retrieval record");
  return optionalString(root.query, "retrieval record.query") ?? "";
}

function rawCleanQuery(raw: unknown): string | null {
  const root = asRecord(raw, "retrieval record");
  if (root.classification === undefined || root.classification === null) return null;
  const classification = asRecord(root.classification, "retrieval record.classification");
  return optionalString(
    classification.cleanQuery ?? classification.clean_query,
    "retrieval record.classification.cleanQuery",
  );
}

function isExternalNode(node: { nodeId: string }, rawNode: unknown): boolean {
  if (node.nodeId.startsWith("lib#")) return true;
  if (typeof rawNode !== "object" || rawNode === null || Array.isArray(rawNode)) return false;
  const record = rawNode as Record<string, unknown>;
  return record.source === "external" || record.kind === "external" || record.kind === "external-import";
}

function rawRankedNodes(raw: unknown): unknown[] {
  const root = asRecord(raw, "retrieval record");
  const ranked = root.ranked_nodes ?? root.chunks;
  if (!Array.isArray(ranked)) {
    throw new Error("retrieval record.ranked_nodes or chunks must be an array");
  }
  return ranked;
}

function includesUrl(value: string): boolean {
  return /https?:\/\/|www\./iu.test(value);
}

function includesDiffBlock(value: string): boolean {
  return /```diff|^diff --git |\n[+-]{1,3} /imu.test(value);
}

export function analyzeRetrievalCell(
  record: RetrievalInputRecord,
  raw: unknown,
  gold: GoldInput,
): RetrievalCellAnalysis {
  const rawNodes = rawRankedNodes(raw);
  // El "gold rank" del diagnóstico se mide contra el EDIT-SITE (archivo o símbolo
  // editado por el patch), que es la señal que de verdad importa. Un nodo cuenta
  // si su id coincide con un símbolo editado o su archivo con un archivo editado.
  const editSymbols = new Set(gold.editSiteSymbols);
  const editFiles = new Set(gold.editSiteFiles);
  // "single gold" = un único ARCHIVO edit-site (techo de precisión). Cuenta
  // archivos distintos (un archivo + su símbolo no son dos golds).
  const editSiteCount = new Set([...editFiles, ...[...editSymbols].map(fileOfNodeId)]).size;
  const goldRanks = record.rankedNodes
    .filter(({ nodeId }) => editSymbols.has(nodeId) || editFiles.has(fileOfNodeId(nodeId)))
    .map(({ rank }) => rank)
    .sort((left, right) => left - right);
  const goldRank = goldRanks[0] ?? null;
  const externalNodes = record.rankedNodes.filter((node, index) => isExternalNode(node, rawNodes[index]));
  const query = rawQuery(raw);
  const cleanQuery = rawCleanQuery(raw);
  const warnings: RetrievalAnalysisWarning[] = [];
  if (gold.status === "ready" && editSiteCount === 1) {
    warnings.push("single_gold_precision_ceiling");
  }
  if (record.exitCode === 0 && gold.status === "ready" && editSiteCount > 0 && goldRank === null) {
    warnings.push("no_gold_in_candidates");
  }
  const topFiveExternal = record.rankedNodes
    .slice(0, 5)
    .filter((node, index) => isExternalNode(node, rawNodes[index])).length;
  if (record.strategyId.startsWith("rpr") && topFiveExternal >= 3) {
    warnings.push("rpr_external_terminal_nodes");
  }
  return {
    run_id: record.runId,
    task_id: record.taskId,
    repo_id: record.repoId,
    strategy_id: record.strategyId,
    gold_rank: goldRank,
    gold_in_top5: goldRank !== null && goldRank <= 5,
    gold_in_top20: goldRank !== null && goldRank <= 20,
    retrieved_count: record.rankedNodes.length,
    external_node_count: externalNodes.length,
    top_external_nodes: externalNodes.slice(0, 5).map(({ nodeId }) => nodeId),
    query_length: query.length,
    clean_query_length: cleanQuery === null ? null : cleanQuery.length,
    has_url: includesUrl(`${query}\n${cleanQuery ?? ""}`),
    has_diff_block: includesDiffBlock(`${query}\n${cleanQuery ?? ""}`),
    warnings,
  };
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function metricStatusCounts(executions: ExecutionMetricResult[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const execution of executions) {
    increment(counts, execution.metrics.PatchEvidenceHit.status);
  }
  return counts;
}

export function summarizeRetrievalDiagnostics(
  cells: RetrievalCellAnalysis[],
  executions: ExecutionMetricResult[],
): StrategyRetrievalDiagnostic[] {
  const executionsByStrategy = new Map<string, ExecutionMetricResult[]>();
  for (const execution of executions) {
    const current = executionsByStrategy.get(execution.strategy_id) ?? [];
    current.push(execution);
    executionsByStrategy.set(execution.strategy_id, current);
  }

  const grouped = new Map<string, RetrievalCellAnalysis[]>();
  for (const cell of cells) {
    const current = grouped.get(cell.strategy_id) ?? [];
    current.push(cell);
    grouped.set(cell.strategy_id, current);
  }

  return [...grouped.entries()]
    .map(([strategyId, strategyCells]) => {
      const strategyExecutions = executionsByStrategy.get(strategyId) ?? [];
      return {
        strategy_id: strategyId,
        cells: strategyCells.length,
        failed_cells: strategyExecutions.filter(({ exit_code }) => exit_code !== 0).length,
        excluded_cells: strategyExecutions.filter(({ metrics }) =>
          metrics.EditSiteHit.status !== "computed",
        ).length,
        single_gold_cells: strategyCells.filter(({ warnings }) =>
          warnings.includes("single_gold_precision_ceiling"),
        ).length,
        no_gold_in_candidates: strategyCells.filter(({ warnings }) =>
          warnings.includes("no_gold_in_candidates"),
        ).length,
        rpr_external_terminal_nodes: strategyCells.filter(({ warnings }) =>
          warnings.includes("rpr_external_terminal_nodes"),
        ).length,
        gold_top_rank: {
          rank1: strategyCells.filter(({ gold_rank }) => gold_rank === 1).length,
          top5: strategyCells.filter(({ gold_in_top5 }) => gold_in_top5).length,
          top20: strategyCells.filter(({ gold_in_top20 }) => gold_in_top20).length,
          missing: strategyCells.filter(({ gold_rank }) => gold_rank === null).length,
        },
        evidence_status_counts: metricStatusCounts(strategyExecutions),
        query_noise: {
          has_url: strategyCells.filter(({ has_url }) => has_url).length,
          has_diff_block: strategyCells.filter(({ has_diff_block }) => has_diff_block).length,
        },
      } satisfies StrategyRetrievalDiagnostic;
    })
    .sort((left, right) => left.strategy_id.localeCompare(right.strategy_id));
}

export function parseRawRetrievalSchemaVersion(raw: unknown, path: string): number {
  return asNumber(asRecord(raw, path).schema_version, `${path}.schema_version`);
}
