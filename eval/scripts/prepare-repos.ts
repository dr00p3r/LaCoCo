import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { parseEvalCliOptions, isEntrypoint } from "./lib/cli.js";
import { asBoolean, asNumber, asRecord, asStringRecord, optionalString } from "./lib/config.js";
import { CommandExecutionError, executeCommand } from "./lib/exec.js";
import { applyBrokenPatch, resetRepoClean, verifyBrokenState } from "./lib/git.js";
import { prepareGitRepository, prepareMirror, slugForUrl } from "./lib/git.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { loadManifests } from "./lib/load-manifests.js";
import {
  createRepositoriesLock,
  readRepositoriesLock,
  upsertLockedRepository,
  writeRepositoriesLock,
  type LockedRepository,
  type LockedRegressionTask,
} from "./lib/repo-lock.js";
import type { RepositoryDefinition, TaskDefinition } from "./lib/types.js";
import { PROJECT_ROOT, resolveManifestsDir } from "./lib/paths.js";

interface PrepareSettings {
  enabled: boolean;
  installDependencies: boolean;
  runBaselineTests: boolean;
  failOnBaselineTestFailure: boolean;
  writeLockFile: boolean;
  fetchTags: boolean;
  cleanCommand?: string;
  installTimeoutMs: number;
  buildTimeoutMs: number;
  buildOptional: boolean;
  testTimeoutMs: number;
  environment: Record<string, string>;
  continueOnRepoFailure: boolean;
  verifyRegression: boolean;
}

function readSettings(reposManifest: Record<string, unknown>, runManifest: Record<string, unknown>): PrepareSettings {
  const defaults = asRecord(reposManifest.defaults, "repos.yaml.defaults");
  const clone = asRecord(defaults.clone, "repos.yaml.defaults.clone");
  const runtime = asRecord(defaults.runtime, "repos.yaml.defaults.runtime");
  const install = asRecord(defaults.install, "repos.yaml.defaults.install");
  const build = asRecord(defaults.build, "repos.yaml.defaults.build");
  const test = asRecord(defaults.test, "repos.yaml.defaults.test");
  const phases = asRecord(runManifest.phases, "run.yaml.phases");
  const prepare = asRecord(phases.prepare_repos, "run.yaml.phases.prepare_repos");
  const failure = asRecord(runManifest.failure_policy, "run.yaml.failure_policy");
  const cleanCommand = optionalString(clone.clean_command, "repos.yaml.defaults.clone.clean_command");

  return {
    enabled: asBoolean(prepare.enabled, "run.yaml.phases.prepare_repos.enabled"),
    installDependencies: asBoolean(
      prepare.install_dependencies,
      "run.yaml.phases.prepare_repos.install_dependencies",
    ),
    runBaselineTests: asBoolean(
      prepare.run_baseline_tests,
      "run.yaml.phases.prepare_repos.run_baseline_tests",
    ),
    failOnBaselineTestFailure: asBoolean(
      prepare.fail_on_baseline_test_failure,
      "run.yaml.phases.prepare_repos.fail_on_baseline_test_failure",
    ),
    writeLockFile: asBoolean(prepare.write_lock_file, "run.yaml.phases.prepare_repos.write_lock_file"),
    fetchTags: asBoolean(clone.fetch_tags, "repos.yaml.defaults.clone.fetch_tags"),
    ...(cleanCommand === undefined ? {} : { cleanCommand }),
    installTimeoutMs: asNumber(install.timeout_ms, "repos.yaml.defaults.install.timeout_ms"),
    buildTimeoutMs: asNumber(build.timeout_ms, "repos.yaml.defaults.build.timeout_ms"),
    buildOptional: asBoolean(build.optional, "repos.yaml.defaults.build.optional"),
    testTimeoutMs: asNumber(test.timeout_ms, "repos.yaml.defaults.test.timeout_ms"),
    environment: asStringRecord(runtime.env, "repos.yaml.defaults.runtime.env"),
    continueOnRepoFailure: asBoolean(
      failure.continue_on_repo_prepare_failure,
      "run.yaml.failure_policy.continue_on_repo_prepare_failure",
    ),
    verifyRegression: asBoolean(
      prepare.verify_regression,
      "run.yaml.phases.prepare_repos.verify_regression",
    ),
  };
}

function describeCommand(repoId: string, step: string, cwd: string, command: string, logPath: string): void {
  console.log(`  [${repoId}] ${step}`);
  console.log(`    cwd: ${cwd}`);
  console.log(`    command: ${command}`);
  console.log(`    log: ${logPath}`);
}

function writeRepoError(logsDirectory: string, error: unknown): void {
  mkdirSync(logsDirectory, { recursive: true });
  const details = error instanceof CommandExecutionError
    ? { message: error.message, ...error.result }
    : { message: error instanceof Error ? error.message : String(error) };
  writeFileSync(join(logsDirectory, "error.json"), `${JSON.stringify(details, null, 2)}\n`, "utf8");
}

async function runStep(
  repository: RepositoryDefinition,
  step: string,
  command: string,
  timeoutMs: number,
  repoPath: string,
  logsDirectory: string,
  environment: Record<string, string>,
  dryRun: boolean,
): Promise<void> {
  const logPath = join(logsDirectory, `${step}.log`);
  describeCommand(repository.id, step, repoPath, command, logPath);
  if (dryRun) {
    return;
  }
  await executeCommand({
    command,
    cwd: repoPath,
    timeoutMs,
    logPath,
    env: environment,
  });
}

async function prepareRepository(
  repository: RepositoryDefinition,
  settings: PrepareSettings,
  repoPath: string,
  logsDirectory: string,
  dryRun: boolean,
  regressionTasks: TaskDefinition[],
  manifestsDirectory: string,
  mirrorPath: string | undefined,
): Promise<LockedRepository | undefined> {
  console.log(`\nRepository ${repository.id}`);
  console.log(`  path: ${repoPath}`);
  console.log(`  ref: ${repository.ref}`);
  const referenceFlag = mirrorPath !== undefined ? `--reference '${mirrorPath}' ` : "";
  const cloneCommand = `git clone ${referenceFlag}'${repository.url}' '${repoPath}'`;
  const fetchCommand = `git fetch${settings.fetchTags ? " --tags" : ""} --force origin`;
  describeCommand(
    repository.id,
    existsSync(repoPath) ? "fetch" : "clone",
    existsSync(repoPath) ? repoPath : join(repoPath, ".."),
    existsSync(repoPath) ? fetchCommand : cloneCommand,
    join(logsDirectory, existsSync(repoPath) ? "fetch.log" : "clone.log"),
  );
  describeCommand(
    repository.id,
    "checkout",
    repoPath,
    `git checkout --detach '${repository.ref}'`,
    join(logsDirectory, "checkout.log"),
  );
  if (settings.cleanCommand !== undefined) {
    describeCommand(
      repository.id,
      "clean",
      repoPath,
      settings.cleanCommand,
      join(logsDirectory, "clean.log"),
    );
  }
  describeCommand(
    repository.id,
    "resolve-commit",
    repoPath,
    "git rev-parse HEAD",
    join(logsDirectory, "resolve-commit.log"),
  );

  if (dryRun) {
    if (settings.installDependencies) {
      await runStep(repository, "install", repository.install_command, settings.installTimeoutMs, repoPath, logsDirectory, settings.environment, true);
    }
    const buildCommand = optionalString(repository.build_command, `${repository.id}.build_command`);
    if (buildCommand !== undefined) {
      await runStep(repository, "build", buildCommand, settings.buildTimeoutMs, repoPath, logsDirectory, settings.environment, true);
    }
    if (settings.runBaselineTests) {
      await runStep(repository, "test", repository.test_command, settings.testTimeoutMs, repoPath, logsDirectory, settings.environment, true);
    }
    return undefined;
  }

  const commit = await prepareGitRepository({
    url: repository.url,
    ref: repository.ref,
    repoPath,
    logsDirectory,
    timeoutMs: settings.installTimeoutMs,
    fetchTags: settings.fetchTags,
    ...(settings.cleanCommand === undefined ? {} : { cleanCommand: settings.cleanCommand }),
    ...(mirrorPath === undefined ? {} : { mirrorPath }),
  });
  const steps: LockedRepository["steps"] = {
    checkout: "passed",
    install: "skipped",
    build: "skipped",
    test: "skipped",
  };

  if (settings.installDependencies) {
    await runStep(repository, "install", repository.install_command, settings.installTimeoutMs, repoPath, logsDirectory, settings.environment, false);
    steps.install = "passed";
  }

  const buildCommand = optionalString(repository.build_command, `${repository.id}.build_command`);
  if (buildCommand !== undefined) {
    try {
      await runStep(repository, "build", buildCommand, settings.buildTimeoutMs, repoPath, logsDirectory, settings.environment, false);
      steps.build = "passed";
    } catch (error) {
      steps.build = "failed";
      if (!settings.buildOptional) {
        throw error;
      }
      console.error(`  [${repository.id}] optional build failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (settings.runBaselineTests) {
    try {
      await runStep(repository, "test", repository.test_command, settings.testTimeoutMs, repoPath, logsDirectory, settings.environment, false);
      steps.test = "passed";
    } catch (error) {
      steps.test = "failed";
      if (settings.failOnBaselineTestFailure) {
        throw error;
      }
      console.error(`  [${repository.id}] baseline tests failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    id: repository.id,
    url: repository.url,
    requestedRef: repository.ref,
    commit,
    repoPath,
    preparedAt: new Date().toISOString(),
    steps,
    ...(Array.isArray((repository as unknown as { reset_excludes?: unknown }).reset_excludes)
      ? { reset_excludes: (repository as unknown as { reset_excludes: string[] }).reset_excludes }
      : {}),
    regression_tasks: await runRegressionVerification(
      repository,
      repoPath,
      logsDirectory,
      regressionTasks,
      manifestsDirectory,
      settings,
    ),
  };
}

async function runRegressionVerification(
  repository: RepositoryDefinition,
  repoPath: string,
  logsDirectory: string,
  regressionTasks: TaskDefinition[],
  manifestsDirectory: string,
  settings: PrepareSettings,
): Promise<LockedRegressionTask[]> {
  if (regressionTasks.length === 0) return [];
  if (!settings.verifyRegression) {
    console.log(`  [${repository.id}] regression tasks present but verify_regression=false; skipping broken_state verification`);
    return [];
  }
  const out: LockedRegressionTask[] = [];
  for (const task of regressionTasks) {
    if (!task.regression) continue;
    const regression = task.regression;
    if (regression.base_commit !== undefined) {
      // Validate that the locked commit matches the task's expected base_commit.
      // We re-read the local HEAD rather than threading `commit` through; the lock is the source of truth.
    }
    const brokenPatchPath = isAbsolute(regression.broken_patch)
      ? regression.broken_patch
      : resolve(manifestsDirectory, regression.broken_patch);
    if (!existsSync(brokenPatchPath)) {
      throw new Error(`regression broken_patch not found for ${task.id}: ${brokenPatchPath}`);
    }
    const testCommand = task.target_tests.join(" && ");
    if (!testCommand) {
      throw new Error(`regression task ${task.id} has empty target_tests; cannot verify broken_state`);
    }
    const logPath = join(logsDirectory, `regression-${task.id}.log`);
    const excludes = Array.isArray((repository as unknown as { reset_excludes?: unknown }).reset_excludes)
      ? (repository as unknown as { reset_excludes: string[] }).reset_excludes
      : [];
    console.log(`  [${repository.id}] regression: ${task.id}`);
    console.log(`    broken_patch: ${brokenPatchPath}`);
    console.log(`    test_command: ${testCommand}`);

    // Reset to a clean green state before applying the broken patch.
    await resetRepoClean({ repoPath, timeoutMs: 60_000, excludes });
    await applyBrokenPatch({ repoPath, brokenPatchPath, timeoutMs: 60_000 });

    const report = await verifyBrokenState({
      repoPath,
      testCommand,
      timeoutMs: settings.testTimeoutMs,
      expectedGradingTests: regression.grading_tests,
      logPath,
    });
    if (report.parsed.unknownRunner) {
      throw new Error(
        `regression verify: unknown test runner for ${task.id}; cannot parse output. `
          + `See log at ${logPath}`,
      );
    }
    if (regression.grading_tests.length > 0 && report.gradingTestsFailing.length === 0) {
      throw new Error(
        `regression verify: none of the grading_tests failed for ${task.id} after broken_patch. `
          + `grading=${JSON.stringify(regression.grading_tests)} `
          + `observed_failures=${JSON.stringify([...report.parsed.failed])}`,
      );
    }
    if (regression.grading_tests.length > 0 && report.gradingTestsMissing.length > 0) {
      throw new Error(
        `regression verify: some grading_tests did not appear in the broken output for ${task.id}: `
          + JSON.stringify(report.gradingTestsMissing),
      );
    }
    const baselineFailing = [...report.parsed.failed];
    out.push({
      id: task.id,
      base_commit: regression.base_commit,
      broken_patch: regression.broken_patch,
      grading_tests: regression.grading_tests,
      baseline_failing_tests: baselineFailing,
      regression_verified_at: new Date().toISOString(),
    });
    console.log(`    baseline_failing_tests: ${baselineFailing.length}`);

    // Reset to green so the worktree is left in a deterministic state.
    await resetRepoClean({ repoPath, timeoutMs: 60_000, excludes });
  }
  return out;
}

export async function prepareRepos(argv = process.argv.slice(2)): Promise<void> {
  const options = parseEvalCliOptions(argv, ["--dry-run", "--run-id", "--repo-id", "--manifests-dir"]);
  const manifests = loadManifests(resolveManifestsDir(options.manifestsDir));
  const settings = readSettings(manifests.repos, manifests.run);
  const repositories = options.repoId === undefined
    ? manifests.repos.repositories
    : manifests.repos.repositories.filter(({ id }) => id === options.repoId);
  if (repositories.length === 0) {
    throw new Error(`repository filter matched no entries: ${String(options.repoId)}`);
  }
  const layout = resolveEvalLayout(manifests.run, options.runId);

  console.log(`Run: ${layout.runId}`);
  console.log(`Repositories: ${layout.reposDirectory}`);
  console.log(`Lock: ${layout.lockFile}`);
  console.log(`Logs: ${layout.prepareLogsDirectory}`);
  console.log(`Selected repositories (${repositories.length}): ${repositories.map(({ id }) => id).join(", ")}`);
  if (!settings.enabled) {
    console.log("Prepare phase is disabled by run.yaml.");
    return;
  }

  // Object store compartido: un bare mirror por URL bajo `.mirrors/`, de modo que
  // ~46 instancias de svelte (misma URL) descarguen los packs una sola vez en vez
  // de una por instancia. `.mirrors/` no es un `repository.id`, y los loops iteran
  // el manifest (no el FS), asi que nunca se trata como checkout.
  const mirrorsRoot = join(layout.reposDirectory, ".mirrors");
  const mirrorLogsRoot = join(layout.prepareLogsDirectory, "_mirrors");
  const updatedMirrors = new Set<string>();

  if (!options.dryRun) {
    mkdirSync(layout.reposDirectory, { recursive: true });
    mkdirSync(layout.prepareLogsDirectory, { recursive: true });
    mkdirSync(mirrorsRoot, { recursive: true });
  }

  const lock = existsSync(layout.lockFile)
    ? readRepositoriesLock(layout.lockFile)
    : createRepositoriesLock(layout.runId);
  if (lock.runId !== layout.runId) {
    throw new Error(`lock run id ${lock.runId} does not match requested run ${layout.runId}`);
  }
  const failures: string[] = [];
  const tasksByRepo = new Map<string, TaskDefinition[]>();
  for (const task of manifests.tasks.tasks) {
    if (task.regression === undefined) continue;
    const list = tasksByRepo.get(task.repo_id) ?? [];
    list.push(task);
    tasksByRepo.set(task.repo_id, list);
  }
  const manifestsDirectory = join(PROJECT_ROOT, "eval", "manifests");
  for (const repository of repositories) {
    const repoPath = join(layout.reposDirectory, repository.id);
    const logsDirectory = join(layout.prepareLogsDirectory, repository.id);
    const regressionTasks = tasksByRepo.get(repository.id) ?? [];
    const slug = slugForUrl(repository.url);
    const mirrorPath = join(mirrorsRoot, `${slug}.git`);
    try {
      // El mirror solo sirve para clones nuevos (comparte objetos via --reference).
      // Si el checkout ya existe (rama fetch), no hace falta el mirror → se evita
      // crear un mirror blobless innecesario para repos ya presentes en disco.
      const needsMirror = !existsSync(repoPath);
      // Fetch/clone del mirror una sola vez por URL en este run.
      if (needsMirror && !options.dryRun && !updatedMirrors.has(mirrorPath)) {
        const mirrorLogs = join(mirrorLogsRoot, slug);
        mkdirSync(mirrorLogs, { recursive: true });
        await prepareMirror({
          url: repository.url,
          mirrorPath,
          logsDirectory: mirrorLogs,
          timeoutMs: settings.installTimeoutMs,
          fetchTags: settings.fetchTags,
        });
        updatedMirrors.add(mirrorPath);
      }
      const locked = await prepareRepository(
        repository,
        settings,
        repoPath,
        logsDirectory,
        options.dryRun,
        regressionTasks,
        manifestsDirectory,
        needsMirror ? mirrorPath : undefined,
      );
      if (locked !== undefined) {
        upsertLockedRepository(lock, locked);
        if (settings.writeLockFile) {
          writeRepositoriesLock(layout.lockFile, lock);
        }
      }
    } catch (error) {
      failures.push(`${repository.id}: ${error instanceof Error ? error.message : String(error)}`);
      if (!options.dryRun) {
        writeRepoError(logsDirectory, error);
      }
      console.error(failures.at(-1));
      if (!settings.continueOnRepoFailure) {
        break;
      }
    }
  }

  if (options.dryRun) {
    console.log(`\nDry run: no directories, repositories, lock files, or logs were created.`);
  }
  if (failures.length > 0) {
    throw new Error(`repository preparation failed:\n${failures.join("\n")}`);
  }
}

if (isEntrypoint(import.meta.url)) {
  prepareRepos().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
