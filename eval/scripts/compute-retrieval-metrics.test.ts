import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { computeRetrievalMetrics } from "./compute-retrieval-metrics.js";

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
});
