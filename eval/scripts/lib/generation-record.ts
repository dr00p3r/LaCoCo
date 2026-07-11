/**
 * Schema v3 del GenerationRecord. Cada ejecucion de un agente externo
 * sobre una combinacion (task, strategy, agent) produce uno de estos.
 *
 * V3 añade el set `baseline_failing_tests` capturado al preparar el
 * repositorio y los contadores `post_failing_tests` /
 * `grading_tests_passed` / `regression_introduced_failures` tras la
 * ejecucion. Permiten calcular las 4 sub-metricas de M1 en modo
 * regresion: M1_regression_pass (citable), M1_grading_pass,
 * M1_target_pass y M1_regression_introduced.
 *
 * El campo `error` es no-nulo cuando la ejecucion fallo por timeout,
 * crash del agente, o worktree corrupto. En ese caso, los campos de
 * patch/test quedan null y la entrada se considera un fail para M1.
 *
 * El campo opcional `runner_error` distingue "el comando test termino
 * con exit 0 pero el parser no reconocio el runner" (swe-polybench
 * mocha historico, formateadores no soportados) de un pass genuino.
 * Cuando != null, el runner forza `test_exit_code: null` para que
 * `isPass` reporte fail y `m1_unknown_runner_count` lo agregue aparte.
 */

/** Uso de tokens del agente, sumado sobre los `step_finish` del stream de opencode. */
export interface AgentTokenUsage {
  total: number;
  input: number;
  output: number;
  reasoning: number;
  cache_read: number;
  cache_write: number;
}

/** Conteo de tool-calls del agente por herramienta (`read`/`grep`/`bash`/…) + total. */
export interface AgentToolCalls {
  total: number;
  by_tool: Record<string, number>;
}

export interface GenerationRecord {
  schema_version: 3;
  run_id: string;
  task_id: string;
  repo_id: string;
  strategy_id: string;
  agent_id: string;
  model_id: string;

  // Salida del agente
  agent_exit_code: number | null;
  agent_duration_ms: number;
  cost_usd: number | null;

  // Telemetría de esfuerzo del agente (parseada del stream --format json de opencode).
  // Ejes INDEPENDIENTES del costo (útiles con proveedores/suscripciones que no reportan
  // `cost`). Opcionales para compat con generation.jsonl v3 históricos sin estos campos;
  // `null` para agentes no-opencode o cuando el stream no trajo el dato.
  tokens?: AgentTokenUsage | null;
  tool_calls?: AgentToolCalls | null;

  // Patch capturado del worktree
  patch_applied: boolean;
  patch_size_bytes: number;
  files_changed_count: number;

  // Tests focalizados ejecutados despues del agente
  test_exit_code: number | null;
  test_duration_ms: number;
  tests_passed: number | null;
  tests_failed: number | null;
  tests_total: number | null;
  timeout: boolean;

  // Modo regresion: conjunto de tests que fallaban en el broken_state base
  // y su estado tras la ejecucion del agente.
  baseline_failing_tests: string[];
  post_failing_tests: string[];
  grading_tests_passed: string[];
  regression_introduced_failures: string[];

  // Caminos a artefactos para reproducibilidad
  artifact_paths: {
    prompt: string;
    context_json: string | null;
    stdout: string;
    stderr: string;
    command: string;
    patch: string;
    test_log: string;
  };

  // Error no fatal: si != null, esta cell es un fail para M1
  error: { type: string; message: string } | null;

  // Diagnostico del harness: tests ejecutados pero output no parseable.
  // Opcional para mantener compat con generation.jsonl historicos (v3 sin campo).
  runner_error?: "unknown_runner" | null;
}

export const GENERATION_RECORD_SCHEMA_VERSION = 3;

export function makeEmptyArtifactPaths(taskDir: string): GenerationRecord["artifact_paths"] {
  return {
    prompt: `${taskDir}/prompt.md`,
    context_json: null,
    stdout: `${taskDir}/agent.stdout.log`,
    stderr: `${taskDir}/agent.stderr.log`,
    command: `${taskDir}/command.log`,
    patch: `${taskDir}/patch.diff`,
    test_log: `${taskDir}/tests.log`,
  };
}
