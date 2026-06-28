import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvalCliOptions, isEntrypoint } from "./lib/cli.js";
import { asBoolean, asNumber, asRecord, asString, asStringRecord, optionalString } from "./lib/config.js";
import { CommandExecutionError, executeCommand } from "./lib/exec.js";
import { prepareGitRepository } from "./lib/git.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { loadManifests } from "./lib/load-manifests.js";
import {
  createRepositoriesLock,
  upsertLockedRepository,
  writeRepositoriesLock,
  type LockedRepository,
} from "./lib/repo-lock.js";
import type { RepositoryDefinition } from "./lib/types.js";

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
): Promise<LockedRepository | undefined> {
  console.log(`\nRepository ${repository.id}`);
  console.log(`  path: ${repoPath}`);
  console.log(`  ref: ${repository.ref}`);
  const cloneCommand = `git clone '${repository.url}' '${repoPath}'`;
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
  };
}

export async function prepareRepos(argv = process.argv.slice(2)): Promise<void> {
  const options = parseEvalCliOptions(argv);
  const manifests = loadManifests();
  const settings = readSettings(manifests.repos, manifests.run);
  const layout = resolveEvalLayout(manifests.run, options.runId);

  console.log(`Run: ${layout.runId}`);
  console.log(`Repositories: ${layout.reposDirectory}`);
  console.log(`Lock: ${layout.lockFile}`);
  console.log(`Logs: ${layout.prepareLogsDirectory}`);
  if (!settings.enabled) {
    console.log("Prepare phase is disabled by run.yaml.");
    return;
  }

  if (!options.dryRun) {
    mkdirSync(layout.reposDirectory, { recursive: true });
    mkdirSync(layout.prepareLogsDirectory, { recursive: true });
  }

  const lock = createRepositoriesLock(layout.runId);
  const failures: string[] = [];
  for (const repository of manifests.repos.repositories) {
    const repoPath = join(layout.reposDirectory, repository.id);
    const logsDirectory = join(layout.prepareLogsDirectory, repository.id);
    try {
      const locked = await prepareRepository(repository, settings, repoPath, logsDirectory, options.dryRun);
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
