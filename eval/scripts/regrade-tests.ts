/**
 * regrade-tests.ts
 *
 * Re-grade de tests sobre patches YA generados, SIN re-ejecutar el agente LLM.
 * Para cada celda válida (error===null, patch_applied) de `generation.jsonl`:
 *   1. resetRepoClean (preservando node_modules) + checkout al commit base
 *   2. instala deps si faltan (node_modules) — bajo el Node que pide el test_command
 *   3. git apply <patch.diff guardado>  (repone el fix del agente en src/)
 *   4. re-corre los tests focalizados reusando runSwePolybenchTests, alineando el
 *      Node destino (14/18) para sortear el bug de --no-experimental-global-navigator
 *      en NODE_OPTIONS bajo Node ≥21.
 *   5. actualiza test_exit_code / invalid_reason / runner_error del registro.
 * Reescribe generation.jsonl in-place (backup + temp+rename). Dry-run por defecto.
 *
 * Uso:
 *   npm run eval:regrade -- --run-id <id> --manifests-dir <dir> --repo-id material-ui [--task-id X] \
 *     [--install-cmd "yarn install"] [--timeout-ms 600000] [--write]
 *
 * IMPORTANTE: NO correr en paralelo con la generación (comparten working-trees).
 * Correr bajo Node 20 (`legacyNodeFlags(20)` no añade el flag navigator inválido).
 */

import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isEntrypoint } from "./lib/cli.js";
import { CommandExecutionError, executeCommand, shellQuote } from "./lib/exec.js";
import { resetRepoClean } from "./lib/git.js";
import { loadManifests } from "./lib/load-manifests.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { resolveManifestsDir } from "./lib/paths.js";
import { readRepositoriesLock } from "./lib/repo-lock.js";
import {
  detectBespokeRunner,
  jestNeedsEsm,
  parseTestCommand,
  resolveConcreteRunner,
  synthesizeF2pTestRun,
  synthesizeFileScopedTestRun,
} from "./lib/swe-polybench-test-command.js";
import type { GenerationRecord } from "./lib/generation-record.js";
import {
  resolveDelegatedScriptBody,
  resolveMochaOptsPath,
  runSwePolybenchTests,
} from "./run-generation.js";

const FNM_VERSIONS_DIR = join(homedir(), ".local/share/fnm/node-versions");

/** Resuelve el bin dir de fnm para la versión pedida (exacta o del mismo major). */
function resolveNodeBinDir(version: string | null): { binDir: string; major: number } | null {
  if (version === null) return null;
  const major = Number(version.split(".")[0]);
  const exact = join(FNM_VERSIONS_DIR, `v${version}`, "installation", "bin");
  if (existsSync(join(exact, "node"))) return { binDir: exact, major };
  try {
    for (const d of readdirSync(FNM_VERSIONS_DIR)) {
      if (d.startsWith(`v${major}.`)) {
        const bin = join(FNM_VERSIONS_DIR, d, "installation", "bin");
        if (existsSync(join(bin, "node"))) return { binDir: bin, major };
      }
    }
  } catch {
    // sin fnm → null
  }
  return null;
}

interface RegradeArgs {
  runId: string | undefined;
  manifestsDir: string | undefined;
  repoId: string | undefined;
  taskId: string | undefined;
  strategyId: string | undefined;
  agentId: string | undefined;
  installCmd: string | undefined;
  timeoutMs: number;
  installTimeoutMs: number;
  write: boolean;
  all: boolean;
}

function parseArgs(argv: string[]): RegradeArgs {
  const val = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  const has = (name: string): boolean => argv.includes(`--${name}`);
  return {
    runId: val("run-id"),
    manifestsDir: val("manifests-dir"),
    repoId: val("repo-id"),
    taskId: val("task-id"),
    strategyId: val("strategy-id"),
    agentId: val("agent-id"),
    installCmd: val("install-cmd"),
    timeoutMs: val("timeout-ms") !== undefined ? Number(val("timeout-ms")) : 600_000,
    installTimeoutMs: val("install-timeout-ms") !== undefined ? Number(val("install-timeout-ms")) : 900_000,
    write: has("write"),
    all: has("all"),
  };
}

function envFor(nodeOverride: { binDir: string; major: number } | undefined): NodeJS.ProcessEnv {
  if (nodeOverride === undefined) return {};
  return { PATH: `${nodeOverride.binDir}:${process.env.PATH ?? ""}` };
}

export async function runRegrade(argv = process.argv.slice(2)): Promise<void> {
  const opts = parseArgs(argv);
  const manifestsDir = resolveManifestsDir(opts.manifestsDir);
  if (manifestsDir === undefined) throw new Error("no se pudo resolver manifests-dir (pasa --manifests-dir)");
  const manifests = loadManifests(manifestsDir);
  const layout = resolveEvalLayout(manifests.run, opts.runId);
  const outputPath = join(layout.runDirectory, "generation.jsonl");
  if (!existsSync(outputPath)) throw new Error(`no existe generation.jsonl en ${outputPath}`);
  if (!existsSync(layout.lockFile)) throw new Error(`no existe el lock ${layout.lockFile}`);

  const lock = readRepositoriesLock(layout.lockFile);
  const lockedById = new Map(lock.repositories.map((r) => [r.id, r]));
  const taskById = new Map(manifests.tasks.tasks.map((t) => [t.id, t]));
  const installCmdByRepo = new Map(manifests.repos.repositories.map((r) => [r.id, r.install_command]));
  const testCmdByRepo = new Map(manifests.repos.repositories.map((r) => [r.id, r.test_command]));

  const lines = readFileSync(outputPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const records: GenerationRecord[] = lines.map((l) => JSON.parse(l) as GenerationRecord);

  const targets = records.filter((rec) =>
    rec.error === null &&
    rec.patch_applied === true &&
    (opts.all || rec.invalid_reason != null || rec.test_exit_code == null) &&
    (opts.repoId === undefined || rec.repo_id.startsWith(opts.repoId)) &&
    (opts.taskId === undefined || rec.task_id === opts.taskId) &&
    (opts.strategyId === undefined || rec.strategy_id.startsWith(opts.strategyId)) &&
    (opts.agentId === undefined || rec.agent_id === opts.agentId),
  );

  console.log(`Run: ${layout.runId} | celdas a re-gradear: ${targets.length} | write=${opts.write}`);

  const installedRepos = new Set<string>();
  let changed = 0;
  let recovered = 0;
  let idx = 0;

  for (const rec of targets) {
    idx += 1;
    const task = taskById.get(rec.task_id);
    const locked = lockedById.get(rec.repo_id);
    const rawTestCommand = testCmdByRepo.get(rec.repo_id);
    const tag = `[${idx}/${targets.length}] ${rec.task_id} ${rec.strategy_id} ${rec.agent_id} ${rec.model_id}`;
    if (task === undefined || locked === undefined || rawTestCommand === undefined) {
      console.log(`  ${tag}: falta task/lock/test_command → skip`);
      continue;
    }
    if (task.target_tests.length === 0) {
      console.log(`  ${tag}: sin target_tests → skip`);
      continue;
    }
    const testPatchPath = join(manifestsDir, "patches", `${rec.task_id}.test.patch`);
    if (!existsSync(testPatchPath)) {
      console.log(`  ${tag}: sin test_patch → skip`);
      continue;
    }
    const patchPath = isAbsolute(rec.artifact_paths.patch)
      ? rec.artifact_paths.patch
      : join(layout.runDirectory, rec.artifact_paths.patch);
    if (!existsSync(patchPath)) {
      console.log(`  ${tag}: sin patch.diff guardado → skip`);
      continue;
    }
    const logPath = isAbsolute(rec.artifact_paths.test_log)
      ? rec.artifact_paths.test_log
      : join(layout.runDirectory, rec.artifact_paths.test_log);

    const parsedCmd = parseTestCommand(rawTestCommand);
    const nodeOverride = resolveNodeBinDir(parsedCmd.nodeVersion) ?? undefined;
    const repoPath = locked.repoPath;
    // Preservar node_modules (y lo que el lock excluya) en cada reset → instalar 1 vez/repo.
    const excludes = ["node_modules", ...(locked.reset_excludes ?? [])];

    // 1. Repo limpio en la base.
    await resetRepoClean({ repoPath, excludes, timeoutMs: 120_000 });
    await executeCommand({
      command: `git checkout -q ${shellQuote(locked.commit)} --`,
      cwd: repoPath,
      timeoutMs: 60_000,
      logPath,
    }).catch(() => undefined);

    // 2. Instalar deps si faltan (1 vez por repo).
    if (!installedRepos.has(rec.repo_id)) {
      installedRepos.add(rec.repo_id);
      if (!existsSync(join(repoPath, "node_modules"))) {
        const installCmd = opts.installCmd ?? installCmdByRepo.get(rec.repo_id) ?? "npm install";
        console.log(`  ${tag}: instalando deps (${installCmd}) …`);
        try {
          await executeCommand({
            command: installCmd,
            cwd: repoPath,
            timeoutMs: opts.installTimeoutMs,
            logPath: join(repoPath, ".git", "lacoco-regrade-install.log"),
            env: envFor(nodeOverride),
          });
        } catch (error) {
          const msg = error instanceof CommandExecutionError ? error.result.stderr.slice(0, 300) : String(error);
          console.log(`  ${tag}: ⚠ install FALLÓ (${msg.replace(/\n/g, " ")}) — la celda saldrá inválida`);
        }
      }
    }

    // 3. Reponer el fix del agente.
    let applyOk = true;
    try {
      await executeCommand({ command: `git apply ${shellQuote(patchPath)}`, cwd: repoPath, timeoutMs: 60_000, logPath });
    } catch {
      applyOk = false;
    }

    // 4. Re-gradear.
    let newExit: number | null = null;
    let newInvalid: string | null = null;
    let newDuration = 0;
    if (!applyOk) {
      newInvalid = "agent_patch_reapply_failed";
    } else {
      const scriptBody = resolveDelegatedScriptBody(repoPath, parsedCmd.scriptName);
      const concreteRunner = resolveConcreteRunner(parsedCmd, scriptBody);
      const isMswe = task.tags?.includes("multi-swe-bench") === true;
      const bespokeReason = isMswe ? detectBespokeRunner(scriptBody) : null;
      const synth = bespokeReason !== null
        ? { testInvocation: null as string | null, grepPattern: null, expectedFixtures: [] as string[], reason: bespokeReason }
        : isMswe
          ? synthesizeFileScopedTestRun(concreteRunner, task.target_tests, {
              mochaOpts: resolveMochaOptsPath(repoPath),
              esm: jestNeedsEsm(scriptBody),
            })
          : synthesizeF2pTestRun(parsedCmd, task.target_tests, { concreteRunner, mochaOpts: resolveMochaOptsPath(repoPath) });
      const expectedTestCount = isMswe ? 1 : task.target_tests.length;
      if (synth.testInvocation === null) {
        newInvalid = synth.reason ?? "unsynthesizable";
      } else {
        const outcome = await runSwePolybenchTests(
          repoPath,
          testPatchPath,
          synth.testInvocation,
          expectedTestCount,
          opts.timeoutMs,
          logPath,
          nodeOverride,
        );
        newExit = outcome.testExitCode;
        newInvalid = outcome.invalidReason;
        newDuration = outcome.durationMs;
      }
    }

    // 5. Reset final (preservando node_modules para la próxima celda del mismo repo).
    await resetRepoClean({ repoPath, excludes, timeoutMs: 120_000 });

    // Mapeo idéntico a run-generation: runner_error fuerza exit=null.
    const runnerError = newInvalid !== null ? ("unknown_runner" as const) : null;
    const effectiveExit = runnerError !== null ? null : newExit;

    const beforeExit = rec.test_exit_code;
    const beforeInv = rec.invalid_reason ?? null;
    rec.test_exit_code = effectiveExit;
    rec.test_duration_ms = newDuration;
    rec.runner_error = runnerError;
    rec.invalid_reason = newInvalid;

    const nowGraded = effectiveExit !== null;
    if (nowGraded && beforeExit == null) recovered += 1;
    if (beforeExit !== effectiveExit || beforeInv !== newInvalid) changed += 1;
    const node = nodeOverride !== undefined ? `node${nodeOverride.major}` : "node-ambiente";
    console.log(
      `  ${tag}: ${beforeInv ?? "ok"}(exit=${String(beforeExit)}) → ${newInvalid ?? "ok"}(exit=${String(effectiveExit)}) ` +
        `[${node}]${nowGraded && beforeExit == null ? " ✅ recuperada" : ""}`,
    );
  }

  console.log(`\n${changed} celdas cambiadas · ${recovered} recuperadas (null→medida) · de ${targets.length}`);

  if (opts.write) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backup = `${outputPath}.bak-regrade-${stamp}`;
    writeFileSync(backup, readFileSync(outputPath));
    const tmp = `${outputPath}.regrade.tmp`;
    writeFileSync(tmp, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf8");
    renameSync(tmp, outputPath);
    console.log(`✅ Escrito ${outputPath} (backup: ${backup}). Recomputa: npm run eval:metrics:generation`);
  } else {
    console.log("DRY-RUN (sin escribir). Añade --write para persistir.");
  }
}

if (isEntrypoint(import.meta.url)) {
  runRegrade().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
