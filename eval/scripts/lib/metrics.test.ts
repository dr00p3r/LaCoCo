import { describe, expect, it } from "vitest";
import {
  computeExecutionMetrics,
  groupByTask,
  mrr,
  multiHopRecallAtK,
  parseRetrievalInput,
  percentile,
  precisionAtK,
  recallAtK,
  summarizeTaskMetrics,
  type AggregatedMetric,
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

describe("retrieval metrics", () => {
  const rankedNodes = record().rankedNodes;

  it("precisionAtK computes the relevant fraction over K", () => {
    expect(precisionAtK(rankedNodes, ["src/foo.ts#Foo", "src/bar.ts#Bar"], 5)).toBe(0.4);
  });

  it("recallAtK computes the recovered fraction of relevant gold", () => {
    expect(recallAtK(rankedNodes, ["src/foo.ts#Foo", "src/bar.ts#Bar"], 5)).toBe(1);
  });

  it("mrr returns the reciprocal rank of the first relevant node", () => {
    expect(mrr(rankedNodes, ["src/bar.ts#Bar"])).toBe(1 / 3);
  });

  it("mrr returns zero when no relevant node is retrieved", () => {
    expect(mrr(rankedNodes, ["src/missing.ts#Missing"])).toBe(0);
  });

  it("multiHopRecallAtK computes multihop recall", () => {
    expect(multiHopRecallAtK(rankedNodes, ["src/bar.ts#Bar"], 20)).toMatchObject({
      status: "computed",
      value: 1,
    });
  });

  it("multiHopRecallAtK is not applicable without multihop nodes", () => {
    expect(multiHopRecallAtK(rankedNodes, [], 20)).toEqual({
      status: "not_applicable",
      value: null,
    });
  });

  it("computes M3-M6 from ready set-based gold", () => {
    const result = computeExecutionMetrics(record(), {
      status: "ready",
      relevantNodes: ["src/foo.ts#Foo", "src/bar.ts#Bar"],
      multihopNodes: ["src/bar.ts#Bar"],
    });

    expect(result.metrics.M3).toMatchObject({ status: "computed", value: 0.4, numerator: 2, denominator: 5 });
    expect(result.metrics.M4).toMatchObject({ status: "computed", value: 1 });
    expect(result.metrics.M5).toMatchObject({ status: "computed", value: 1 });
    expect(result.metrics.M6).toMatchObject({ status: "computed", value: 1 });
    expect(result.metrics.M7).toMatchObject({ status: "computed", value: 10 });
  });

  it("excludes pending gold metrics while retaining latency", () => {
    const result = computeExecutionMetrics(record(), {
      status: "pending_manual_annotation",
      relevantNodes: [],
      multihopNodes: [],
    });

    expect(result.metrics.M3.status).toBe("excluded_from_gold_metrics");
    expect(result.metrics.M6.status).toBe("excluded_from_gold_metrics");
    expect(result.metrics.M7).toEqual({ status: "computed", value: 10 });
  });

  it("distinguishes invalid relevant gold from non-applicable multihop gold", () => {
    const result = computeExecutionMetrics(record(), {
      status: "ready",
      relevantNodes: [],
      multihopNodes: [],
    });

    expect(result.metrics.M3.status).toBe("invalid_gold");
    expect(result.metrics.M4.status).toBe("invalid_gold");
    expect(result.metrics.M5.status).toBe("invalid_gold");
    expect(result.metrics.M6.status).toBe("not_applicable");
  });

  it("excludes failed executions from every metric", () => {
    const result = computeExecutionMetrics(record({ exitCode: 1 }), {
      status: "ready",
      relevantNodes: ["src/foo.ts#Foo"],
      multihopNodes: ["src/bar.ts#Bar"],
    });

    for (const metric of Object.values(result.metrics)) {
      expect(metric).toEqual({ status: "failed_execution", value: null });
    }
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
    const snakeCase = parseRetrievalInput({
      ...base,
      ranked_nodes: [{ rank: 2, node_id: "src/bar.ts#Bar" }],
      timings_ms: { total: 11 },
    }, "record");
    expect(snakeCase.rankedNodes).toEqual([{ rank: 2, nodeId: "src/bar.ts#Bar" }]);
    const variant = parseRetrievalInput({
      ...base,
      ranked_nodes: undefined,
      chunks: [{ nodeId: "src/foo.ts#Foo" }],
      timings_ms: { totalLatencyMs: 13 },
    }, "record");
    expect(variant.rankedNodes).toEqual([{ rank: 1, nodeId: "src/foo.ts#Foo" }]);
    expect(variant.totalLatencyMs).toBe(13);
    const missing = parseRetrievalInput(base, "record");
    expect(computeExecutionMetrics(missing, {
      status: "pending",
      relevantNodes: [],
      multihopNodes: [],
    }).metrics.M7.status).toBe("missing_timing");
  });

  it("uses linear interpolation for latency P95", () => {
    expect(percentile([10, 20], 95)).toBe(19.5);
    const executions = [10, 20].map((totalLatencyMs) =>
      computeExecutionMetrics(record({ totalLatencyMs }), {
        status: "pending",
        relevantNodes: [],
        multihopNodes: [],
      }),
    );
    expect(groupByTask(executions)[0]?.metrics.M7.value).toBe(19.5);
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
        (["M3", "M4", "M5", "M6", "M7"] as MetricId[]).map((id) => [id, metric(value)]),
      ) as Record<MetricId, AggregatedMetric>,
    });

    const summary = summarizeTaskMetrics([
      group("a-1", "repo-a", 0),
      group("a-2", "repo-a", 1),
      group("b-1", "repo-b", 1),
    ]);
    expect(summary.global.metrics.M3.value).toBe(0.75);
  });
});
