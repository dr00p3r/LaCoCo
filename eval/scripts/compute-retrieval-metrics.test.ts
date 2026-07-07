import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
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
      executions: Array<{ metrics: { M3: { status: string }; M7: { value: number } } }>;
    };
    expect(output.executions[0]?.metrics.M3.status).toBe("excluded_from_gold_metrics");
    expect(output.executions[0]?.metrics.M7.value).toBe(43.2);
  });

  // Regresión del bug de prefijo: el gold es repo-relativo y DEBE resolverse contra
  // el `repoPath` del lock del run (p. ej. repos-jina/), no contra `paths.repos`.
  // Resolverlo contra el árbol equivocado da 0 en TODAS las celdas sin error. Este
  // test clava que, cuando los ranked_nodes son absolutos bajo el repoPath del lock,
  // M3 sale > 0 (los ids resueltos coinciden).
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
    ) as { executions: Array<{ metrics: { M3: { status: string; value: number | null } } }> };
    // Con la resolución correcta contra el repoPath del lock, el gold matchea →
    // precisión@5 = 1/5 = 0.2 (> 0). Con el bug (resolución contra paths.repos) sería 0.
    expect(output.executions[0]?.metrics.M3.status).toBe("computed");
    expect(output.executions[0]?.metrics.M3.value).toBeGreaterThan(0);
  });
});

describe("detectAllZeroRetrieval", () => {
  // `m3Cells` = celdas elegibles (M3 computada); `m6Cells` = celdas de multihop.
  function summaryWith(
    m3: number,
    m5: number,
    m6: number | null,
    m6Cells: number,
    m3Cells = 1,
  ): ReturnType<typeof summarizeTaskMetrics> {
    const metric = (value: number, cells: number) => ({
      value,
      included_task_values: cells,
      included_repo_values: cells,
      excluded_task_values: 0,
    });
    return {
      global: {
        scope_id: "global",
        metrics: {
          M3: metric(m3, m3Cells),
          M4: metric(0, m3Cells),
          M5: metric(m5, m3Cells),
          M6: metric(m6 ?? 0, m6Cells),
          M7: metric(0, m3Cells),
        },
      },
      repos: [],
      tasks: [],
    } as unknown as ReturnType<typeof summarizeTaskMetrics>;
  }

  it("triggers when eligible cells are all zero (M3/M5/M6=0)", () => {
    const guard = detectAllZeroRetrieval(summaryWith(0, 0, 0, 1));
    expect(guard.triggered).toBe(true);
    expect(guard.eligibleCells).toBe(1);
    expect(guard.message).not.toBeNull();
  });

  it("does not trigger when any signal is non-zero", () => {
    expect(detectAllZeroRetrieval(summaryWith(0, 0.5, 0, 1)).triggered).toBe(false);
    expect(detectAllZeroRetrieval(summaryWith(0.2, 0, 0, 1)).triggered).toBe(false);
  });

  it("ignores M6 when it has no computed cells", () => {
    // Sin celdas de multihop, M6 no cuenta: todo-cero en M3/M5 igual dispara.
    expect(detectAllZeroRetrieval(summaryWith(0, 0, null, 0)).triggered).toBe(true);
  });

  it("does not trigger when there are no eligible cells", () => {
    expect(detectAllZeroRetrieval(summaryWith(0, 0, 0, 0, 0)).triggered).toBe(false);
  });
});
