import { asNumber, asRecord, asString } from "./config.js";
import type { GraphLookup } from "./graph-reader.js";
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
    `clean_query: ${JSON.stringify(task.deterministic_input.clean_query)}`,
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
    "",
    "## Editable annotation",
    "",
    "```yaml",
    "gold:",
    "  status: ready",
    "  relevant_nodes:",
    ...yamlList(task.gold.relevant_nodes),
    "  multihop_nodes:",
    ...yamlList(task.gold.multihop_nodes),
    "  target_tests:",
    ...yamlList(task.target_tests),
    `  annotation_notes: ${JSON.stringify(task.gold.annotation_notes)}`,
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
  graphWarning?: string,
): TaskGoldValidation {
  const issues: ValidationIssue[] = [
    ...emptyStringIssues("relevant_nodes", task.gold.relevant_nodes),
    ...emptyStringIssues("multihop_nodes", task.gold.multihop_nodes),
    ...emptyStringIssues("target_tests", task.target_tests),
  ];
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
  }

  const annotatedNodeIds = [...new Set([
    ...task.gold.relevant_nodes,
    ...task.gold.multihop_nodes,
  ].filter((value) => value.trim().length > 0))];
  if (graph === null) {
    issues.push({
      level: "warning",
      code: "graph_unavailable",
      message: graphWarning ?? "graph database is unavailable; node IDs were not checked",
    });
  } else {
    for (const nodeId of graph.findMissingNodeIds(annotatedNodeIds)) {
      issues.push({
        level: "error",
        code: "node_not_in_graph",
        message: `annotated node does not exist in graph: ${nodeId}`,
      });
    }
  }
  if (task.gold.multihop_nodes.length > 0) {
    issues.push({
      level: "warning",
      code: "multihop_distance_not_checked",
      message: "multihop distance was not checked because no primary anchor is annotated",
    });
  }

  const invalid = issues.some(({ level }) => level === "error");
  return {
    taskId: task.id,
    repoId: task.repo_id,
    status: invalid ? "invalid" : task.gold.status === "ready" ? "valid" : "pending",
    issues,
  };
}
