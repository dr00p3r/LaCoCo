import { describe, expect, it } from "vitest";
import { GENERATION_RECORD_SCHEMA_VERSION, type GenerationRecord } from "./lib/generation-record.js";
import { computeRegressionMetrics } from "./compute-generation-metrics.js";

function rec(overrides: Partial<GenerationRecord>): GenerationRecord {
  return {
    schema_version: GENERATION_RECORD_SCHEMA_VERSION,
    run_id: "test",
    task_id: "zod-001",
    repo_id: "zod",
    strategy_id: "hybrid",
    agent_id: "opencode",
    model_id: "x",
    agent_exit_code: 0,
    agent_duration_ms: 1,
    cost_usd: null,
    patch_applied: true,
    patch_size_bytes: 0,
    files_changed_count: 0,
    test_exit_code: 0,
    test_duration_ms: 0,
    tests_passed: null,
    tests_failed: null,
    tests_total: null,
    timeout: false,
    baseline_failing_tests: [],
    post_failing_tests: [],
    grading_tests_passed: [],
    regression_introduced_failures: [],
    artifact_paths: {
      prompt: "p",
      context_json: null,
      stdout: "s",
      stderr: "se",
      command: "c",
      patch: "d",
      test_log: "t",
    },
    error: null,
    ...overrides,
  };
}

describe("computeRegressionMetrics", () => {
  it("returns nulls when no regression metadata is present", () => {
    const out = computeRegressionMetrics(rec({}));
    expect(out.regressionPass).toBeNull();
    expect(out.gradingPass).toBeNull();
    expect(out.targetPass).toBeNull();
    expect(out.introduced).toBe(0);
  });

  it("returns false for a record with regression baseline but no patch", () => {
    const out = computeRegressionMetrics(rec({
      baseline_failing_tests: ["trim"],
      patch_applied: false,
    }));
    expect(out.regressionPass).toBe(false);
    expect(out.gradingPass).toBe(false);
    expect(out.targetPass).toBe(false);
  });

  it("returns true when baseline failures are all fixed and target tests pass", () => {
    const out = computeRegressionMetrics(rec({
      baseline_failing_tests: ["trim"],
      post_failing_tests: [],
      grading_tests_passed: ["trim"],
    }));
    expect(out.regressionPass).toBe(true);
    expect(out.targetPass).toBe(true);
    expect(out.gradingPass).toBe(true);
  });

  it("returns false when some baseline failures remain", () => {
    const out = computeRegressionMetrics(rec({
      baseline_failing_tests: ["trim", "lowerCase"],
      post_failing_tests: ["trim"],
      grading_tests_passed: ["lowerCase"],
    }));
    expect(out.regressionPass).toBe(false);
  });

  it("reports introduced failures separately", () => {
    const out = computeRegressionMetrics(rec({
      baseline_failing_tests: ["trim"],
      post_failing_tests: ["trim", "newFailure"],
      grading_tests_passed: [],
      regression_introduced_failures: ["newFailure"],
    }));
    expect(out.regressionPass).toBe(false);
    expect(out.introduced).toBe(1);
  });
});
