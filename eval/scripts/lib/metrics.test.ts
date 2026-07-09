import { describe, expect, it } from "vitest";
import {
  bootstrapMean,
  bootstrapRate,
  buildCoverageItems,
  computeExecutionMetrics,
  editSiteHitAtK,
  externalNoiseRateAtK,
  groupByTask,
  isExternalNodeId,
  mrrEditSite,
  mrrEvidence,
  parseRetrievalInput,
  patchEvidenceHitAtK,
  percentile,
  summarizeTaskMetrics,
  usefulContextCoverageAtK,
  type AggregatedMetric,
  type GoldInput,
  type MetricId,
  type RetrievalInputRecord,
  type TaskMetricResult,
} from "./metrics.js";

function record(overrides: Partial<RetrievalInputRecord> = {}): RetrievalInputRecord {
  return {
    schemaVersion: 1,
    runId: "run",
    taskId: "task",
    repoId: "repo",
    strategyId: "hybrid",
    rankedNodes: [
      { rank: 1, nodeId: "src/foo.ts#Foo" },
      { rank: 3, nodeId: "src/bar.ts#Bar" },
    ],
    totalLatencyMs: 10,
    exitCode: 0,
    ...overrides,
  };
}

function gold(overrides: Partial<GoldInput> = {}): GoldInput {
  return {
    status: "ready",
    editSiteFiles: [],
    editSiteSymbols: [],
    testFiles: [],
    refNodes: [],
    definitionNodes: [],
    ...overrides,
  };
}

describe("patch-evidence retrieval metrics", () => {
  const nodes = record().rankedNodes;

  it("isExternalNodeId flags lib# and node_modules", () => {
    expect(isExternalNodeId("lib#Array.map")).toBe(true);
    expect(isExternalNodeId("/repo/node_modules/rxjs/index.ts#of")).toBe(true);
    expect(isExternalNodeId("src/foo.ts#Foo")).toBe(false);
  });

  it("EditSiteHit@K hits by symbol and by file", () => {
    expect(editSiteHitAtK(nodes, gold({ editSiteSymbols: ["src/bar.ts#Bar"] }), 5)).toBe(true);
    // por archivo: el símbolo del gold no coincide pero el archivo sí.
    expect(editSiteHitAtK(nodes, gold({ editSiteFiles: ["src/foo.ts"] }), 5)).toBe(true);
    expect(editSiteHitAtK(nodes, gold({ editSiteFiles: ["src/other.ts"] }), 5)).toBe(false);
    // fuera del cutoff K
    expect(editSiteHitAtK(nodes, gold({ editSiteSymbols: ["src/bar.ts#Bar"] }), 2)).toBe(false);
  });

  it("PatchEvidenceHit@K counts any evidence but never external nodes", () => {
    const withExternal = [{ rank: 1, nodeId: "lib#Foo" }, { rank: 2, nodeId: "src/bar.ts#Bar" }];
    // un nodo lib# jamás cuenta como evidencia aunque coincida por nombre.
    expect(patchEvidenceHitAtK([{ rank: 1, nodeId: "lib#Foo" }], gold({ editSiteSymbols: ["lib#Foo"] }), 5)).toBe(false);
    // pero un test tocado (a nivel archivo) sí cuenta.
    expect(patchEvidenceHitAtK(withExternal, gold({ testFiles: ["src/bar.ts"] }), 5)).toBe(true);
    // y una definición resuelta (Tier 2) también.
    expect(patchEvidenceHitAtK(nodes, gold({ editSiteFiles: ["x"], definitionNodes: ["src/bar.ts#Bar"] }), 5)).toBe(true);
  });

  it("MRR and EditSiteMRR diverge when a trivial ref outranks the edit site", () => {
    const ranked = [
      { rank: 1, nodeId: "src/util.ts#helper" }, // ref trivial arriba
      { rank: 5, nodeId: "src/target.ts#fix" },  // edit-site abajo
    ];
    const g = gold({ editSiteSymbols: ["src/target.ts#fix"], refNodes: ["src/util.ts#helper"] });
    expect(mrrEvidence(ranked, g).value).toBe(1); // primer evidencia en rank 1
    expect(mrrEditSite(ranked, g).value).toBe(1 / 5); // primer edit-site en rank 5
  });

  it("MRR is zero (task still counted) when nothing matches", () => {
    const result = mrrEvidence(nodes, gold({ editSiteSymbols: ["src/missing.ts#Nope"] }));
    expect(result.value).toBe(0);
    expect(result.rank).toBeNull();
  });

  it("UsefulContextCoverage@K is stratified and falls back to file level", () => {
    const g = gold({
      editSiteFiles: ["src/foo.ts"],       // sin símbolo → item file-level
      testFiles: ["src/bar.ts"],
      definitionNodes: ["src/dep.ts#dep"], // no recuperado
    });
    const items = buildCoverageItems(g);
    expect(items.map((i) => i.stratum).sort()).toEqual(["definition", "edit_site", "test"]);
    const cov = usefulContextCoverageAtK(nodes, items, 5);
    // recuperó edit_site (foo.ts) y test (bar.ts), no la definición → 2/3.
    expect(cov.numerator).toBe(2);
    expect(cov.denominator).toBe(3);
    expect(cov.byStratum.edit_site).toEqual({ hit: 1, total: 1 });
    expect(cov.byStratum.definition).toEqual({ hit: 0, total: 1 });
  });

  it("buildCoverageItems prefers symbols over the file-level fallback", () => {
    const items = buildCoverageItems(gold({ editSiteFiles: ["src/foo.ts"], editSiteSymbols: ["src/foo.ts#Foo"] }));
    // el archivo foo.ts ya tiene símbolo → solo el ítem de nodo, sin doble conteo.
    expect(items).toEqual([{ stratum: "edit_site", kind: "node", value: "src/foo.ts#Foo" }]);
  });

  it("ExternalNoiseRate@K is the external fraction of top-K", () => {
    const ranked = [
      { rank: 1, nodeId: "lib#of" },
      { rank: 2, nodeId: "src/a.ts#A" },
      { rank: 3, nodeId: "lib#map" },
      { rank: 4, nodeId: "src/b.ts#B" },
    ];
    expect(externalNoiseRateAtK(ranked, 4)).toMatchObject({ value: 0.5, numerator: 2, denominator: 4 });
    expect(externalNoiseRateAtK([], 4)).toMatchObject({ value: 0, denominator: 0 });
  });

  it("computeExecutionMetrics computes all metrics for ready gold", () => {
    const result = computeExecutionMetrics(
      record(),
      gold({ editSiteSymbols: ["src/foo.ts#Foo"], testFiles: ["src/bar.ts"] }),
      5,
    );
    expect(result.metrics.EditSiteHit).toMatchObject({ status: "computed", value: 1 });
    expect(result.metrics.PatchEvidenceHit).toMatchObject({ status: "computed", value: 1 });
    expect(result.metrics.MRR).toMatchObject({ status: "computed", value: 1 });
    expect(result.metrics.EditSiteMRR).toMatchObject({ status: "computed", value: 1 });
    expect(result.metrics.UsefulContextCoverage.status).toBe("computed");
    expect(result.metrics.ExternalNoiseRate).toMatchObject({ status: "computed", value: 0 });
    expect(result.metrics.Latency).toMatchObject({ status: "computed", value: 10 });
    expect(result.details?.first_edit_site_rank).toBe(1);
  });

  it("marks ready gold with no edit site as invalid", () => {
    const result = computeExecutionMetrics(record(), gold({ testFiles: ["src/bar.ts"] }), 5);
    expect(result.metrics.EditSiteHit.status).toBe("invalid_gold");
    expect(result.metrics.UsefulContextCoverage.status).toBe("invalid_gold");
    // la latencia se computa igual.
    expect(result.metrics.Latency).toMatchObject({ status: "computed", value: 10 });
  });

  it("excludes gold metrics for non-ready gold but keeps latency", () => {
    const result = computeExecutionMetrics(
      record(),
      gold({ status: "pending_manual_annotation" }),
      5,
    );
    expect(result.metrics.EditSiteHit.status).toBe("excluded_from_gold_metrics");
    expect(result.metrics.Latency).toEqual({ status: "computed", value: 10 });
  });

  it("marks every metric as failed for a failed execution", () => {
    const result = computeExecutionMetrics(
      record({ exitCode: 1 }),
      gold({ editSiteSymbols: ["src/foo.ts#Foo"] }),
      5,
    );
    for (const metric of Object.values(result.metrics)) {
      expect(metric).toEqual({ status: "failed_execution", value: null });
    }
  });

  it("uses linear interpolation for latency P95 and macro-by-task-then-repo", () => {
    expect(percentile([10, 20], 95)).toBe(19.5);
    const executions = [10, 20].map((totalLatencyMs) =>
      computeExecutionMetrics(record({ totalLatencyMs }), gold({ status: "pending" }), 5),
    );
    expect(groupByTask(executions)[0]?.metrics.Latency.value).toBe(19.5);
  });

  it("computes the primary global average by task and then repo", () => {
    const metric = (value: number): AggregatedMetric => ({
      status: "computed",
      value,
      included: 1,
      excluded: 0,
      status_counts: { computed: 1 },
    });
    const group = (taskId: string, repoId: string, value: number): TaskMetricResult => ({
      task_id: taskId,
      repo_id: repoId,
      strategy_id: "hybrid",
      execution_count: 1,
      successful_execution_count: 1,
      metrics: Object.fromEntries(
        ([
          "EditSiteHit",
          "PatchEvidenceHit",
          "MRR",
          "EditSiteMRR",
          "UsefulContextCoverage",
          "ExternalNoiseRate",
          "Latency",
        ] as MetricId[]).map((id) => [id, metric(value)]),
      ) as Record<MetricId, AggregatedMetric>,
    });

    const summary = summarizeTaskMetrics([
      group("a-1", "repo-a", 0),
      group("a-2", "repo-a", 1),
      group("b-1", "repo-b", 1),
    ]);
    // repo-a macro = (0+1)/2 = 0.5; repo-b = 1; global macro = (0.5 + 1)/2 = 0.75.
    expect(summary.global.metrics.EditSiteHit.value).toBe(0.75);
    const editSite = summary.global.metrics.EditSiteHit;
    expect(editSite.ci_iterations).toBe(1000);
    if (editSite.ci_low !== null && editSite.ci_high !== null) {
      expect(editSite.ci_low).toBeLessThanOrEqual(editSite.value!);
      expect(editSite.ci_high).toBeGreaterThanOrEqual(editSite.value!);
    }
  });

  it("bootstrapMean reports null CI for degenerate or singleton samples", () => {
    expect(bootstrapMean([0.5, 0.5, 0.5]).ci_low).toBeNull();
    expect(bootstrapMean([0.42]).ci_low).toBeNull();
    expect(bootstrapRate(10, 10).ci_low).toBeNull();
    expect(bootstrapRate(0, 10).ci_low).toBeNull();
    expect(bootstrapRate(5, 1).ci_low).toBeNull();
  });

  it("bootstrap CIs are deterministic under a fixed seed", () => {
    const a = bootstrapMean([0, 0, 0, 0, 1, 1, 1, 1], { iterations: 1000, seed: 42 });
    const b = bootstrapMean([0, 0, 0, 0, 1, 1, 1, 1], { iterations: 1000, seed: 42 });
    expect(a).toEqual(b);
    expect(a.ci_low).not.toBeNull();
    const r = bootstrapRate(40, 100, { iterations: 1000, seed: 42 });
    expect(r.ci_low!).toBeLessThan(0.4);
    expect(r.ci_high!).toBeGreaterThan(0.4);
  });

  it("accepts chunk, node, and timing naming variants", () => {
    const base = {
      schema_version: 1,
      run_id: "run",
      task_id: "task",
      repo_id: "repo",
      strategy_id: "hybrid",
      ranked_nodes: [],
      exit_code: 0,
    };
    expect(parseRetrievalInput({ ...base, timings_ms: { total_ms: 12 } }, "record").totalLatencyMs).toBe(12);
    const variant = parseRetrievalInput({
      ...base,
      ranked_nodes: undefined,
      chunks: [{ nodeId: "src/foo.ts#Foo" }],
      timings_ms: { totalLatencyMs: 13 },
    }, "record");
    expect(variant.rankedNodes).toEqual([{ rank: 1, nodeId: "src/foo.ts#Foo" }]);
    expect(variant.totalLatencyMs).toBe(13);
    const missing = parseRetrievalInput(base, "record");
    expect(computeExecutionMetrics(missing, gold({ status: "pending" }), 5).metrics.Latency.status).toBe("missing_timing");
  });
});
