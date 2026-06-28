import { isAbsolute, join, resolve } from "node:path";
import { isEntrypoint, parseEvalCliOptions } from "./lib/cli.js";
import { asRecord, asString } from "./lib/config.js";
import { findGraphDatabase, openGraphLookup, type GraphLookup } from "./lib/graph-reader.js";
import { validateTaskGold, type TaskGoldValidation } from "./lib/gold.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { loadManifests } from "./lib/load-manifests.js";
import { PROJECT_ROOT } from "./lib/paths.js";
import { selectTasks } from "./lib/task-selection.js";
import type { TaskDefinition } from "./lib/types.js";

function validateRepoTasks(
  tasks: TaskDefinition[],
  runDirectory: string | undefined,
  indexesDirectory: string,
  graphDbName: string,
): TaskGoldValidation[] {
  const repoId = tasks[0]!.repo_id;
  const graphPath = findGraphDatabase(runDirectory, indexesDirectory, repoId, graphDbName);
  let graph: GraphLookup | null = null;
  let warning = `graph database not found for ${repoId}; node IDs were not checked`;
  if (graphPath !== null) {
    try {
      graph = openGraphLookup(graphPath);
    } catch (error) {
      warning = `could not read graph ${graphPath}: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  try {
    return tasks.map((task) => validateTaskGold(task, graph, warning));
  } finally {
    graph?.close();
  }
}

export function validateGroundTruth(argv = process.argv.slice(2)): TaskGoldValidation[] {
  const options = parseEvalCliOptions(argv, [
    "--run-dir",
    "--repo-id",
    "--task-id",
    "--dry-run",
  ]);
  const manifests = loadManifests();
  const tasks = selectTasks(manifests.tasks.tasks, {
    ...(options.repoId === undefined ? {} : { repoId: options.repoId }),
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
  });
  const runDirectory = options.runDir === undefined
    ? undefined
    : isAbsolute(options.runDir)
      ? resolve(options.runDir)
      : resolve(PROJECT_ROOT, options.runDir);
  const layout = resolveEvalLayout(manifests.run);
  const defaults = asRecord(manifests.repos.defaults, "repos.yaml.defaults");
  const indexDefaults = asRecord(defaults.lacoco_index, "repos.yaml.defaults.lacoco_index");
  const graphDbName = asString(
    indexDefaults.graph_db_name,
    "repos.yaml.defaults.lacoco_index.graph_db_name",
  );
  const byRepo = new Map<string, TaskDefinition[]>();
  for (const task of tasks) {
    const repoTasks = byRepo.get(task.repo_id) ?? [];
    repoTasks.push(task);
    byRepo.set(task.repo_id, repoTasks);
  }
  const results = [...byRepo.values()].flatMap((repoTasks) =>
    validateRepoTasks(repoTasks, runDirectory, layout.indexesDirectory, graphDbName),
  );
  const valid = results.filter(({ status }) => status === "valid").length;
  const pending = results.filter(({ status }) => status === "pending").length;
  const invalid = results.filter(({ status }) => status === "invalid").length;
  const warnings = results.flatMap(({ issues }) => issues).filter(({ level }) => level === "warning").length;

  console.log(`Selected tasks (${tasks.length}): ${tasks.map(({ id }) => id).join(", ")}`);
  for (const result of results) {
    console.log(`${result.taskId}: ${result.status}`);
    for (const issue of result.issues) {
      console.log(`  ${issue.level.toUpperCase()} [${issue.code}] ${issue.message}`);
    }
  }
  console.log(`Valid tasks: ${valid}`);
  console.log(`Pending tasks: ${pending}`);
  console.log(`Invalid tasks: ${invalid}`);
  console.log(`Warnings: ${warnings}`);
  if (options.dryRun) console.log("Dry run: validation is read-only; no files were changed.");
  if (invalid > 0) throw new Error(`ground truth validation failed for ${invalid} task(s)`);
  return results;
}

if (isEntrypoint(import.meta.url)) {
  try {
    validateGroundTruth();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
