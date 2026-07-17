import { describe, expect, it } from "vitest";
import { GENERATION_RECORD_SCHEMA_VERSION, type GenerationRecord } from "./lib/generation-record.js";
import { aggregateByStrategy, buildCellMetrics, classifyMeasurement, computeRegressionMetrics } from "./compute-generation-metrics.js";

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

describe("Pass@1 justo: clasificacion de medibilidad", () => {
  it("graded cuando hay veredicto de test (exit code no-null)", () => {
    expect(classifyMeasurement(rec({ test_exit_code: 0 })).class).toBe("graded");
    expect(classifyMeasurement(rec({ test_exit_code: 1 })).class).toBe("graded");
  });

  it("harness_invalid cuando invalid_reason esta puesto (build/zero_tests/etc)", () => {
    const out = classifyMeasurement(rec({ test_exit_code: null, invalid_reason: "build_failed" }));
    expect(out.class).toBe("harness_invalid");
    expect(out.reason).toBe("build_failed");
  });

  it("harness_invalid para unknown_runner (parser no reconocio el runner)", () => {
    expect(classifyMeasurement(rec({ test_exit_code: null, runner_error: "unknown_runner" })).class).toBe("harness_invalid");
  });

  it("harness_invalid cuando el agente produjo parche pero el test nunca corrio (muro de build)", () => {
    // mui-25874: patch_applied, sin timeout/error/invalid_reason, test_exit_code null.
    const out = classifyMeasurement(rec({ test_exit_code: null, patch_applied: true, timeout: false, error: null }));
    expect(out.class).toBe("harness_invalid");
    expect(out.reason).toBe("test_not_run");
  });

  it("agent_fault para agent_timeout (el agente corrio el timeout completo)", () => {
    const out = classifyMeasurement(rec({ test_exit_code: null, timeout: true, patch_applied: false, error: { type: "agent_timeout", message: "timed out after 900000 ms" } }));
    expect(out.class).toBe("agent_fault");
    expect(out.reason).toBe("agent_timeout");
  });

  it("agent_fault para no_patch (agente termino sin cambiar archivos)", () => {
    const out = classifyMeasurement(rec({ test_exit_code: null, patch_applied: false, timeout: false, error: null }));
    expect(out.class).toBe("agent_fault");
    expect(out.reason).toBe("no_patch");
  });

  it("invalid_reason gana sobre timeout (senal explicita del harness tiene prioridad)", () => {
    const out = classifyMeasurement(rec({ test_exit_code: null, timeout: true, invalid_reason: "zero_tests_matched" }));
    expect(out.class).toBe("harness_invalid");
    expect(out.reason).toBe("zero_tests_matched");
  });
});

describe("Pass@1 justo: denominadores y cobertura", () => {
  it("graded excluye harness_invalid Y agent_fault; attributable incluye agent_fault", () => {
    const cells = [
      // 2 graded pass, 1 graded fail
      buildCellMetrics(rec({ strategy_id: "connector", task_id: "t1", test_exit_code: 0 }), undefined),
      buildCellMetrics(rec({ strategy_id: "connector", task_id: "t2", test_exit_code: 0 }), undefined),
      buildCellMetrics(rec({ strategy_id: "connector", task_id: "t3", test_exit_code: 1 }), undefined),
      // 1 harness_invalid (excluida de AMBOS denominadores)
      buildCellMetrics(rec({ strategy_id: "connector", task_id: "t4", test_exit_code: null, invalid_reason: "build_failed" }), undefined),
      // 1 agent_fault (excluida de graded, contada como fallo en attributable)
      buildCellMetrics(rec({ strategy_id: "connector", task_id: "t5", test_exit_code: null, patch_applied: false, error: null }), undefined),
    ];
    const agg = aggregateByStrategy(cells).connector!;

    expect(agg.m1_total).toBe(5);
    expect(agg.graded_count).toBe(3);
    expect(agg.harness_invalid_count).toBe(1);
    expect(agg.agent_fault_count).toBe(1);

    // graded = 2 pass / 3 gradadas
    expect(agg.pass_at_1_graded).toBeCloseTo(2 / 3, 6);
    // attributable = 2 pass / (3 gradadas + 1 agent_fault)
    expect(agg.pass_at_1_attributable).toBeCloseTo(2 / 4, 6);
    // legacy = 2 pass / 5 totales (deflactado por meter la harness_invalid)
    expect(agg.m1_pass_rate).toBeCloseTo(2 / 5, 6);

    // Panel de cobertura: subtipos.
    expect(agg.harness_invalid_reasons.build_failed).toBe(1);
    expect(agg.agent_fault_reasons.no_patch).toBe(1);
  });

  it("sin celdas gradadas → pass_at_1_graded null (no divide por cero)", () => {
    const agg = aggregateByStrategy([
      buildCellMetrics(rec({ strategy_id: "x", test_exit_code: null, invalid_reason: "zero_tests_matched" }), undefined),
    ]).x!;
    expect(agg.graded_count).toBe(0);
    expect(agg.pass_at_1_graded).toBeNull();
    expect(agg.pass_at_1_graded_ci).toBeNull();
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

describe("panel norte: esfuerzo del agente (tokens + tool-calls)", () => {
  it("promedia tokens/tool-calls solo sobre celdas con telemetría y perfila by_tool", () => {
    const cells = [
      buildCellMetrics(rec({
        strategy_id: "hybrid", task_id: "zod-001",
        tokens: { total: 1000, input: 800, output: 100, reasoning: 100, cache_read: 0, cache_write: 0 },
        tool_calls: { total: 5, by_tool: { grep: 2, read: 3 } },
      }), undefined),
      buildCellMetrics(rec({
        strategy_id: "hybrid", task_id: "zod-002",
        tokens: { total: 3000, input: 2000, output: 500, reasoning: 500, cache_read: 0, cache_write: 0 },
        tool_calls: { total: 9, by_tool: { grep: 4, bash: 5 } },
      }), undefined),
      // celda sin telemetría (record v3 histórico / no-opencode): NO cuenta en las medias.
      buildCellMetrics(rec({ strategy_id: "hybrid", task_id: "zod-003" }), undefined),
    ];
    const agg = aggregateByStrategy(cells).hybrid!;

    expect(agg.effort_cells).toBe(2);                 // la tercera celda no tiene telemetría
    expect(agg.tokens_total_mean).toBe(2000);         // (1000+3000)/2
    expect(agg.tokens_total_sum).toBe(4000);
    expect(agg.tool_calls_mean).toBe(7);              // (5+9)/2
    // by_tool promedia sobre las 2 celdas con telemetría (ausencia = 0):
    expect(agg.by_tool_mean.grep).toBe(3);            // (2+4)/2
    expect(agg.by_tool_mean.read).toBe(1.5);          // (3+0)/2
    expect(agg.by_tool_mean.bash).toBe(2.5);          // (0+5)/2
  });

  it("sin telemetría en ninguna celda → medias null y by_tool vacío", () => {
    const agg = aggregateByStrategy([
      buildCellMetrics(rec({ strategy_id: "no_context" }), undefined),
    ]).no_context!;
    expect(agg.effort_cells).toBe(0);
    expect(agg.tokens_total_mean).toBeNull();
    expect(agg.tool_calls_mean).toBeNull();
    expect(agg.by_tool_mean).toEqual({});
  });
});
