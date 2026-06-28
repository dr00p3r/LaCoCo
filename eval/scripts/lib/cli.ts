import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface EvalCliOptions {
  dryRun: boolean;
  runId?: string;
  runDir?: string;
  repoId?: string;
  taskId?: string;
  strategyId?: string;
  split?: string;
}

export type EvalCliFlag =
  | "--dry-run"
  | "--run-id"
  | "--run-dir"
  | "--repo-id"
  | "--task-id"
  | "--strategy-id"
  | "--split";

const VALUE_FLAGS = {
  "--run-id": "runId",
  "--run-dir": "runDir",
  "--repo-id": "repoId",
  "--task-id": "taskId",
  "--strategy-id": "strategyId",
  "--split": "split",
} as const;

export function parseEvalCliOptions(
  argv: string[],
  allowedFlags: readonly EvalCliFlag[] = ["--dry-run", "--run-id"],
): EvalCliOptions {
  let dryRun = false;
  const values: Partial<Record<(typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS], string>> = {};
  const allowed = new Set(allowedFlags);
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!allowed.has(argument as EvalCliFlag)) {
      throw new Error(`unknown argument: ${String(argument)}`);
    }
    if (seen.has(argument!)) {
      throw new Error(`duplicate argument: ${String(argument)}`);
    }
    seen.add(argument!);
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    const property = VALUE_FLAGS[argument as keyof typeof VALUE_FLAGS];
    const value = argv[index + 1];
    if (property === undefined || value === undefined || value.startsWith("--")) {
      throw new Error(`${String(argument)} requires a value`);
    }
    values[property] = value;
    index += 1;
  }

  return { dryRun, ...values };
}

export function isEntrypoint(moduleUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return false;
  }
  return moduleUrl === pathToFileURL(resolve(entrypoint)).href;
}
