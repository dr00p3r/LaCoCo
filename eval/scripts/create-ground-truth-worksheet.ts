import { mkdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isEntrypoint, parseEvalCliOptions } from "./lib/cli.js";
import {
  deduplicateCandidates,
  parseCandidateRecord,
  renderGroundTruthWorksheet,
  type RetrievalCandidate,
} from "./lib/gold.js";
import { readJsonl } from "./lib/jsonl.js";
import { loadManifests } from "./lib/load-manifests.js";
import { PROJECT_ROOT } from "./lib/paths.js";
import { selectTasks } from "./lib/task-selection.js";

export function createGroundTruthWorksheets(argv = process.argv.slice(2)): void {
  const options = parseEvalCliOptions(argv, [
    "--run-dir",
    "--repo-id",
    "--task-id",
    "--dry-run",
  ]);
  if (options.runDir === undefined) {
    throw new Error("--run-dir is required");
  }
  const runDirectory = isAbsolute(options.runDir)
    ? resolve(options.runDir)
    : resolve(PROJECT_ROOT, options.runDir);
  const manifests = loadManifests();
  const tasks = selectTasks(manifests.tasks.tasks, {
    ...(options.repoId === undefined ? {} : { repoId: options.repoId }),
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
  });
  const candidatesByTask = new Map<string, RetrievalCandidate[]>();
  const retrievalPath = join(runDirectory, "retrieval.jsonl");
  for (const { line, value } of readJsonl(retrievalPath)) {
    const parsed = parseCandidateRecord(value, `${retrievalPath}:${line}`);
    const candidates = candidatesByTask.get(parsed.taskId) ?? [];
    candidates.push(...parsed.candidates);
    candidatesByTask.set(parsed.taskId, candidates);
  }

  const outputDirectory = join(runDirectory, "gold-worksheets");
  console.log(`Run directory: ${runDirectory}`);
  console.log(`Retrieval input: ${retrievalPath}`);
  console.log(`Selected tasks (${tasks.length}): ${tasks.map(({ id }) => id).join(", ")}`);
  console.log(`Worksheet directory: ${outputDirectory}`);
  if (!options.dryRun) mkdirSync(outputDirectory, { recursive: true });

  for (const task of tasks) {
    const candidates = deduplicateCandidates(candidatesByTask.get(task.id) ?? []);
    const outputPath = join(outputDirectory, `${task.id}.md`);
    console.log(`${task.id}: ${candidates.length} candidates -> ${outputPath}`);
    if (!options.dryRun) {
      writeFileSync(outputPath, renderGroundTruthWorksheet(task, candidates), "utf8");
    }
  }
  if (options.dryRun) console.log("Dry run: no worksheets were written.");
}

if (isEntrypoint(import.meta.url)) {
  try {
    createGroundTruthWorksheets();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
