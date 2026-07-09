import { describe, expect, it } from "vitest";
import { GENERATION_RECORD_SCHEMA_VERSION, type GenerationRecord } from "./lib/generation-record.js";
import { aggregateByStrategy, buildCellMetrics, computeRegressionMetrics } from "./compute-generation-metrics.js";

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

describe("M1 silent-pass-on-unknown-runner guard", () => {
  it("GenerationRecord runner_error is optional and defaults to undefined (compat con v3 historico)", () => {
    // El campo runner_error es opcional para no romper generation.jsonl
    // historicos (v3 sin campo).
    const record = rec({ test_exit_code: 0 });
    expect(record.runner_error).toBeUndefined();
  });

  it("buildCellMetrics propaga runner_error para que se pueda agregar aparte", () => {
    // El harness escribe runner_error="unknown_runner" cuando parseTestRunnerOutput
    // devuelve unknownRunner=true, y test_exit_code=null en ese caso. Esto evita
    // que isPass reporte pass silencioso y permite a m1_unknown_runner_count
    // contar las celdas afectadas por ruido del harness.
    const record = rec({ test_exit_code: null, runner_error: "unknown_runner" });
    const cell = buildCellMetrics(record, undefined);
    expect(cell.m1_runner_error).toBe("unknown_runner");
    expect(cell.m1_test_exit_code).toBeNull();
    // isPass con test_exit_code null debe devolver pass=false (isPass logica ya
    // probada: retorna { pass: false, reason: "no_tests" }).
    expect(cell.m1_pass).toBe(false);
  });

  it("buildCellMetrics marca runner_error=null cuando el runner es conocido y exit=0", () => {
    const record = rec({ test_exit_code: 0 });
    const cell = buildCellMetrics(record, undefined);
    expect(cell.m1_runner_error).toBeNull();
    expect(cell.m1_pass).toBe(true);
  });
});

describe("panel norte: end-to-end time y costo", () => {
  it("suma overhead de recuperación + tiempo de agente y agrega costo solo de celdas con costo", () => {
    const cells = [
      // hybrid: overhead 50 + agente 100 = 150; costo 0.02
      buildCellMetrics(rec({ strategy_id: "hybrid", agent_duration_ms: 100, cost_usd: 0.02 }), undefined, 50),
      // hybrid: overhead 60 + agente 200 = 260; sin costo (null)
      buildCellMetrics(rec({ strategy_id: "hybrid", task_id: "zod-002", agent_duration_ms: 200, cost_usd: null }), undefined, 60),
      // no_context: overhead 0 (baseline no paga recuperación)
      buildCellMetrics(rec({ strategy_id: "no_context", agent_duration_ms: 300, cost_usd: 0.05 }), undefined, 0),
    ];
    const agg = aggregateByStrategy(cells);

    expect(agg.hybrid!.retrieval_overhead_ms_mean).toBe(55); // (50+60)/2
    expect(agg.hybrid!.agent_duration_ms_mean).toBe(150);    // (100+200)/2
    expect(agg.hybrid!.end_to_end_ms_mean).toBe(205);        // (150+260)/2
    expect(agg.hybrid!.cost_usd_mean).toBeCloseTo(0.02, 6);  // solo la celda con costo
    expect(agg.hybrid!.cost_cells).toBe(1);

    // no_context: overhead 0 → end-to-end = solo agente.
    expect(agg.no_context!.retrieval_overhead_ms_mean).toBe(0);
    expect(agg.no_context!.end_to_end_ms_mean).toBe(300);
  });
});
