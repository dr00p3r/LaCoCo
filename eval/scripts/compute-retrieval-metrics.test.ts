import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { computeRetrievalMetrics, detectAllZeroRetrieval } from "./compute-retrieval-metrics.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { loadManifests } from "./lib/load-manifests.js";
import type { summarizeTaskMetrics } from "./lib/metrics.js";

// Escribe un repos.lock.json mínimo válido en el run dir, con la MISMA ruta y
// nombre de archivo que resuelve producción (`join(runDir, basename(layout.lockFile))`).
// `repoPath` es el árbol contra el que se resuelve el gold relativo.
function writeLock(runDirectory: string, runId: string, repoId: string, repoPath: string): void {
  const layout = resolveEvalLayout(loadManifests().run, runId);
  const lock = {
    schemaVersion: 1,
    runId,
    updatedAt: "2026-07-07T00:00:00.000Z",
    repositories: [
      {
        id: repoId,
        url: "https://example.invalid/repo.git",
        requestedRef: "main",
        commit: "0".repeat(40),
        repoPath,
        preparedAt: "2026-07-07T00:00:00.000Z",
        steps: { checkout: "passed" as const },
      },
    ],
  };
  writeFileSync(join(runDirectory, basename(layout.lockFile)), `${JSON.stringify(lock)}\n`, "utf8");
}

// Escribe un grafo stub en `<runDir>/indexes/<repoId>/tensor.sqlite` con los nodos
// indicados. `findGraphDatabase` prioriza el índice del run dir sobre el compartido
// (`paths.indexes`), así que esto HERMETIZA el gate de validez: sin él, el gate
// resolvería contra cualquier índice real de `<repoId>` que exista en disco
// (p. ej. `eval/workdir/indexes/zod/`), cuyos paths no coinciden con el temp repoPath
// del test → `gold_not_in_graph` en vez del `computed` que la regresión clava.
function writeStubGraph(
  runDirectory: string,
  repoId: string,
  nodes: readonly { id: string; filepath: string }[],
): void {
  const graphPath = join(runDirectory, "indexes", repoId, "tensor.sqlite");
  mkdirSync(dirname(graphPath), { recursive: true });
  const database = new Database(graphPath);
  try {
    database.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, filepath TEXT)");
    const insert = database.prepare("INSERT INTO nodes (id, filepath) VALUES (?, ?)");
    for (const node of nodes) insert.run(node.id, node.filepath);
  } finally {
    database.close();
  }
}

describe("computeRetrievalMetrics", () => {
  it("writes JSON, CSV, and Markdown summaries for a run directory", () => {
    const runDirectory = mkdtempSync(join(tmpdir(), "lacoco-metrics-"));
    const runId = basename(runDirectory);
    const record = {
      schema_version: 1,
      run_id: runId,
      task_id: "dayjs-001",
      repo_id: "dayjs",
      strategy_id: "hybrid",
      lacoco_strategy: "hybrid",
      query: "query",
      gold_status: "pending_manual_annotation",
      ranked_nodes: [],
      timings_ms: { total: 43.2 },
      exit_code: 0,
      error: null,
    };
    writeFileSync(join(runDirectory, "retrieval.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

    computeRetrievalMetrics(["--run-dir", runDirectory]);

    const metricsPath = join(runDirectory, "retrieval-metrics.json");
    expect(existsSync(metricsPath)).toBe(true);
    expect(existsSync(join(runDirectory, "summary.csv"))).toBe(true);
    expect(existsSync(join(runDirectory, "summary.md"))).toBe(true);
    const output = JSON.parse(readFileSync(metricsPath, "utf8")) as {
      executions: Array<{ metrics: { EditSiteHit: { status: string }; Latency: { value: number } } }>;
    };
    expect(output.executions[0]?.metrics.EditSiteHit.status).toBe("excluded_from_gold_metrics");
    expect(output.executions[0]?.metrics.Latency.value).toBe(43.2);
  });

  // Regresión del bug de prefijo: el gold es repo-relativo y DEBE resolverse contra
  // el `repoPath` del lock del run (p. ej. repos-jina/), no contra `paths.repos`.
  // Resolverlo contra el árbol equivocado da 0 en TODAS las celdas sin error. Este
  // test clava que, cuando los ranked_nodes son absolutos bajo el repoPath del lock,
  // EditSiteHit sale computed=1 (los ids del patch-evidence resueltos coinciden).
  it("resolves relative gold against the lock repoPath (prefix regression)", () => {
    const runDirectory = mkdtempSync(join(tmpdir(), "lacoco-metrics-prefix-"));
    const runId = basename(runDirectory);
    // Árbol estilo Jina, distinto de paths.repos — reproduce la condición del bug.
    const repoPath = join(runDirectory, "repos-jina", "zod");
    writeLock(runDirectory, runId, "zod", repoPath);

    // zod-001 (gold `ready` en tasks.yaml) tiene relevant_nodes relativos como
    // `packages/zod/src/v3/types.ts#ZodString`. Resuelto contra el repoPath del
    // lock queda absoluto; el retriever emite ese id absoluto.
    const relPath = "packages/zod/src/v3/types.ts";
    const symbol = "ZodString";
    const absoluteNodeId = `${join(repoPath, relPath)}#${symbol}`;
    // El gate de validez exige que el gold sea alcanzable en el grafo. Sembramos un
    // grafo stub hermético con el edit-site symbol para que el verdict sea `reachable`
    // y EditSiteHit llegue a computarse (si no, `gold_not_in_graph` corta antes).
    writeStubGraph(runDirectory, "zod", [{ id: absoluteNodeId, filepath: join(repoPath, relPath) }]);
    const record = {
      schema_version: 1,
      run_id: runId,
      task_id: "zod-001",
      repo_id: "zod",
      strategy_id: "hybrid",
      lacoco_strategy: "hybrid",
      query: "reject empty strings after trim",
      gold_status: "ready",
      ranked_nodes: [{ rank: 1, node_id: absoluteNodeId }],
      timings_ms: { total: 12.5 },
      exit_code: 0,
      error: null,
    };
    writeFileSync(join(runDirectory, "retrieval.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

    computeRetrievalMetrics(["--run-dir", runDirectory]);

    const output = JSON.parse(
      readFileSync(join(runDirectory, "retrieval-metrics.json"), "utf8"),
    ) as { executions: Array<{ metrics: { EditSiteHit: { status: string; value: number | null } } }> };
    // Con la resolución correcta contra el repoPath del lock, el edit-site matchea →
    // EditSiteHit = 1. Con el bug (resolución contra paths.repos) sería 0.
    expect(output.executions[0]?.metrics.EditSiteHit.status).toBe("computed");
    expect(output.executions[0]?.metrics.EditSiteHit.value).toBe(1);
  });

  it("reports the resolved manifests directory and retrieval diagnostics", () => {
    const runDirectory = mkdtempSync(join(tmpdir(), "lacoco-metrics-swe-"));
    const runId = basename(runDirectory);
    const record = {
      schema_version: 1,
      run_id: runId,
      task_id: "svelte-510",
      repo_id: "svelte-510",
      strategy_id: "rpr",
      lacoco_strategy: "rpr",
      query: "REPL https://svelte.dev/repl\n```diff\n- old\n+ new\n```",
      classification: {
        cleanQuery: "REPL https://svelte.dev/repl\n```diff\n+ new\n```",
      },
      gold_status: "ready",
      ranked_nodes: [
        { rank: 1, node_id: "lib#typescript#push" },
        { rank: 2, node_id: "lib#typescript#shift" },
        { rank: 3, node_id: "lib#typescript#test" },
      ],
      timings_ms: { total: 12.5 },
      exit_code: 0,
      error: null,
    };
    writeFileSync(join(runDirectory, "retrieval.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

    computeRetrievalMetrics([
      "--run-dir",
      runDirectory,
      "--manifests-dir",
      "eval/manifests/swe-polybench",
    ]);

    const output = JSON.parse(
      readFileSync(join(runDirectory, "retrieval-metrics.json"), "utf8"),
    ) as {
      inputs: { tasks_manifest: string; metrics_manifest: string; manifests_dir: string };
      retrieval_analysis: {
        cells: Array<{ warnings: string[]; has_url: boolean; has_diff_block: boolean }>;
        by_strategy: Array<{ single_gold_cells: number; no_gold_in_candidates: number }>;
      };
    };
    expect(output.inputs).toMatchObject({
      manifests_dir: "eval/manifests/swe-polybench",
      tasks_manifest: "eval/manifests/swe-polybench/tasks.yaml",
      metrics_manifest: "eval/manifests/swe-polybench/metrics.yaml",
    });
    expect(output.retrieval_analysis.cells[0]?.warnings).toEqual([
      "single_gold_precision_ceiling",
      "no_gold_in_candidates",
      "rpr_external_terminal_nodes",
    ]);
    expect(output.retrieval_analysis.cells[0]?.has_url).toBe(true);
    expect(output.retrieval_analysis.cells[0]?.has_diff_block).toBe(true);
    expect(output.retrieval_analysis.by_strategy[0]).toMatchObject({
      single_gold_cells: 1,
      no_gold_in_candidates: 1,
    });
  });
});

describe("detectAllZeroRetrieval", () => {
  // El guard dispara cuando hay celdas elegibles (EditSiteHit computada) pero
  // EditSiteHit, EditSiteMRR y PatchEvidenceHit agregados son 0 en TODAS.
  function summaryWith(
    editSiteHit: number,
    editSiteMrr: number,
    patchEvidenceHit: number,
    eligibleCells = 1,
  ): ReturnType<typeof summarizeTaskMetrics> {
    const metric = (value: number) => ({
      value,
      included_task_values: eligibleCells,
      included_repo_values: eligibleCells,
      excluded_task_values: 0,
    });
    return {
      global: {
        scope_id: "global",
        metrics: {
          EditSiteHit: metric(editSiteHit),
          PatchEvidenceHit: metric(patchEvidenceHit),
          MRR: metric(0),
          EditSiteMRR: metric(editSiteMrr),
          UsefulContextCoverage: metric(0),
          ExternalNoiseRate: metric(0),
          Latency: metric(0),
        },
      },
      repos: [],
      tasks: [],
    } as unknown as ReturnType<typeof summarizeTaskMetrics>;
  }

  it("triggers when eligible cells are all zero (EditSiteHit/EditSiteMRR/PatchEvidenceHit=0)", () => {
    const guard = detectAllZeroRetrieval(summaryWith(0, 0, 0));
    expect(guard.triggered).toBe(true);
    expect(guard.eligibleCells).toBe(1);
    expect(guard.message).not.toBeNull();
  });

  it("does not trigger when any signal is non-zero", () => {
    expect(detectAllZeroRetrieval(summaryWith(0, 0.5, 0)).triggered).toBe(false);
    expect(detectAllZeroRetrieval(summaryWith(1, 0, 0)).triggered).toBe(false);
    expect(detectAllZeroRetrieval(summaryWith(0, 0, 1)).triggered).toBe(false);
  });

  it("does not trigger when there are no eligible cells", () => {
    expect(detectAllZeroRetrieval(summaryWith(0, 0, 0, 0)).triggered).toBe(false);
  });
});
