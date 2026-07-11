import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CommandExecutionError, executeCommand, shellQuote, type CommandResult } from "./exec.js";

export interface GitRepositoryOptions {
  url: string;
  ref: string;
  repoPath: string;
  logsDirectory: string;
  timeoutMs: number;
  fetchTags: boolean;
  cleanCommand?: string;
}

export interface ResetRepoOptions {
  repoPath: string;
  timeoutMs?: number;
  excludes?: string[];
}

export interface CaptureWorkingTreeDiffOptions extends ResetRepoOptions {
  excludePatchPaths?: string[];
}

async function gitStep(
  options: GitRepositoryOptions,
  name: string,
  command: string,
  cwd: string,
): Promise<CommandResult> {
  return executeCommand({
    command,
    cwd,
    timeoutMs: options.timeoutMs,
    logPath: join(options.logsDirectory, `${name}.log`),
  });
}

export async function prepareGitRepository(options: GitRepositoryOptions): Promise<string> {
  if (!existsSync(options.repoPath)) {
    await gitStep(
      options,
      "clone",
      `git clone ${shellQuote(options.url)} ${shellQuote(options.repoPath)}`,
      join(options.repoPath, ".."),
    );
  } else if (!existsSync(join(options.repoPath, ".git"))) {
    throw new Error(`repository path exists but is not a Git checkout: ${options.repoPath}`);
  } else {
    const tags = options.fetchTags ? " --tags" : "";
    await gitStep(options, "fetch", `git fetch${tags} --force origin`, options.repoPath);
  }

  await gitStep(
    options,
    "checkout",
    `git checkout --detach ${shellQuote(options.ref)}`,
    options.repoPath,
  );

  if (options.cleanCommand !== undefined) {
    await gitStep(options, "clean", options.cleanCommand, options.repoPath);
  }

  const result = await gitStep(options, "resolve-commit", "git rev-parse HEAD", options.repoPath);
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(`git rev-parse returned an invalid commit for ${options.repoPath}`);
  }
  return commit;
}

/**
 * Resetea el repositorio a HEAD limpio: descarta cambios sin commit y
 * elimina archivos no rastreados. Usado entre celdas de generacion para
 * garantizar que cada agent corre contra un worktree deterministico.
 *
 * Acepta `excludes` (lista de paths) que se pasan a `git clean -fdx -e`
 * para preservar contenido no rastreado (tipicamente `node_modules`).
 * Si el caller quiere reinstalar deps tras el reset, debe hacerlo
 * explicitamente; por defecto, los excludes deben cubrir todo lo que
 * el test runner necesita para ejecutarse sin reinstalacion manual.
 *
 * Lanza excepcion si la operacion falla. No verifica nada despues del
 * reset; el caller puede usar `git status --porcelain` para confirmar
 * si necesita esa garantia adicional.
 */
export async function resetRepoClean(options: ResetRepoOptions): Promise<void> {
  if (!existsSync(join(options.repoPath, ".git"))) {
    throw new Error(`resetRepoClean: ${options.repoPath} is not a Git checkout`);
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  const logPath = join(options.repoPath, ".git", "lacoco-reset.log");
  await executeCommand({
    command: "git reset --hard HEAD",
    cwd: options.repoPath,
    timeoutMs,
    logPath,
  });
  const excludes = options.excludes ?? [];
  const cleanCommand = excludes.length === 0
    ? "git clean -fdx"
    : `git clean -fdx ${excludes.map((p) => `-e ${p}`).join(" ")}`;
  await executeCommand({
    command: cleanCommand,
    cwd: options.repoPath,
    timeoutMs,
    logPath,
  });
}

/**
 * Captura el diff actual del worktree como un patch unificado.
 * Devuelve string vacio si no hay cambios. Usado para extraer el
 * `patch.diff` que produce el agente.
 */
export async function captureWorkingTreeDiff(options: CaptureWorkingTreeDiffOptions): Promise<string> {
  if (!existsSync(join(options.repoPath, ".git"))) {
    throw new Error(`captureWorkingTreeDiff: ${options.repoPath} is not a Git checkout`);
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  const logPath = join(options.repoPath, ".git", "lacoco-diff.log");
  const excludePatchPaths = options.excludePatchPaths ?? [];
  const unstageExcluded = excludePatchPaths.length === 0
    ? ""
    : ` && git reset --quiet -- ${excludePatchPaths.map(shellQuote).join(" ")}`;
  const result = await executeCommand({
    command: `git add -A${unstageExcluded} && git diff --cached --binary`,
    cwd: options.repoPath,
    timeoutMs,
    logPath,
  });
  return result.stdout;
}

export interface ApplyBrokenPatchOptions {
  repoPath: string;
  brokenPatchPath: string;
  timeoutMs?: number;
}

export class BrokenPatchApplyError extends Error {
  public readonly cause?: unknown;
  public readonly stdout: string;
  public readonly stderr: string;
  public readonly exitCode: number | null;
  constructor(message: string, params: { stdout: string; stderr: string; exitCode: number | null; cause?: unknown }) {
    super(message);
    this.stdout = params.stdout;
    this.stderr = params.stderr;
    this.exitCode = params.exitCode;
    this.cause = params.cause;
  }
}

/**
 * Aplica un diff (unified format) sobre el worktree. Primero valida con
 * `git apply --check` para detectar errores tempranamente; si pasa,
 * aplica con `git apply --whitespace=nowarn`. Lanza BrokenPatchApplyError
 * con stdout/stderr/exit_code si falla. El caller es responsable de
 * verificar que el SHA-1 del repo (HEAD) coincide con el base_commit
 * esperado antes de llamar.
 */
export async function applyBrokenPatch(options: ApplyBrokenPatchOptions): Promise<void> {
  if (!existsSync(join(options.repoPath, ".git"))) {
    throw new Error(`applyBrokenPatch: ${options.repoPath} is not a Git checkout`);
  }
  if (!existsSync(options.brokenPatchPath)) {
    throw new Error(`applyBrokenPatch: broken patch not found at ${options.brokenPatchPath}`);
  }
  const timeoutMs = options.timeoutMs ?? 60_000;
  const logPath = join(options.repoPath, ".git", "lacoco-broken-apply.log");

  const checkResult = await runTestCommandOrCapture(
    `git apply --check ${shellQuote(options.brokenPatchPath)}`,
    options.repoPath,
    timeoutMs,
    logPath,
  );
  if (checkResult.exitCode !== 0) {
    throw new BrokenPatchApplyError(
      `git apply --check failed for ${options.brokenPatchPath} on ${options.repoPath}: ${checkResult.stderr || checkResult.stdout}`,
      {
        stdout: checkResult.stdout,
        stderr: checkResult.stderr,
        exitCode: checkResult.exitCode,
      },
    );
  }

  const applyResult = await runTestCommandOrCapture(
    `git apply --whitespace=nowarn ${shellQuote(options.brokenPatchPath)}`,
    options.repoPath,
    timeoutMs,
    logPath,
  );
  if (applyResult.exitCode !== 0) {
    throw new BrokenPatchApplyError(
      `git apply failed for ${options.brokenPatchPath} on ${options.repoPath}: ${applyResult.stderr || applyResult.stdout}`,
      {
        stdout: applyResult.stdout,
        stderr: applyResult.stderr,
        exitCode: applyResult.exitCode,
      },
    );
  }
}

async function runTestCommandOrCapture(
  command: string,
  cwd: string,
  timeoutMs: number,
  logPath: string,
): Promise<CommandResult> {
  try {
    return await executeCommand({ command, cwd, timeoutMs, logPath });
  } catch (err) {
    if (err instanceof CommandExecutionError) {
      return err.result;
    }
    throw err;
  }
}

export interface TestResult {
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

/**
 * Ejecuta un comando de test y devuelve su resultado. No parsea el output;
 * `parseTestRunnerOutput` se encarga de eso. El caller decide si exit_code
 * no-cero es esperado o no (modo regresion: se espera no-cero al inicio).
 */
export async function runTestCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  logPath: string,
): Promise<TestResult> {
  const start = Date.now();
  try {
    const result = await executeCommand({
      command,
      cwd,
      timeoutMs,
      logPath,
    });
    return {
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: Date.now() - start,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (err) {
    if (err && typeof err === "object" && "result" in err) {
      const result = (err as { result: CommandResult }).result;
      return {
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        durationMs: Date.now() - start,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    }
    throw err;
  }
}

/**
 * Parsea el stdout+stderr de un comando de test y devuelve el conjunto
 * de nombres de tests que fallaron. Soporta los runners mas comunes
 * del harness: vitest, jest, mocha. Para runners no reconocidos
 * devuelve el set vacio y registra el comando en `unknownRunner`
 * (el caller decide si falla o continua).
 */
export interface ParsedTestResult {
  failed: Set<string>;
  passed: Set<string>;
  totalFailed: number;
  totalPassed: number;
  unknownRunner: boolean;
}

export function parseTestRunnerOutput(stdout: string, stderr: string): ParsedTestResult {
  const combined = `${stdout}\n${stderr}`;
  // vitest: 'Tests  N failed | M passed (T total)' or 'Test Files  1 failed | 2 passed'
  // Heuristic: vitest uses spaces around "Tests" (no colon). Jest uses colon.
  if (
    /(^|\s)vitest\b/i.test(combined) ||
    /Test Files\s+\d+\s+(failed|passed)/.test(combined) ||
    /Tests\s+\d+\s+failed(?:\s*\|\s*\d+\s+passed)?\s*\(\d+\s+total\)/.test(combined)
  ) {
    return parseVitest(combined);
  }
  // jest: 'Tests:  N failed, M passed, T total' (with colon)
  if (
    /(^|\s)jest\b/i.test(combined) ||
    /Tests:\s+\d+\s+failed/.test(combined) ||
    /Tests:\s+\d+\s+passed/.test(combined) ||
    /●\s+\S/.test(combined)
  ) {
    return parseJest(combined);
  }
  // mocha: 'N passing', 'M failing', or '  1) suite > test:'
  if (
    /(^|\s)mocha\b/i.test(combined) ||
    /\bpassing\b|\bfailing\b/.test(combined) ||
    /^\s*\d+\)\s+\S.+$/m.test(combined)
  ) {
    return parseMocha(combined);
  }
  // Last-resort: if per-test marks (×, ✗, ✕) appear, treat as vitest/jest accordingly.
  if (/[✕]/.test(stdout)) {
    return parseJest(combined);
  }
  if (/[×✗]/.test(stdout)) {
    return parseVitest(combined);
  }
  return {
    failed: new Set(),
    passed: new Set(),
    totalFailed: 0,
    totalPassed: 0,
    unknownRunner: true,
  };
}

function parseVitest(combined: string): ParsedTestResult {
  const failed = new Set<string>();
  const passed = new Set<string>();
  // Per-test results. vitest uses × (U+00D7) for fail and ✓ (U+2713) for pass.
  // We also accept ✗ (U+2717) and ✕ (U+2715) for jest compat.
  const failLine = /^[ \t]*[×✗✕][ \t]+(.+?)(?:[ \t]+\d+(?:\.\d+)?m?s)?\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = failLine.exec(combined)) !== null) {
    failed.add(m[1]!.trim());
  }
  const passLine = /^[ \t]*✓[ \t]+(.+?)(?:[ \t]+\d+(?:\.\d+)?m?s)?\s*$/gm;
  while ((m = passLine.exec(combined)) !== null) {
    passed.add(m[1]!.trim());
  }
  // Summary: 'Tests  N failed | M passed (T total)' or 'Tests  N passed (T total)'
  const summary = /Tests[ \t]+(\d+)[ \t]+failed(?:\s*\|\s*(\d+)[ \t]+passed)?[ \t]*\((\d+)[ \t]+total\)/.exec(combined);
  let totalFailed = 0;
  let totalPassed = 0;
  if (summary) {
    totalFailed = Number(summary[1]);
    totalPassed = Number(summary[2] ?? (Number(summary[3]) - totalFailed));
  }
  return { failed, passed, totalFailed, totalPassed, unknownRunner: false };
}

function parseJest(combined: string): ParsedTestResult {
  const failed = new Set<string>();
  const passed = new Set<string>();
  // jest bullet: '● test name' (U+25CF). Also accept ✕ (U+2715) and × (U+00D7) for variants.
  const failLine = /^[ \t]*[●✕×]\s+(.+?)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = failLine.exec(combined)) !== null) {
    failed.add(m[1]!.trim());
  }
  const passLine = /^[ \t]*✓\s+(.+?)\s*$/gm;
  while ((m = passLine.exec(combined)) !== null) {
    passed.add(m[1]!.trim());
  }
  // Summary: 'Tests:   N failed, M passed, T total' (also accept 'Tests:  N passed, T total')
  const summary = /Tests:\s+(?:(\d+)\s+failed,\s+)?(\d+)\s+passed,\s+(\d+)\s+total/.exec(combined);
  let totalFailed = 0;
  let totalPassed = 0;
  if (summary) {
    totalFailed = Number(summary[1] ?? 0);
    totalPassed = Number(summary[2] ?? 0);
  }
  return { failed, passed, totalFailed, totalPassed, unknownRunner: false };
}

function parseMocha(combined: string): ParsedTestResult {
  const failed = new Set<string>();
  const passed = new Set<string>();
  // mocha failure list spans two lines:
  //   17) mergeMap
  //        should properly handle errors from iterables that are processed after some async:
  // We capture the suite name on the first line and append any continuation lines.
  const lines = combined.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const m = /^[ \t]*\d+\)\s+(.+)$/.exec(lines[i]!);
    if (m === null) continue;
    const parts: string[] = [m[1]!.trim()];
    // Consume continuation lines (deeper indent, no list number, ends with ':')
    for (let j = i + 1; j < lines.length; j++) {
      const cont = /^[ \t]+\S/.exec(lines[j]!);
      if (cont === null) break;
      parts.push(lines[j]!.trim().replace(/:$/, ""));
      if (lines[j]!.trim().endsWith(":")) break;
    }
    failed.add(parts.join(" › "));
  }
  const passing = /(\d+)\s+passing\b/.exec(combined);
  const failing = /(\d+)\s+failing\b/.exec(combined);
  return {
    failed,
    passed,
    totalFailed: failing ? Number(failing[1]) : 0,
    totalPassed: passing ? Number(passing[1]) : 0,
    unknownRunner: false,
  };
}

export interface VerifyBrokenStateOptions {
  repoPath: string;
  testCommand: string;
  timeoutMs: number;
  expectedGradingTests: string[];
  logPath: string;
}

export interface BrokenStateReport {
  exitCode: number | null;
  parsed: ParsedTestResult;
  /** Tests que estaban en expectedGradingTests y aparecen en el set de fallados. */
  gradingTestsFailing: string[];
  /** Tests que estaban en expectedGradingTests y NO aparecen en el set de fallados. */
  gradingTestsMissing: string[];
}

/**
 * Ejecuta el comando de test contra un worktree en broken_state y valida
 * que al menos uno de los grading_tests falle. Devuelve un reporte con
 * los grading_tests que fallaron y los que no aparecen (considerados
 * ausentes del output). El caller decide si la combinacion es valida.
 *
 * Si `expectedGradingTests` esta vacio, cualquier test que falle cuenta
 * (modo "capturar todo" para rxjs-001, donde enumerar 17 nombres
 * manualmente es ruidoso). El set devuelto en `parsed.failed` se persiste
 * en la lock como `baseline_failing_tests`.
 */
export async function verifyBrokenState(options: VerifyBrokenStateOptions): Promise<BrokenStateReport> {
  const result = await runTestCommand(options.testCommand, options.repoPath, options.timeoutMs, options.logPath);
  const parsed = parseTestRunnerOutput(result.stdout, result.stderr);
  const failing = parsed.failed;
  const grading = options.expectedGradingTests;
  let gradingTestsFailing: string[];
  let gradingTestsMissing: string[];
  if (grading.length === 0) {
    gradingTestsFailing = [...failing];
    gradingTestsMissing = [];
  } else {
    gradingTestsFailing = grading.filter((name) => failing.has(name));
    gradingTestsMissing = grading.filter((name) => !failing.has(name));
  }
  return {
    exitCode: result.exitCode,
    parsed,
    gradingTestsFailing,
    gradingTestsMissing,
  };
}

/**
 * Lee un archivo de log y devuelve su contenido. Usado para que el runner
 * pueda re-leer el test_log persistido y parsear el failing set.
 */
export function readLogFile(path: string): string {
  if (!existsSync(path)) return "";
  return readFileSync(path, "utf8");
}
