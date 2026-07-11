/**
 * run-generation.ts
 *
 * Runner de la fase de generacion (M1, M2). Para cada combinacion
 * {task, strategy, agent} genera un patch con el agente externo y
 * ejecuta los tests focalizados. Resultado: `generation.jsonl`.
 *
 * Diferencias con run-retrieval.ts:
 *   - La estrategia `no_context` no tiene retrieval asociado. El prompt
 *     conserva el bloque LaCoCo con un placeholder explicito.
 *   - El worktree del repo se resetea entre celdas.
 *   - El agente externo se invoca segun `agents.yaml:30-82`.
 *   - Hay un budget USD opcional que detiene el runner al alcanzarse.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { parseEvalCliOptions, isEntrypoint } from "./lib/cli.js";
import { asBoolean, asNumber, asRecord, asString, asStringArray } from "./lib/config.js";
import { CommandExecutionError, executeCommand, shellQuote } from "./lib/exec.js";
import {
  applyBrokenPatch,
  captureWorkingTreeDiff,
  parseTestRunnerOutput,
  resetRepoClean,
} from "./lib/git.js";
import { loadManifests } from "./lib/load-manifests.js";
import {
  parseTestCommand,
  synthesizeF2pTestRun,
} from "./lib/swe-polybench-test-command.js";
import {
  type AgentDefinition,
  type StrategyDefinition,
  type TaskDefinition,
} from "./lib/types.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { readRepositoriesLock } from "./lib/repo-lock.js";
import { PROJECT_ROOT, resolveManifestsDir } from "./lib/paths.js";
import {
  GENERATION_RECORD_SCHEMA_VERSION,
  makeEmptyArtifactPaths,
  type GenerationRecord,
} from "./lib/generation-record.js";
import type { AgentsManifest } from "./lib/types.js";

interface GenerationSettings {
  splitName: string;
  enabled: boolean;
  agentTimeoutMs: number;
  testTimeoutMs: number;
  maxDiffBytes: number;
  maxChangedFiles: number;
  taskIds?: Set<string>;
  repoIds?: Set<string>;
  strategyIds: Set<string>;
  agentIds: Set<string>;
  // Variante de sanitizer cuyos registros de retrieval consume la generación.
  // "deterministic" (default) empareja `strategy.id`; cualquier otra (p. ej.
  // "grounded") empareja `${strategy.id}@${variant}`, que es como run-retrieval
  // etiqueta los registros no-deterministas.
  sanitizerVariant: string;
  continueOnTaskFailure: boolean;
  continueOnStrategyFailure: boolean;
}

const GENERATED_LOCKFILE_PATCH_EXCLUDES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
];

function ensureLaCoCoCliBin(runDirectory: string): { binDir: string; cliPath: string } {
  const cliPath = join(PROJECT_ROOT, "dist", "cli", "index.js");
  const binDir = join(runDirectory, "bin");
  const wrapperPath = join(binDir, "lacoco");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    wrapperPath,
    [
      "#!/usr/bin/env sh",
      `: "\${LACOCO_CLI:=${cliPath}}"`,
      'exec node "$LACOCO_CLI" "$@"',
      "",
    ].join("\n"),
    "utf8",
  );
  chmodSync(wrapperPath, 0o755);
  return { binDir, cliPath };
}

function agentEnvironment(input: {
  strategy: StrategyDefinition;
  agent: AgentDefinition;
  runDirectory: string;
  lacocoBinDir: string;
  lacocoCliPath: string;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    npm_config_loglevel: "silent",
    npm_config_update_notifier: "false",
    PATH: `${input.lacocoBinDir}:${process.env.PATH ?? ""}`,
    LACOCO_CLI: input.lacocoCliPath,
  };

  if (input.agent.id === "opencode" && input.strategy.id === "no_context") {
    const configHome = join(input.runDirectory, "opencode-no-skills-config");
    mkdirSync(join(configHome, "opencode"), { recursive: true });
    env.XDG_CONFIG_HOME = configHome;
  }

  return env;
}

/**
 * Id de estrategia con el que se busca el registro de retrieval y se etiqueta el
 * `generation.jsonl`. `no_context` es baseline sin retrieval (independiente de la
 * variante); el resto lleva sufijo `@variant` salvo en determinista.
 */
function recordStrategyId(strategyId: string, variant: string): string {
  if (strategyId === "no_context") return "no_context";
  return variant === "deterministic" ? strategyId : `${strategyId}@${variant}`;
}

export interface RetrievalJsonlRecord {
  run_id: string;
  task_id: string;
  repo_id: string;
  strategy_id: string;
  sanitizer_source?: string;
  sanitizer_variant?: string;
  artifact_paths: {
    context_json: string;
    sanitizer_json?: string | null;
  };
  error?: unknown;
}

function readGenerationSettings(
  runManifest: Record<string, unknown>,
  agentsManifest: AgentsManifest,
  requestedSplit: string,
  agentTimeoutOverrideMs?: number,
): GenerationSettings {
  const phases = asRecord(runManifest.phases, "run.yaml.phases");
  const generation = asRecord(phases.generation, "run.yaml.phases.generation");
  const failure = asRecord(runManifest.failure_policy, "run.yaml.failure_policy");
  const splits = asRecord(runManifest.splits, "run.yaml.splits");
  const splitValue = splits[requestedSplit];
  if (splitValue === undefined) {
    throw new Error(`split not found: ${requestedSplit}`);
  }
  const split = asRecord(splitValue, `run.yaml.splits.${requestedSplit}`);

  const phaseStrategies = new Set(asStringArray(generation.include_strategies, "run.yaml.phases.generation.include_strategies"));
  const splitStrategies = split.strategies === undefined
    ? undefined
    : new Set(asStringArray(split.strategies, `run.yaml.splits.${requestedSplit}.strategies`));
  const taskIds = split.task_ids === undefined
    ? undefined
    : new Set(asStringArray(split.task_ids, `run.yaml.splits.${requestedSplit}.task_ids`));
  const repoIds = split.repo_ids === undefined
    ? undefined
    : new Set(asStringArray(split.repo_ids, `run.yaml.splits.${requestedSplit}.repo_ids`));
  const splitAgents = split.agents === undefined
    ? undefined
    : new Set(asStringArray(split.agents, `run.yaml.splits.${requestedSplit}.agents`));
  const phaseAgents = splitAgents === undefined
    ? new Set([asString(generation.agent_id, "run.yaml.phases.generation.agent_id")])
    : splitAgents;
  const sanitizerVariant = split.sanitizer_variant === undefined
    ? "deterministic"
    : asString(split.sanitizer_variant, `run.yaml.splits.${requestedSplit}.sanitizer_variant`);

  // Intersect phase strategies with split strategies (split narrows the phase set)
  const strategyIds = splitStrategies === undefined
    ? phaseStrategies
    : new Set([...phaseStrategies].filter((id) => splitStrategies.has(id)));

  // agent defaults live in agents.yaml:defaults
  const agentsDefaults = asRecord(
    (agentsManifest as unknown as { defaults?: Record<string, unknown> }).defaults ?? {},
    "agents.yaml.defaults",
  );
  const maxDiffBytes = asNumber(agentsDefaults.max_diff_bytes ?? 2_000_000, "agents.yaml.defaults.max_diff_bytes");
  const maxChangedFiles = asNumber(agentsDefaults.max_changed_files ?? 20, "agents.yaml.defaults.max_changed_files");

  return {
    splitName: requestedSplit,
    enabled: asBoolean(generation.enabled, "run.yaml.phases.generation.enabled"),
    // `--timeout-ms` pisa SOLO el timeout del agente (para iterar rápido); el de
    // los tests sigue del yaml (los tests no se benefician de acortarlo).
    agentTimeoutMs: agentTimeoutOverrideMs ?? asNumber(generation.timeout_ms, "run.yaml.phases.generation.timeout_ms"),
    testTimeoutMs: asNumber(generation.timeout_ms, "run.yaml.phases.generation.timeout_ms"),
    maxDiffBytes,
    maxChangedFiles,
    ...(taskIds === undefined ? {} : { taskIds }),
    ...(repoIds === undefined ? {} : { repoIds }),
    strategyIds,
    agentIds: phaseAgents,
    sanitizerVariant,
    continueOnTaskFailure: asBoolean(failure.continue_on_task_failure, "run.yaml.failure_policy.continue_on_task_failure"),
    continueOnStrategyFailure: asBoolean(failure.continue_on_strategy_failure, "run.yaml.failure_policy.continue_on_strategy_failure"),
  };
}

function getAgentArgs(agent: AgentDefinition): string[] {
  const invocation = agent.invocation as { args?: unknown };
  const args = invocation?.args;
  if (!Array.isArray(args)) {
    throw new Error(`agent ${agent.id}.invocation.args must be an array`);
  }
  return args.filter((a): a is string => typeof a === "string");
}

function getAgentModel(agent: AgentDefinition): string {
  // Honor the env var override (LACOCO_EVAL_OPENCODE_MODEL, etc.) declared
  // in agents.yaml:model.env. The variable name is "LACOCO_EVAL_<AGENT_ID>_MODEL"
  // by convention, but the manifest provides it explicitly.
  const model = (agent as { model?: { env?: string; default?: unknown } }).model;
  if (model && typeof model.env === "string" && process.env[model.env] !== undefined) {
    return process.env[model.env] as string;
  }
  if (model && typeof model.default === "string") return model.default;
  throw new Error(`agent ${agent.id}.model.default must be a string`);
}

function getAgentProfile(agent: AgentDefinition): string {
  const profile = (agent as { agent_profile?: { default?: unknown } }).agent_profile;
  if (profile && typeof profile.default === "string") return profile.default;
  return "build";
}

function loadRetrievalJsonl(runDirectory: string): RetrievalJsonlRecord[] {
  const path = join(runDirectory, "retrieval.jsonl");
  if (!existsSync(path)) {
    throw new Error(`retrieval.jsonl not found at ${path}; run eval:retrieval first`);
  }
  const text = readFileSync(path, "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RetrievalJsonlRecord);
}

function findRetrievalRecord(
  records: RetrievalJsonlRecord[],
  taskId: string,
  strategyId: string,
): RetrievalJsonlRecord | null {
  if (strategyId === "no_context" || strategyId === "lacoco_skill") return null;
  const matches = records.filter((record) =>
    record.task_id === taskId && record.strategy_id === strategyId
  );
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one retrieval record for ${taskId} x ${strategyId}, found ${matches.length}`,
    );
  }
  const record = matches[0]!;
  if (record.error !== undefined && record.error !== null) {
    throw new Error(`retrieval record for ${taskId} x ${strategyId} contains an error`);
  }
  return record;
}

function resolveContextPath(record: RetrievalJsonlRecord): string {
  const contextPath = record.artifact_paths.context_json;
  return isAbsolute(contextPath) ? contextPath : join(PROJECT_ROOT, contextPath);
}

function resolveArtifactPath(artifactPath: string): string {
  return isAbsolute(artifactPath) ? artifactPath : join(PROJECT_ROOT, artifactPath);
}

function isAgentSkillStrategy(strategy: StrategyDefinition): boolean {
  const extra = strategy as { kind?: unknown; output_context_policy?: unknown };
  return extra.kind === "agent_skill" || extra.output_context_policy === "agent_skill";
}

export function loadRequiredEnrichedPrompt(record: RetrievalJsonlRecord): string {
  const contextPath = resolveContextPath(record);
  if (!existsSync(contextPath)) {
    throw new Error(
      `required context.json is missing for ${record.task_id} x ${record.strategy_id}: ${record.artifact_paths.context_json}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(contextPath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `required context.json is invalid JSON for ${record.task_id} x ${record.strategy_id}`,
      { cause: error },
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`required context.json is not an object for ${record.task_id} x ${record.strategy_id}`);
  }
  const context = parsed as Record<string, unknown>;
  if (context.ok !== true) {
    throw new Error(`required context.json is not a successful retrieval for ${record.task_id} x ${record.strategy_id}`);
  }
  if (typeof context.enrichedPrompt !== "string" || context.enrichedPrompt.trim().length === 0) {
    throw new Error(`required context.json has no enrichedPrompt for ${record.task_id} x ${record.strategy_id}`);
  }
  return context.enrichedPrompt;
}

/** Clave de celda (task, strategy) para el conjunto de celdas a saltar. */
function cellKey(taskId: string, strategyId: string): string {
  return `${taskId}__${strategyId}`;
}

/**
 * Preflight de contextos de retrieval. Devuelve el conjunto de celdas
 * `(task, strategy)` que deben SALTARSE porque su retrieval no está disponible
 * (no hay registro, p. ej. la tarea no entró al lock; o el registro trae error).
 * Esto honra `failure_policy.continue_on_task_failure`: una instancia sin
 * recuperación no debe abortar toda la generación.
 *
 * Sigue fallando DURO ante corrupción real de un registro que SÍ existe: registro
 * duplicado, sanitizer mal etiquetado, o `context.json` ausente/vacío — eso indica
 * un artefacto roto, no una tarea ausente.
 */
export function validateRetrievalContexts(
  records: RetrievalJsonlRecord[],
  tasks: TaskDefinition[],
  strategies: StrategyDefinition[],
  sanitizerVariant = "deterministic",
): Set<string> {
  const skip = new Set<string>();
  for (const task of tasks) {
    let frozenSanitizerPath: string | null = null;
    for (const strategy of strategies) {
      if (strategy.id === "no_context" || isAgentSkillStrategy(strategy)) continue;
      const recId = recordStrategyId(strategy.id, sanitizerVariant);
      const matches = records.filter((r) => r.task_id === task.id && r.strategy_id === recId);
      if (matches.length === 0) {
        // La tarea no se recuperó para esta estrategia → saltar la celda.
        skip.add(cellKey(task.id, strategy.id));
        continue;
      }
      if (matches.length > 1) {
        throw new Error(`expected exactly one retrieval record for ${task.id} x ${recId}, found ${matches.length}`);
      }
      const record = matches[0]!;
      if (record.error !== undefined && record.error !== null) {
        // Retrieval con error → no hay contexto usable; saltar la celda.
        skip.add(cellKey(task.id, strategy.id));
        continue;
      }
      if (record.sanitizer_source === "agent_intermediary") {
        if (record.sanitizer_variant === "deterministic") {
          throw new Error(
            `invalid sanitizer_variant for ${task.id} x ${strategy.id}: agent_intermediary cannot be deterministic`,
          );
        }
        const sanitizerPath = record.artifact_paths.sanitizer_json;
        if (typeof sanitizerPath !== "string" || sanitizerPath.length === 0) {
          throw new Error(`missing frozen sanitizer artifact for ${task.id} x ${strategy.id}`);
        }
        if (!existsSync(resolveArtifactPath(sanitizerPath))) {
          throw new Error(`frozen sanitizer artifact does not exist for ${task.id} x ${strategy.id}: ${sanitizerPath}`);
        }
        if (frozenSanitizerPath === null) frozenSanitizerPath = sanitizerPath;
        if (frozenSanitizerPath !== sanitizerPath) {
          throw new Error(`retrieval strategies do not share one frozen sanitizer for task ${task.id}`);
        }
      }
      loadRequiredEnrichedPrompt(record);
    }
  }
  return skip;
}

export function buildPrompt(
  task: TaskDefinition,
  strategy: StrategyDefinition,
  retrievalRecord: RetrievalJsonlRecord | null,
  regressionInfo?: { id: string; baseline_failing_tests: string[]; base_commit: string },
): string {
  const sections: string[] = [];
  sections.push(`# Tarea\n\n${task.prompt}`);
  sections.push(`# Repositorio\n\nid: ${task.repo_id}\ntype: ${task.type}\ndifficulty: ${task.difficulty}`);

  sections.push(
    [
      "# Restricciones",
      "",
      "- No modifiques archivos fuera del alcance de la tarea salvo que sea estrictamente necesario.",
      "- No actualices dependencias salvo que la tarea lo pida.",
      "- No cambies snapshots o tests para ocultar fallos.",
      "- Explica brevemente los archivos tocados si produces resumen.",
    ].join("\n"),
  );

  if (isAgentSkillStrategy(strategy)) {
    sections.push(
      [
        "# Contexto recuperado por LaCoCo",
        "",
        "No hay contexto preinyectado en este prompt.",
        "",
        "Debes usar la skill LaCoCo instalada para este repositorio antes de editar codigo:",
        "",
        "1. Carga la skill del repositorio si tu agente lo requiere.",
        "2. Construye una consulta estructurada a partir de la tarea.",
        "3. Ejecuta obligatoriamente `lacoco retrieve` con JSON por stdin, tal como indica la skill.",
        "4. Confirma que la respuesta JSON tenga `ok: true` y lee `contextBlock` antes de inspeccionar o editar archivos.",
        "5. Si el contexto no basta, inspecciona archivos o ejecuta otra consulta LaCoCo mas especifica.",
        "",
        "La carga de la skill o su snapshot inicial NO cuenta como recuperacion suficiente.",
        "Esta celda se marca invalida si el log no contiene una ejecucion real de `lacoco retrieve` con `contextBlock`.",
        "No edites archivos ni cierres la respuesta antes de recuperar contexto con LaCoCo.",
      ].join("\n"),
    );
  } else if (strategy.id === "no_context") {
    sections.push(
      [
        "# Contexto recuperado por LaCoCo",
        "",
        "No hay contexto recuperado para esta tarea.",
        "",
        "(El baseline `no_context` ejecuta el agente sin enriquecimiento contextual; la estructura del prompt se conserva identica a las demas condiciones.)",
      ].join("\n"),
    );
  } else {
    if (retrievalRecord === null) {
      throw new Error(`missing retrieval record for ${task.id} x ${strategy.id}`);
    }
    sections.push(`# Contexto recuperado por LaCoCo\n\n${loadRequiredEnrichedPrompt(retrievalRecord)}`);
  }

  if (regressionInfo !== undefined) {
    const shortSha = regressionInfo.base_commit.slice(0, 7);
    const failingList = regressionInfo.baseline_failing_tests.length === 0
      ? ["  (no tests detected in the captured baseline)"]
      : regressionInfo.baseline_failing_tests.map((name) => `  - ${name}`);
    sections.push(
      [
        "# Estado del repositorio",
        "",
        `El repositorio esta anclado al commit ${shortSha} y en este momento NO esta en verde.`,
        "Hay un conjunto de tests que actualmente fallan; tu objetivo es restaurarlos sin introducir fallos nuevos.",
        "",
        "Tests fallando ahora mismo:",
        ...failingList,
        "",
        "Comando de validacion (correlo antes de cerrar):",
        "```bash",
        ...task.target_tests,
        "```",
        "",
        "Restricciones adicionales:",
        "- No modifiques archivos de test para ocultar el fallo.",
        "- No anadas dependencias.",
        "- El repositorio NO contiene pistas sobre que archivo o simbolo esta roto: debes averiguarlo por inspection directa.",
      ].join("\n"),
    );
  } else if (task.target_tests.length > 0) {
    sections.push(
      [
        "# Pruebas esperadas",
        "",
        "Ejecuta el siguiente comando para validar la tarea:",
        "",
        "```bash",
        ...task.target_tests,
        "```",
      ].join("\n"),
    );
  }

  sections.push(
    [
      "# Instrucciones de salida",
      "",
      "- Realiza los cambios directamente en el repositorio.",
      "- No modifiques tests salvo que la tarea lo autorice.",
      "- No agregues dependencias nuevas.",
      "- El resultado debe poder validarse con el comando de prueba indicado.",
    ].join("\n"),
  );

  return sections.join("\n\n---\n\n");
}

function buildAgentCommand(
  agent: AgentDefinition,
  repoPath: string,
  promptFile: string,
  model: string,
  agentProfile: string,
): string {
  const args = getAgentArgs(agent).map((arg) => {
    let out = arg;
    out = out.replaceAll("{repo_path}", repoPath);
    out = out.replaceAll("{prompt_file}", promptFile);
    out = out.replaceAll("{model}", model);
    out = out.replaceAll("{agent_profile}", agentProfile);
    return out;
  });
  if (agent.command === null) {
    throw new Error(`agent ${agent.id}.command is null; cannot build invocation`);
  }
  return [agent.command, ...args].map(shellQuote).join(" ");
}

async function installLaCoCoSkillForAgent(
  repoPath: string,
  agentId: string,
  logPath: string,
): Promise<void> {
  const target = agentId === "opencode"
    ? "opencode"
    : agentId === "codex-cli"
      ? "codex"
      : agentId === "claude-code"
        ? "claude"
        : null;
  if (target === null) return;

  await executeCommand({
    command: [
      process.execPath,
      "--import",
      "tsx",
      join(PROJECT_ROOT, "src", "cli", "index.ts"),
      "skill",
      "update",
      repoPath,
      "--install",
      target,
      "--json",
    ].map(shellQuote).join(" "),
    cwd: PROJECT_ROOT,
    timeoutMs: 120_000,
    logPath,
  });
}

interface ParsedTestResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  logPath: string;
  /**
   * `true` cuando el comando test termino pero su stdout no es parseable
   * por los parsers soportados (vitest, jest, mocha). El harness fuerza
   * `test_exit_code: null` para que M1 no reporte un pass silencioso.
   */
  unknownRunner: boolean;
}

async function runTargetTests(
  testCommand: string,
  repoPath: string,
  timeoutMs: number,
  logPath: string,
): Promise<ParsedTestResult> {
  try {
    const result = await executeCommand({
      command: testCommand,
      cwd: repoPath,
      timeoutMs,
      logPath,
    });
    const parsed = parseTestRunnerOutput(result.stdout, result.stderr);
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      logPath,
      unknownRunner: parsed.unknownRunner,
    };
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      // Cuando el comando se mata por timeout/SIGTERM, el stdout puede estar
      // truncado; no aplicamos unknownRunner (el kill ya cuenta como fallo).
      return {
        exitCode: error.result.exitCode,
        timedOut: error.result.timedOut,
        durationMs: error.result.durationMs,
        logPath,
        unknownRunner: false,
      };
    }
    throw error;
  }
}

interface SwePolyTestOutcome {
  /** Exit del runner, o `null` si la MEDICIÓN es inválida (no un fallo del agente). */
  testExitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** Motivo por el que la medición es inválida (patch/build/zero-match), o `null`. */
  invalidReason: string | null;
  passed: number;
  failed: number;
}

/**
 * Corre los tests F2P de una instancia SWE-PolyBench y devuelve un exit code
 * *confiable* para M1/Pass@1. A diferencia del flujo legacy, aquí:
 *   1. Se aplica el `test_patch` — los tests F2P los CREA/MODIFICA ese patch;
 *      sin él no existen y mocha saldría 0 (pase falso silencioso).
 *   2. Se re-construye el repo (`npm run build`) — el fix del agente va en `src/`
 *      y los tests corren contra el build.
 *   3. Se filtra a los F2P con `--grep <slug>` (ver {@link synthesizeF2pTestRun}).
 *   4. Guarda anti-cero-match: si NINGÚN test corrió, la medición es inválida
 *      (`testExitCode=null`), nunca un pase.
 *
 * El `test_patch` y los artefactos de build se limpian con el `resetRepoClean`
 * que el llamador ya ejecuta al cerrar la celda.
 */
async function runSwePolybenchTests(
  repoPath: string,
  testPatchPath: string,
  testInvocation: string,
  expectedF2pCount: number,
  timeoutMs: number,
  logPath: string,
): Promise<SwePolyTestOutcome> {
  // 0. El gold de tests (test_patch) es autoritativo: el agente solo debe tocar
  //    `src/`. Si el agente escribió/editó archivos bajo `test/` (p.ej. creó los
  //    propios fixtures F2P), esas ediciones chocan con el test_patch ("already
  //    exists"/conflicto). Revertimos `test/` a base ANTES de aplicar el gold,
  //    preservando el fix en `src/`.
  // Secuencia a prueba de balas: unstage (por si el agente hizo `git add`) →
  // revertir tracked modificados → borrar untracked. Cubre los 3 estados en que
  // el agente pudo dejar `test/` (staged-nuevo, modificado, untracked).
  await executeCommand({
    command: "git reset -q -- test/ 2>/dev/null; git checkout -q HEAD -- test/ 2>/dev/null; git clean -fdq test/ 2>/dev/null; true",
    cwd: repoPath,
    timeoutMs: 60_000,
    logPath,
  }).catch(() => undefined);

  // 1. Aplicar el test_patch (crea los tests F2P). Falla → medición inválida.
  try {
    await executeCommand({
      command: `git apply ${shellQuote(testPatchPath)}`,
      cwd: repoPath,
      timeoutMs: 60_000,
      logPath,
    });
  } catch (error) {
    const message = error instanceof CommandExecutionError ? error.result.stderr.slice(0, 500) : String(error);
    writeFileSync(logPath, `(test_patch apply failed; measurement invalid)\n${message}\n`, "utf8");
    return { testExitCode: null, timedOut: false, durationMs: 0, invalidReason: "test_patch_apply_failed", passed: 0, failed: 0 };
  }

  // 2+3. Build (fix en src/) y correr solo los F2P.
  const command = `npm run build && ${testInvocation}`;
  let exitCode: number | null = null;
  let timedOut = false;
  let durationMs = 0;
  let stdout = "";
  let stderr = "";
  try {
    const result = await executeCommand({ command, cwd: repoPath, timeoutMs, logPath });
    exitCode = result.exitCode; durationMs = result.durationMs; stdout = result.stdout; stderr = result.stderr;
  } catch (error) {
    if (error instanceof CommandExecutionError) {
      exitCode = error.result.exitCode; timedOut = error.result.timedOut;
      durationMs = error.result.durationMs; stdout = error.result.stdout; stderr = error.result.stderr;
    } else {
      throw error;
    }
  }

  // 4. Guarda anti-cero-match: parsear el conteo real de tests.
  const parsed = parseTestRunnerOutput(stdout, stderr);
  const ran = parsed.totalPassed + parsed.totalFailed;
  if (ran === 0) {
    // 0 tests corridos = grep no matcheó / build rompió antes del runner. NO es un pase.
    return { testExitCode: null, timedOut, durationMs, invalidReason: "zero_tests_matched", passed: 0, failed: 0 };
  }
  if (ran < expectedF2pCount) {
    // Corrieron menos F2P de los esperados (grep parcial): medición no fiable → inválida, nunca pase.
    return { testExitCode: null, timedOut, durationMs, invalidReason: "fewer_tests_than_f2p", passed: parsed.totalPassed, failed: parsed.totalFailed };
  }
  return { testExitCode: exitCode, timedOut, durationMs, invalidReason: null, passed: parsed.totalPassed, failed: parsed.totalFailed };
}

interface RunOptions {
  runId?: string | undefined;
  split: string;
  repoId?: string | undefined;
  taskId?: string | undefined;
  strategyId?: string | undefined;
  agentId?: string | undefined;
  maxBudgetUsd?: number | undefined;
  timeoutMs?: number | undefined;
  resume: boolean;
  dryRun: boolean;
  manifestsDir?: string | undefined;
}

function parseRunOptions(argv: string[]): RunOptions {
  const options = parseEvalCliOptions(argv, [
    "--dry-run",
    "--run-id",
    "--repo-id",
    "--task-id",
    "--strategy-id",
    "--agent-id",
    "--split",
    "--max-budget-usd",
    "--timeout-ms",
    "--manifests-dir",
    "--resume",
  ]);
  return {
    runId: options.runId,
    split: options.split ?? "generation_pilot",
    repoId: options.repoId,
    taskId: options.taskId,
    strategyId: options.strategyId,
    agentId: options.agentId,
    maxBudgetUsd: options.maxBudgetUsd,
    timeoutMs: options.timeoutMs,
    resume: options.resume === true,
    dryRun: options.dryRun,
    manifestsDir: options.manifestsDir,
  };
}

function generationCellId(
  taskId: string,
  strategyId: string,
  agentId: string,
  modelId: string,
): string {
  return `${taskId}__${strategyId}__${agentId}__${modelId}`;
}

function readExistingGenerationRecords(outputPath: string, runId: string): GenerationRecord[] {
  if (!existsSync(outputPath)) return [];
  return readFileSync(outputPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      const parsed = JSON.parse(line) as Partial<GenerationRecord>;
      if (parsed.schema_version !== GENERATION_RECORD_SCHEMA_VERSION) {
        throw new Error(`generation.jsonl line ${index + 1} has schema_version ${String(parsed.schema_version)}; expected ${GENERATION_RECORD_SCHEMA_VERSION}`);
      }
      if (parsed.run_id !== runId || typeof parsed.model_id !== "string") {
        throw new Error(`generation.jsonl line ${index + 1} does not belong to run ${runId} or has no model_id`);
      }
      return parsed as GenerationRecord;
    });
}

export function parseOpenCodeCost(stdout: string): number | null {
  let total = 0;
  let found = false;
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const event = value as Record<string, unknown>;
    if (event.type !== "step_finish" || typeof event.part !== "object" || event.part === null) continue;
    const cost = (event.part as Record<string, unknown>).cost;
    if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) continue;
    total += cost;
    found = true;
  }
  return found ? total : null;
}

export function hasAgentSkillRetrieveEvidence(stdout: string): boolean {
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch {
      continue;
    }
    if (typeof value !== "object" || value === null) continue;
    const event = value as Record<string, unknown>;
    if (event.type !== "tool_use" || typeof event.part !== "object" || event.part === null) continue;
    const part = event.part as Record<string, unknown>;
    if (part.tool !== "bash" || typeof part.state !== "object" || part.state === null) continue;
    const state = part.state as Record<string, unknown>;
    const input = typeof state.input === "object" && state.input !== null
      ? state.input as Record<string, unknown>
      : {};
    const command = typeof input.command === "string" ? input.command : "";
    const output = typeof state.output === "string" ? state.output : "";
    if (command.includes("lacoco retrieve") && output.includes("\"ok\": true") && output.includes("\"contextBlock\"")) {
      return true;
    }
  }
  return false;
}

export async function runGeneration(argv = process.argv.slice(2)): Promise<void> {
  const options = parseRunOptions(argv);
  const manifestsDir = resolveManifestsDir(options.manifestsDir);
  const manifests = loadManifests(manifestsDir);
  // Comando de test crudo (formato Docker SWE-PolyBench) por repo: el lock no lo
  // persiste, así que lo tomamos del manifiesto de repositorios.
  const repoTestCommandById = new Map(
    manifests.repos.repositories.map((r) => [r.id, r.test_command]),
  );
  const settings = readGenerationSettings(manifests.run, manifests.agents, options.split, options.timeoutMs);
  const layout = resolveEvalLayout(manifests.run, options.runId);
  const tasks = manifests.tasks.tasks.filter((task) =>
    (options.repoId === undefined || task.repo_id === options.repoId) &&
    (options.taskId === undefined || task.id === options.taskId) &&
    (settings.taskIds === undefined || settings.taskIds.has(task.id)) &&
    (settings.repoIds === undefined || settings.repoIds.has(task.repo_id)),
  );
  const strategies = manifests.strategies.strategies.filter(
    (strategy) =>
      strategy.enabled &&
      strategy.generation_enabled &&
      (strategy.lacoco_strategy !== null || strategy.id === "no_context" || isAgentSkillStrategy(strategy)) &&
      settings.strategyIds.has(strategy.id) &&
      (options.strategyId === undefined || strategy.id === options.strategyId),
  );
  const agents = manifests.agents.agents.filter(
    (agent) =>
      agent.enabled &&
      settings.agentIds.has(agent.id) &&
      (options.agentId === undefined || agent.id === options.agentId),
  );

  if (tasks.length === 0) throw new Error(`no tasks matched the combined filters for split ${settings.splitName}`);
  if (strategies.length === 0) throw new Error(`no strategies matched the combined filters for split ${settings.splitName}`);
  if (agents.length === 0) throw new Error(`no agents matched the combined filters for split ${settings.splitName}`);

  console.log(`Run: ${layout.runId}`);
  console.log(`Split: ${settings.splitName}`);
  console.log(`Tasks (${tasks.length}): ${tasks.map((t) => t.id).join(", ")}`);
  console.log(`Strategies (${strategies.length}): ${strategies.map((s) => s.id).join(", ")}`);
  console.log(`Agents (${agents.length}): ${agents.map((a) => a.id).join(", ")}`);
  console.log(`Combinations: ${tasks.length * strategies.length * agents.length}`);
  console.log(`Agent timeout: ${settings.agentTimeoutMs}ms`);
  console.log(`Max diff bytes: ${settings.maxDiffBytes}, max changed files: ${settings.maxChangedFiles}`);
  if (options.maxBudgetUsd !== undefined) {
    console.log(`Max budget: $${options.maxBudgetUsd.toFixed(2)}`);
  }

  if (!settings.enabled) {
    console.log("Generation phase is disabled by run.yaml.");
    return;
  }

  if (!existsSync(layout.lockFile)) {
    throw new Error(`repositories lock does not exist: ${layout.lockFile}; run eval:prepare first`);
  }
  const lock = readRepositoriesLock(layout.lockFile);
  if (lock.runId !== layout.runId) {
    throw new Error(`lock run id ${lock.runId} does not match requested run ${layout.runId}`);
  }
  const lockedById = new Map(lock.repositories.map((r) => [r.id, r]));

  const needsPrecomputedRetrieval = strategies.some((strategy) =>
    strategy.id !== "no_context" && !isAgentSkillStrategy(strategy)
  );
  const retrievalRecords = needsPrecomputedRetrieval ? loadRetrievalJsonl(layout.runDirectory) : [];
  const skipCells = needsPrecomputedRetrieval
    ? validateRetrievalContexts(retrievalRecords, tasks, strategies, settings.sanitizerVariant)
    : new Set<string>();
  if (skipCells.size > 0) {
    const bySortedCell = [...skipCells].sort();
    console.warn(
      `⚠ ${skipCells.size} celda(s) sin registro de retrieval se saltarán (la tarea no se recuperó; ` +
        `continue_on_task_failure): ${bySortedCell.map((c) => c.replace("__", " x ")).join(", ")}`,
    );
  }

  mkdirSync(layout.runDirectory, { recursive: true });
  mkdirSync(layout.generationArtifactsDirectory, { recursive: true });
  const lacocoCli = ensureLaCoCoCliBin(layout.runDirectory);
  const outputPath = join(layout.runDirectory, "generation.jsonl");
  const existingRecords = options.resume
    ? readExistingGenerationRecords(outputPath, layout.runId)
    : [];
  const completedCells = new Set(existingRecords.map((record) => generationCellId(
    record.task_id,
    record.strategy_id,
    record.agent_id,
    record.model_id,
  )));
  if (!options.dryRun && !options.resume) writeFileSync(outputPath, "", "utf8");
  if (!options.dryRun && options.resume && !existsSync(outputPath)) writeFileSync(outputPath, "", "utf8");

  let spentUsd = existingRecords.reduce((total, record) => total + (record.cost_usd ?? 0), 0);
  const failures: string[] = [];
  let stop = false;
  if (options.resume) {
    console.log(`Resume: ${completedCells.size} completed cells, reported spend $${spentUsd.toFixed(6)}`);
  }

  for (const task of tasks) {
    if (stop) break;
    const locked = lockedById.get(task.repo_id);
    if (locked === undefined) {
      failures.push(`${task.id}: repository ${task.repo_id} is missing from ${layout.lockFile}`);
      console.error(failures.at(-1));
      if (!settings.continueOnTaskFailure) break;
      continue;
    }

    for (const strategy of strategies) {
      if (stop) break;
      for (const agent of agents) {
        const model = getAgentModel(agent);
        const agentProfile = getAgentProfile(agent);
        // Id con variante: empareja el registro de retrieval correcto y etiqueta
        // la salida (p. ej. `hybrid@grounded`) para que compare-strategies lo
        // distinga del determinista. `no_context` queda sin sufijo (baseline).
        const recStrategyId = recordStrategyId(strategy.id, settings.sanitizerVariant);
        // Celda sin registro de retrieval (la tarea no se recuperó para esta
        // estrategia) → saltar sin abortar el run. `no_context` no necesita registro.
        if (strategy.id !== "no_context" && !isAgentSkillStrategy(strategy) && skipCells.has(cellKey(task.id, strategy.id))) {
          console.warn(`  skip ${task.id} x ${recStrategyId} x ${agent.id}: sin registro de retrieval`);
          continue;
        }
        const cellId = generationCellId(task.id, recStrategyId, agent.id, model);
        if (completedCells.has(cellId)) {
          console.log(`\n${task.id} x ${recStrategyId} x ${agent.id}: already recorded, skipping`);
          continue;
        }
        if (options.maxBudgetUsd !== undefined && spentUsd >= options.maxBudgetUsd) {
          const message = `Budget reached ($${spentUsd.toFixed(6)} >= $${options.maxBudgetUsd.toFixed(2)}). Stopping before ${cellId}.`;
          console.error(message);
          failures.push(message);
          stop = true;
          break;
        }

        const cellDir = join(layout.generationArtifactsDirectory, task.id, recStrategyId, agent.id);
        const paths = makeEmptyArtifactPaths(cellDir);

        const regressionInfo = (locked.regression_tasks ?? []).find((t) => t.id === task.id);
        if (task.regression !== undefined && regressionInfo === undefined) {
          failures.push(
            `${task.id} x ${strategy.id} x ${agent.id}: regression metadata missing from repos.lock.json; ` +
            `re-run eval:prepare to certify the broken state`,
          );
          console.error(failures.at(-1));
          if (!settings.continueOnTaskFailure) {
            break;
          } else {
            continue;
          }
        }
        if (task.regression !== undefined && regressionInfo !== undefined) {
          if (regressionInfo.base_commit !== task.regression.base_commit) {
            failures.push(
              `${task.id} x ${strategy.id} x ${agent.id}: regression.base_commit ${task.regression.base_commit} ` +
              `does not match lock base_commit ${regressionInfo.base_commit}; refusing to apply broken_patch`,
            );
            console.error(failures.at(-1));
            if (!settings.continueOnTaskFailure) {
              break;
            } else {
              continue;
            }
          }
        }

        try {
          await resetRepoClean({
            repoPath: locked.repoPath,
            timeoutMs: 60_000,
            excludes: locked.reset_excludes ?? [],
          });
        } catch (error) {
          const msg = error instanceof Error ? error.message : String(error);
          failures.push(`${task.id} x ${strategy.id} x ${agent.id}: reset failed: ${msg}`);
          console.error(failures.at(-1));
          await resetRepoClean({
            repoPath: locked.repoPath,
            timeoutMs: 60_000,
            excludes: locked.reset_excludes ?? [],
          }).catch(() => undefined);
          continue;
        }

        if (regressionInfo !== undefined) {
          const brokenPatchPath = isAbsolute(regressionInfo.broken_patch)
            ? regressionInfo.broken_patch
            : join(PROJECT_ROOT, "eval", "manifests", regressionInfo.broken_patch);
          try {
            await applyBrokenPatch({
              repoPath: locked.repoPath,
              brokenPatchPath,
              timeoutMs: 60_000,
            });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            failures.push(`${task.id} x ${strategy.id} x ${agent.id}: broken_patch apply failed: ${msg}`);
            console.error(failures.at(-1));
            await resetRepoClean({
              repoPath: locked.repoPath,
              timeoutMs: 60_000,
              excludes: locked.reset_excludes ?? [],
            }).catch(() => undefined);
            continue;
          }
        }

        if (isAgentSkillStrategy(strategy)) {
          await installLaCoCoSkillForAgent(
            locked.repoPath,
            agent.id,
            join(cellDir, "lacoco-skill-install.log"),
          );
        }

        const retrievalRecord = findRetrievalRecord(retrievalRecords, task.id, recStrategyId);
        const prompt = buildPrompt(task, strategy, retrievalRecord, regressionInfo);
        mkdirSync(cellDir, { recursive: true });
        writeFileSync(paths.prompt, prompt, "utf8");

        if (retrievalRecord !== null) {
          const ctxPath = resolveContextPath(retrievalRecord);
          const dst = join(cellDir, "context.json");
          writeFileSync(dst, readFileSync(ctxPath, "utf8"), "utf8");
          paths.context_json = relative(PROJECT_ROOT, dst);
        }

        const command = buildAgentCommand(agent, locked.repoPath, paths.prompt, model, agentProfile);
        console.log(`\n${task.id} x ${strategy.id} x ${agent.id}`);
        console.log(`  command: ${command.slice(0, 200)}${command.length > 200 ? "..." : ""}`);

        if (options.dryRun) {
          console.log("  (dry-run: skipping agent invocation)");
          continue;
        }

        mkdirSync(dirname(paths.command), { recursive: true });
        writeFileSync(paths.command, command, "utf8");

        const agentStartedAt = performance.now();
        let agentExitCode: number | null = null;
        let agentTimedOut = false;
        let agentStdout = "";
        try {
          const result = await executeCommand({
            command,
            cwd: PROJECT_ROOT,
            timeoutMs: settings.agentTimeoutMs,
            logPath: paths.stdout,
            env: agentEnvironment({
              strategy,
              agent,
              runDirectory: layout.runDirectory,
              lacocoBinDir: lacocoCli.binDir,
              lacocoCliPath: lacocoCli.cliPath,
            }),
          });
          agentExitCode = result.exitCode;
          agentStdout = result.stdout;
          writeFileSync(paths.stdout, result.stdout, "utf8");
          writeFileSync(paths.stderr, result.stderr, "utf8");
        } catch (error) {
          if (error instanceof CommandExecutionError) {
            agentExitCode = error.result.exitCode;
            agentTimedOut = error.result.timedOut;
            agentStdout = error.result.stdout;
            writeFileSync(paths.stdout, error.result.stdout, "utf8");
            writeFileSync(paths.stderr, error.result.stderr, "utf8");
          } else {
            throw error;
          }
        }
        const agentDurationMs = Math.round(performance.now() - agentStartedAt);
        const costUsd = agent.id === "opencode" ? parseOpenCodeCost(agentStdout) : null;
        if (options.maxBudgetUsd !== undefined && costUsd === null) {
          failures.push(`${cellId}: no provider-reported cost was found; budget enforcement cannot continue safely`);
          stop = true;
        }
        if (costUsd !== null) spentUsd += costUsd;

        const diff = await captureWorkingTreeDiff({
          repoPath: locked.repoPath,
          timeoutMs: 60_000,
          excludePatchPaths: GENERATED_LOCKFILE_PATCH_EXCLUDES,
        });
        const patchApplied = diff.length > 0;
        const patchSizeBytes = Buffer.byteLength(diff, "utf8");
        const filesChangedCount = (diff.match(/^diff --git /gm) ?? []).length;
        writeFileSync(paths.patch, diff, "utf8");

        const patchLimitErrors: string[] = [];
        if (patchSizeBytes > settings.maxDiffBytes) {
          patchLimitErrors.push(`patch size ${patchSizeBytes} exceeds ${settings.maxDiffBytes} bytes`);
        }
        if (filesChangedCount > settings.maxChangedFiles) {
          patchLimitErrors.push(`changed files ${filesChangedCount} exceeds ${settings.maxChangedFiles}`);
        }
        let recordError: GenerationRecord["error"] = agentTimedOut
          ? { type: "agent_timeout", message: `agent timed out after ${settings.agentTimeoutMs} ms` }
          : agentExitCode !== 0
            ? { type: "agent_error", message: `agent exited with code ${String(agentExitCode)}` }
            : patchLimitErrors.length > 0
              ? { type: "patch_limit_exceeded", message: patchLimitErrors.join("; ") }
              : null;
        if (recordError === null && isAgentSkillStrategy(strategy) && !hasAgentSkillRetrieveEvidence(agentStdout)) {
          recordError = {
            type: "agent_skill_retrieval_missing",
            message: "agent_skill strategy did not execute lacoco retrieve and read a contextBlock",
          };
        }
        if (stop && costUsd === null) {
          recordError = recordError ?? {
            type: "cost_unavailable",
            message: "provider-reported cost was not available while budget enforcement was enabled",
          };
        }

        let testResult: ParsedTestResult | null = null;
        let swePolyInvalid: string | null = null;
        const shouldRunTests = task.target_tests.length > 0
          && recordError === null
          && (patchApplied || regressionInfo !== undefined);
        // SWE-PolyBench (no-regresión): el gold vive en sidecar `patches/<id>.test.patch`.
        const testPatchPath = manifestsDir === undefined
          ? undefined
          : join(manifestsDir, "patches", `${task.id}.test.patch`);
        const rawTestCommand = repoTestCommandById.get(task.repo_id);
        if (
          shouldRunTests
          && regressionInfo === undefined
          && rawTestCommand !== undefined
          && testPatchPath !== undefined
          && existsSync(testPatchPath)
        ) {
          const synth = synthesizeF2pTestRun(parseTestCommand(rawTestCommand), task.target_tests);
          if (synth.testInvocation === null) {
            swePolyInvalid = synth.reason ?? "unsynthesizable";
            writeFileSync(paths.test_log, `(SWE-PolyBench: test no sintetizable: ${swePolyInvalid})\n`, "utf8");
          } else {
            const outcome = await runSwePolybenchTests(
              locked.repoPath,
              testPatchPath,
              synth.testInvocation,
              task.target_tests.length,
              settings.testTimeoutMs,
              paths.test_log,
            );
            swePolyInvalid = outcome.invalidReason;
            testResult = {
              exitCode: outcome.testExitCode,
              timedOut: outcome.timedOut,
              durationMs: outcome.durationMs,
              logPath: paths.test_log,
              unknownRunner: false,
            };
          }
        } else if (shouldRunTests) {
          const testCommand = task.target_tests.join(" && ");
          testResult = await runTargetTests(testCommand, locked.repoPath, settings.testTimeoutMs, paths.test_log);
        } else if (task.target_tests.length === 0) {
          writeFileSync(paths.test_log, "(no target_tests for this task)\n", "utf8");
        } else {
          const reason = recordError === null ? "no patch applied" : recordError.message;
          writeFileSync(paths.test_log, `(${reason}; skipping tests)\n`, "utf8");
        }

        let baselineFailing: string[] = [];
        let postFailing: string[] = [];
        let gradingPassed: string[] = [];
        let regressionIntroduced: string[] = [];
        if (regressionInfo !== undefined && testResult !== null) {
          baselineFailing = regressionInfo.baseline_failing_tests;
          const logText = readFileSync(paths.test_log, "utf8");
          const parsed = parseTestRunnerOutput(logText, "");
          postFailing = [...parsed.failed];
          const gradingSet = new Set(regressionInfo.grading_tests);
          gradingPassed = regressionInfo.grading_tests.filter((name) => !postFailing.includes(name));
          const baselineSet = new Set(baselineFailing);
          regressionIntroduced = postFailing.filter((name) => !baselineSet.has(name) && !gradingSet.has(name));
        } else if (regressionInfo !== undefined && testResult === null) {
          baselineFailing = regressionInfo.baseline_failing_tests;
        }

        // Si el runner de tests no es parseable, NO contamos el exit=0 como pass
        // silencioso. Forzamos test_exit_code=null y dejamos runner_error para que
        // compute-generation-metrics lo agregue a m1_unknown_runner_count.
        const testRunnerError = (testResult?.unknownRunner === true || swePolyInvalid !== null)
          ? "unknown_runner" as const
          : null;
        const effectiveTestExitCode = testRunnerError !== null ? null : (testResult?.exitCode ?? null);

        const record: GenerationRecord = {
          schema_version: GENERATION_RECORD_SCHEMA_VERSION,
          run_id: layout.runId,
          task_id: task.id,
          repo_id: task.repo_id,
          strategy_id: recStrategyId,
          agent_id: agent.id,
          model_id: model,
          agent_exit_code: agentExitCode,
          agent_duration_ms: agentDurationMs,
          cost_usd: costUsd,
          patch_applied: patchApplied,
          patch_size_bytes: patchSizeBytes,
          files_changed_count: filesChangedCount,
          test_exit_code: effectiveTestExitCode,
          test_duration_ms: testResult?.durationMs ?? 0,
          tests_passed: testResult === null ? null : null,
          tests_failed: testResult === null ? null : null,
          tests_total: testResult === null ? null : null,
          timeout: agentTimedOut,
          baseline_failing_tests: baselineFailing,
          post_failing_tests: postFailing,
          grading_tests_passed: gradingPassed,
          regression_introduced_failures: regressionIntroduced,
          artifact_paths: paths,
          error: recordError,
          runner_error: testRunnerError,
        };

        appendFileSync(outputPath, `${JSON.stringify(record)}\n`, "utf8");
        console.log(
          `  exit=${String(agentExitCode)} patch=${patchApplied}(${patchSizeBytes}B,${filesChangedCount}f) ` +
            `test=${String(testResult?.exitCode ?? "-")} dur=${agentDurationMs}ms cost=${costUsd === null ? "unknown" : `$${costUsd.toFixed(6)}`}` +
            (regressionInfo ? ` reg=${postFailing.length === 0 ? "pass" : `${postFailing.length}f`}` : ""),
        );

        // Reset to a clean green state so the next cell starts fresh.
        await resetRepoClean({
          repoPath: locked.repoPath,
          timeoutMs: 60_000,
          excludes: locked.reset_excludes ?? [],
        }).catch(() => undefined);

        completedCells.add(cellId);
        if (stop) break;
      }
    }
  }

  if (options.dryRun) {
    console.log("\nDry run: no agent invocations, no diffs, no test runs.");
  }
  if (failures.length > 0) {
    console.error(`\nFailures:\n${failures.join("\n")}`);
    process.exitCode = 1;
  }
  console.log(`\nTotal provider-reported spend: $${spentUsd.toFixed(6)}`);
}

if (isEntrypoint(import.meta.url)) {
  runGeneration().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
