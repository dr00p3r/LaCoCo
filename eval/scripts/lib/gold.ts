import { asNumber, asRecord, asString } from "./config.js";
import type { GraphLookup } from "./graph-reader.js";
import { resolveNodeId } from "./node-id.js";
import type { TaskDefinition } from "./types.js";

export interface RetrievalCandidate {
  strategyId: string;
  rank: number;
  nodeId: string;
  score: number | null;
  source: string;
  text: string;
  filepath?: string;
  kind?: string;
}

export interface ValidationIssue {
  level: "error" | "warning";
  code: string;
  message: string;
}

export interface TaskGoldValidation {
  taskId: string;
  repoId: string;
  status: "valid" | "pending" | "invalid";
  issues: ValidationIssue[];
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return asString(value, path);
}

function optionalNumber(value: unknown, path: string): number | null {
  if (value === undefined || value === null) return null;
  return asNumber(value, path);
}

export function parseCandidateRecord(value: unknown, path: string): {
  taskId: string;
  candidates: RetrievalCandidate[];
} {
  const root = asRecord(value, path);
  const ranked = root.ranked_nodes ?? root.chunks;
  if (!Array.isArray(ranked)) {
    throw new Error(`${path}.ranked_nodes or chunks must be an array`);
  }
  const strategyId = asString(root.strategy_id, `${path}.strategy_id`);
  return {
    taskId: asString(root.task_id, `${path}.task_id`),
    candidates: ranked.map((entry, index) => {
      const candidatePath = `${path}.ranked_nodes[${index}]`;
      const candidate = asRecord(entry, candidatePath);
      const nodeId = candidate.node_id ?? candidate.nodeId;
      const filepath = optionalString(candidate.filepath, `${candidatePath}.filepath`);
      const kind = optionalString(candidate.kind, `${candidatePath}.kind`);
      return {
        strategyId,
        rank: candidate.rank === undefined
          ? index + 1
          : asNumber(candidate.rank, `${candidatePath}.rank`),
        nodeId: asString(nodeId, `${candidatePath}.node_id or nodeId`),
        score: optionalNumber(candidate.score, `${candidatePath}.score`),
        source: optionalString(candidate.source, `${candidatePath}.source`) ?? "unknown",
        text: optionalString(candidate.text, `${candidatePath}.text`) ?? "",
        ...(filepath === undefined ? {} : { filepath }),
        ...(kind === undefined ? {} : { kind }),
      };
    }),
  };
}

export function deduplicateCandidates(candidates: RetrievalCandidate[]): RetrievalCandidate[] {
  const byStrategyAndNode = new Map<string, RetrievalCandidate>();
  for (const candidate of candidates) {
    const key = `${candidate.strategyId}\u0000${candidate.nodeId}`;
    const current = byStrategyAndNode.get(key);
    if (
      current === undefined ||
      candidate.rank < current.rank ||
      (candidate.rank === current.rank && (candidate.score ?? -Infinity) > (current.score ?? -Infinity))
    ) {
      byStrategyAndNode.set(key, candidate);
    }
  }
  return [...byStrategyAndNode.values()].sort((left, right) =>
    left.strategyId.localeCompare(right.strategyId) ||
    left.rank - right.rank ||
    left.nodeId.localeCompare(right.nodeId),
  );
}

function markdownCell(value: string): string {
  return value.replaceAll("|", "\\|").replace(/\s+/gu, " ").trim();
}

function shortText(value: string, maxLength = 180): string {
  const normalized = markdownCell(value);
  return normalized.length <= maxLength ? normalized : `${normalized.slice(0, maxLength - 1)}…`;
}

function yamlList(values: string[]): string[] {
  const entries = values.length === 0 ? [""] : values;
  return entries.map((value) => `    - ${JSON.stringify(value)}`);
}

export function renderGroundTruthWorksheet(
  task: TaskDefinition,
  candidates: RetrievalCandidate[],
): string {
  const rows = deduplicateCandidates(candidates).map((candidate) => [
    "|",
    markdownCell(candidate.strategyId),
    "|",
    String(candidate.rank),
    "|",
    markdownCell(candidate.nodeId),
    "|",
    candidate.score === null ? "" : String(candidate.score),
    "|",
    markdownCell(candidate.source),
    "|",
    markdownCell(candidate.filepath ?? ""),
    "|",
    markdownCell(candidate.kind ?? ""),
    "|",
    shortText(candidate.text),
    "|",
  ].join(" "));
  const dimensions = task.deterministic_input.dimensions
    .map((dimension) => `  - ${JSON.stringify(dimension)}`);
  return [
    `# Ground truth worksheet: ${task.id}`,
    "",
    "## Task metadata",
    "",
    `- task_id: \`${task.id}\``,
    `- repo_id: \`${task.repo_id}\``,
    `- title: ${task.title}`,
    `- current gold.status: \`${task.gold.status}\``,
    "",
    "### Prompt",
    "",
    task.prompt,
    "",
    "### Deterministic input",
    "",
    "```yaml",
    `retrieval_query: ${JSON.stringify(task.deterministic_input.retrieval_input.query)}`,
    `oracle_query: ${JSON.stringify(task.deterministic_input.oracle_input?.query ?? null)}`,
    `embedding_input: ${JSON.stringify(task.deterministic_input.embedding_input)}`,
    `intent: ${JSON.stringify(task.deterministic_input.intent)}`,
    "dimensions:",
    ...dimensions,
    "```",
    "",
    "### Expected areas",
    "",
    ...task.expected_areas.map((area) => `- ${area}`),
    "",
    "## Retrieved candidates",
    "",
    "Los rankings son candidatos; no constituyen ground truth.",
    "",
    "| Strategy | Rank | Node ID | Score | Source | Filepath | Kind | Text fragment |",
    "|---|---:|---|---:|---|---|---|---|",
    ...(rows.length === 0 ? ["| _none_ | | | | | | | |"] : rows),
    "",
    "## Manual annotation instructions",
    "",
    "- No copiar automaticamente todos los nodos recuperados.",
    "- Usar los rankings solo como candidatos.",
    "- Confirmar relevancia leyendo codigo y pruebas.",
    "- `multihop_nodes` debe ser subconjunto de `relevant_nodes`.",
    "- No marcar `ready` si `relevant_nodes` esta vacio.",
    "- Copiar `target_tests` al campo de nivel tarea `target_tests` en `tasks.yaml`.",
    "- Anotar `translation_gold.relevant_terms` manualmente; los candidatos no son gold.",
    "",
    "## Editable annotation",
    "",
    "```yaml",
    "gold:",
    "  status: ready",
    `  primary_anchor: ${JSON.stringify(task.gold.primary_anchor)}`,
    "  relevant_nodes:",
    ...yamlList(task.gold.relevant_nodes),
    "  multihop_nodes:",
    ...yamlList(task.gold.multihop_nodes),
    "  target_tests:",
    ...yamlList(task.target_tests),
    `  annotation_notes: ${JSON.stringify(task.gold.annotation_notes)}`,
    "```",
    "",
    "```yaml",
    "translation_gold:",
    "  status: ready",
    "  relevant_terms:",
    ...yamlList(task.translation_gold.relevant_terms),
    `  annotation_notes: ${JSON.stringify(task.translation_gold.annotation_notes)}`,
    "```",
    "",
  ].join("\n");
}

function emptyStringIssues(field: string, values: string[]): ValidationIssue[] {
  return values.flatMap((value, index) => value.trim().length === 0
    ? [{
      level: "error" as const,
      code: "empty_string",
      message: `${field}[${index}] must not be empty`,
    }]
    : []);
}

export function validateTaskGold(
  task: TaskDefinition,
  graph: GraphLookup | null,
  repoPath: string,
  graphWarning?: string,
): TaskGoldValidation {
  const multihopStatus = task.gold.multihop_status ?? "manual";
  // multihop_status="auto" admite multihop_nodes vacio como caso valido (el
  // traductor BFS-2 no encontro alcanzables): la tarea se excluye de M6.
  // multihop_status="manual" o "pending" sigue exigiendo lista no-vacia
  // para que un humano documente su intencion (comportamiento previo).
  const allowEmptyMultihop = multihopStatus === "auto";
  const issues: ValidationIssue[] = [
    ...emptyStringIssues("relevant_nodes", task.gold.relevant_nodes),
    ...(allowEmptyMultihop
      ? []
      : emptyStringIssues("multihop_nodes", task.gold.multihop_nodes)),
    ...emptyStringIssues("target_tests", task.target_tests),
    ...emptyStringIssues("translation_gold.relevant_terms", task.translation_gold.relevant_terms),
    ...(task.regression
      ? emptyStringIssues("regression.grading_tests", task.regression.grading_tests)
      : []),
  ];
  if (task.gold.status === "ready" && task.regression === undefined) {
    issues.push({
      level: "warning",
      code: "regression_required_for_generation",
      message: "ready task without regression: cannot be used in generation_pilot_regression; "
        + "see eval/manifests/regression/STATUS.md for tasks excluded from the regression pilot",
    });
  }
  if (task.regression !== undefined) {
    if (!/^[0-9a-f]{40}$/i.test(task.regression.base_commit)) {
      issues.push({
        level: "error",
        code: "regression_invalid_base_commit",
        message: `regression.base_commit must be a 40-char SHA-1: ${task.regression.base_commit}`,
      });
    }
  }
  if (task.translation_gold.status === "ready" && task.translation_gold.relevant_terms.length === 0) {
    issues.push({
      level: "error",
      code: "ready_without_translation_terms",
      message: "ready translation gold must contain at least one relevant term",
    });
  }
  const relevant = new Set(task.gold.relevant_nodes);
  for (const nodeId of task.gold.multihop_nodes) {
    if (!relevant.has(nodeId)) {
      issues.push({
        level: "error",
        code: "multihop_not_relevant",
        message: `multihop node is not present in relevant_nodes: ${nodeId}`,
      });
    }
  }
  const anchor = task.gold.primary_anchor === null || task.gold.primary_anchor.trim().length === 0
    ? null
    : task.gold.primary_anchor.trim();
  if (task.gold.status === "ready") {
    if (task.gold.relevant_nodes.length === 0) {
      issues.push({
        level: "error",
        code: "ready_without_relevant_nodes",
        message: "ready task must contain at least one relevant node",
      });
    }
    if (task.target_tests.length === 0) {
      issues.push({
        level: "error",
        code: "ready_without_target_tests",
        message: "ready task must define target_tests before generation",
      });
    }
    if (anchor === null) {
      issues.push({
        level: "error",
        code: "ready_without_primary_anchor",
        message: "ready task must annotate gold.primary_anchor so multihop distances are auditable",
      });
    } else if (!relevant.has(anchor)) {
      issues.push({
        level: "error",
        code: "anchor_not_relevant",
        message: `primary_anchor must also appear in relevant_nodes: ${anchor}`,
      });
    }
  }

  // Gold node ids are repo-relative; resolve to absolute to compare against the
  // graph (which stores absolute paths). Keep the relative id for messages.
  const uniqueRelIds = [...new Set([
    ...task.gold.relevant_nodes,
    ...task.gold.multihop_nodes,
    ...(anchor === null ? [] : [anchor]),
  ].filter((value) => value.trim().length > 0))];
  const absById = new Map(uniqueRelIds.map((rel) => [rel, resolveNodeId(rel, repoPath)]));

  if (graph === null) {
    issues.push({
      level: "warning",
      code: "graph_unavailable",
      message: graphWarning ?? "graph database is unavailable; node IDs were not checked",
    });
  } else {
    const missingAbs = new Set(graph.findMissingNodeIds([...absById.values()]));
    for (const [rel, abs] of absById) {
      if (missingAbs.has(abs)) {
        issues.push({
          level: "error",
          code: rel === anchor ? "anchor_not_in_graph" : "node_not_in_graph",
          message: `annotated node does not exist in graph: ${rel}`,
        });
      }
    }
    // Recompute multihop distances from the anchor so M6 gold is auditable.
    // Para multihop_status="auto" el traductor ya garantiza distancia >= 2
    // filtrada por CALLS/REFERENCES/DECLARES. El validador usa el grafo
    // completo (sin filtro), que puede dar distancia 1 via EXTENDS para un
    // nodo a distancia 2 filtrada: NO aplicamos la cota unfiltered>=2 en
    // ese caso para no romper el contrato del traductor.
    const anchorAbs = anchor === null ? null : absById.get(anchor)!;
    if (anchorAbs !== null && !missingAbs.has(anchorAbs)) {
      const distances = graph.distancesFrom(anchorAbs);
      for (const rel of task.gold.multihop_nodes) {
        if (rel.trim().length === 0 || missingAbs.has(absById.get(rel)!)) continue;
        const distance = distances.get(absById.get(rel)!);
        if (distance === undefined) {
          issues.push({
            level: "error",
            code: "multihop_unreachable",
            message: `multihop node is not reachable from the anchor in the graph: ${rel}`,
          });
        } else if (distance < 2 && multihopStatus !== "auto") {
          issues.push({
            level: "error",
            code: "multihop_distance_lt_2",
            message: `multihop node is at distance ${distance} (<2) from the anchor: ${rel}`,
          });
        }
      }
      // Relevant-but-disconnected nodes are legitimate (types/consts with no
      // static edge) but cannot be recalled via graph traversal; surface them.
      for (const rel of task.gold.relevant_nodes) {
        if (rel.trim().length === 0 || rel === anchor || missingAbs.has(absById.get(rel)!)) continue;
        if (!distances.has(absById.get(rel)!)) {
          issues.push({
            level: "warning",
            code: "relevant_node_disconnected",
            message: `relevant node is disconnected from the anchor subgraph: ${rel}`,
          });
        }
      }
    }
  }

  const invalid = issues.some(({ level }) => level === "error");
  return {
    taskId: task.id,
    repoId: task.repo_id,
    status: invalid ? "invalid" : task.gold.status === "ready" ? "valid" : "pending",
    issues,
  };
}
