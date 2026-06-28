import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEvalCliOptions, isEntrypoint } from "./lib/cli.js";
import { asBoolean, asNumber, asRecord, asString } from "./lib/config.js";
import { CommandExecutionError, executeCommand, shellQuote } from "./lib/exec.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { loadManifests } from "./lib/load-manifests.js";
import { PROJECT_ROOT } from "./lib/paths.js";
import { readRepositoriesLock, type LockedRepository } from "./lib/repo-lock.js";
import { resolveRepositoryTsconfig } from "./lib/tsconfig.js";
import type { RepositoryDefinition } from "./lib/types.js";

interface IndexSettings {
  enabled: boolean;
  graph: boolean;
  vectors: boolean;
  timeoutMs: number;
  graphDbName: string;
  vectorDirectoryName: string;
  initTemplate: string;
  graphTemplate: string;
  vectorsTemplate: string;
}

function readSettings(reposManifest: Record<string, unknown>, runManifest: Record<string, unknown>): IndexSettings {
  const defaults = asRecord(reposManifest.defaults, "repos.yaml.defaults");
  const build = asRecord(defaults.build, "repos.yaml.defaults.build");
  const lacocoIndex = asRecord(defaults.lacoco_index, "repos.yaml.defaults.lacoco_index");
  const phases = asRecord(runManifest.phases, "run.yaml.phases");
  const index = asRecord(phases.index_repos, "run.yaml.phases.index_repos");
  const commands = asRecord(index.commands, "run.yaml.phases.index_repos.commands");
  return {
    enabled: asBoolean(index.enabled, "run.yaml.phases.index_repos.enabled"),
    graph: asBoolean(index.graph, "run.yaml.phases.index_repos.graph"),
    vectors: asBoolean(index.vectors, "run.yaml.phases.index_repos.vectors"),
    timeoutMs: asNumber(build.timeout_ms, "repos.yaml.defaults.build.timeout_ms"),
    graphDbName: asString(lacocoIndex.graph_db_name, "repos.yaml.defaults.lacoco_index.graph_db_name"),
    vectorDirectoryName: asString(
      lacocoIndex.vector_dir_name,
      "repos.yaml.defaults.lacoco_index.vector_dir_name",
    ),
    initTemplate: asString(commands.init_template, "run.yaml.phases.index_repos.commands.init_template"),
    graphTemplate: asString(
      commands.index_graph_template,
      "run.yaml.phases.index_repos.commands.index_graph_template",
    ),
    vectorsTemplate: asString(
      commands.index_vectors_template,
      "run.yaml.phases.index_repos.commands.index_vectors_template",
    ),
  };
}

function fillTemplate(template: string, values: Record<string, string>): string {
  let command = template;
  for (const [name, value] of Object.entries(values)) {
    command = command.replaceAll(`{${name}}`, shellQuote(value));
  }
  const unresolved = command.match(/\{[a-z_]+\}/i);
  if (unresolved !== null) {
    throw new Error(`unresolved command template placeholder: ${unresolved[0]}`);
  }
  return command;
}

function describeStep(repoId: string, step: string, command: string, logPath: string): void {
  console.log(`  [${repoId}] ${step}`);
  console.log(`    cwd: ${PROJECT_ROOT}`);
  console.log(`    command: ${command}`);
  console.log(`    log: ${logPath}`);
}

async function runStep(
  repoId: string,
  step: string,
  command: string,
  logPath: string,
  timeoutMs: number,
  dryRun: boolean,
): Promise<void> {
  describeStep(repoId, step, command, logPath);
  if (dryRun) {
    return;
  }
  await executeCommand({ command, cwd: PROJECT_ROOT, timeoutMs, logPath });
}

function writeRepoError(logsDirectory: string, error: unknown): void {
  mkdirSync(logsDirectory, { recursive: true });
  const details = error instanceof CommandExecutionError
    ? { message: error.message, ...error.result }
    : { message: error instanceof Error ? error.message : String(error) };
  writeFileSync(join(logsDirectory, "error.json"), `${JSON.stringify(details, null, 2)}\n`, "utf8");
}

async function indexRepository(
  repository: RepositoryDefinition,
  locked: LockedRepository,
  settings: IndexSettings,
  repositoriesManifest: Parameters<typeof resolveRepositoryTsconfig>[0]["repositoriesManifest"],
  indexesDirectory: string,
  logsDirectory: string,
  dryRun: boolean,
): Promise<void> {
  const repoPath = locked.repoPath;
  const indexDirectory = join(indexesDirectory, repository.id);
  const dbPath = join(indexDirectory, settings.graphDbName);
  const lancedbPath = join(indexDirectory, settings.vectorDirectoryName);
  const tsconfig = resolveRepositoryTsconfig({
    repository,
    repositoriesManifest,
    repoPath,
    dryRun,
  });

  console.log(`\nRepository ${repository.id}`);
  console.log(`  commit: ${locked.commit}`);
  console.log(`  path: ${repoPath}`);
  console.log(`  tsconfig: ${tsconfig.path}${tsconfig.generated ? " (generated)" : ""}`);
  console.log(`  db: ${dbPath}`);
  console.log(`  lancedb: ${lancedbPath}`);

  if (!dryRun) {
    if (!existsSync(repoPath)) {
      throw new Error(`locked repository path does not exist: ${repoPath}`);
    }
    mkdirSync(indexDirectory, { recursive: true });
    mkdirSync(logsDirectory, { recursive: true });
  }

  const initCommand = fillTemplate(settings.initTemplate, { repo_path: repoPath });
  await runStep(
    repository.id,
    "init",
    initCommand,
    join(logsDirectory, "init.log"),
    settings.timeoutMs,
    dryRun,
  );

  if (settings.graph) {
    const graphCommand = fillTemplate(settings.graphTemplate, {
      tsconfig: tsconfig.path,
      db_path: dbPath,
    });
    await runStep(
      repository.id,
      "index-graph",
      graphCommand,
      join(logsDirectory, "index-graph.log"),
      settings.timeoutMs,
      dryRun,
    );
  }

  if (settings.vectors) {
    const vectorsCommand = fillTemplate(settings.vectorsTemplate, {
      tsconfig: tsconfig.path,
      lancedb_path: lancedbPath,
    });
    await runStep(
      repository.id,
      "index-vectors",
      vectorsCommand,
      join(logsDirectory, "index-vectors.log"),
      settings.timeoutMs,
      dryRun,
    );
  }
}

export async function indexRepos(argv = process.argv.slice(2)): Promise<void> {
  const options = parseEvalCliOptions(argv);
  const manifests = loadManifests();
  const settings = readSettings(manifests.repos, manifests.run);
  const layout = resolveEvalLayout(manifests.run, options.runId);

  console.log(`Run: ${layout.runId}`);
  console.log(`Lock: ${layout.lockFile}`);
  console.log(`Indexes: ${layout.indexesDirectory}`);
  console.log(`Logs: ${layout.indexLogsDirectory}`);
  if (!settings.enabled) {
    console.log("Index phase is disabled by run.yaml.");
    return;
  }

  let lockedRepositories: LockedRepository[];
  if (existsSync(layout.lockFile)) {
    const lock = readRepositoriesLock(layout.lockFile);
    if (lock.runId !== layout.runId) {
      throw new Error(`lock run id ${lock.runId} does not match requested run ${layout.runId}`);
    }
    lockedRepositories = lock.repositories;
  } else if (options.dryRun) {
    console.log("Dry run: lock file is absent; planning with manifest repository paths.");
    lockedRepositories = manifests.repos.repositories.map((repository) => ({
      id: repository.id,
      url: repository.url,
      requestedRef: repository.ref,
      commit: "<resolved-by-eval:prepare>",
      repoPath: join(layout.reposDirectory, repository.id),
      preparedAt: "<resolved-by-eval:prepare>",
      steps: {},
    }));
  } else {
    throw new Error(`repositories lock does not exist: ${layout.lockFile}; run eval:prepare first`);
  }

  const lockedById = new Map(lockedRepositories.map((repository) => [repository.id, repository]));
  const failures: string[] = [];
  for (const repository of manifests.repos.repositories) {
    const locked = lockedById.get(repository.id);
    if (locked === undefined) {
      const message = `${repository.id}: repository is missing from ${layout.lockFile}`;
      failures.push(message);
      console.error(message);
      continue;
    }
    const logsDirectory = join(layout.indexLogsDirectory, repository.id);
    try {
      await indexRepository(
        repository,
        locked,
        settings,
        manifests.repos,
        layout.indexesDirectory,
        logsDirectory,
        options.dryRun,
      );
    } catch (error) {
      const message = `${repository.id}: ${error instanceof Error ? error.message : String(error)}`;
      failures.push(message);
      console.error(message);
      if (!options.dryRun) {
        writeRepoError(logsDirectory, error);
      }
    }
  }

  if (options.dryRun) {
    console.log("\nDry run: no tsconfig, index, or log files were created and no commands were executed.");
  }
  if (failures.length > 0) {
    throw new Error(`repository indexing failed:\n${failures.join("\n")}`);
  }
}

if (isEntrypoint(import.meta.url)) {
  indexRepos().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
