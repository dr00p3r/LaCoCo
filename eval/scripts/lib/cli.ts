import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface EvalCliOptions {
  dryRun: boolean;
  runId?: string | undefined;
  runDir?: string | undefined;
  repoId?: string | undefined;
  taskId?: string | undefined;
  strategyId?: string | undefined;
  agentId?: string | undefined;
  split?: string | undefined;
  sanitizerVariant?: string | undefined;
  manifestsDir?: string | undefined;
  profile?: boolean | undefined;
  useSlm?: boolean | undefined;
  maxBudgetUsd?: number | undefined;
  resume?: boolean | undefined;
  strict?: boolean | undefined;
}

export type EvalCliFlag =
  | "--dry-run"
  | "--run-id"
  | "--run-dir"
  | "--repo-id"
  | "--task-id"
  | "--strategy-id"
  | "--agent-id"
  | "--split"
  | "--sanitizer-variant"
  | "--manifests-dir"
  | "--profile"
  | "--use-slm"
  | "--resume"
  | "--strict"
  | "--max-budget-usd";

const VALUE_FLAGS = {
  "--run-id": "runId",
  "--run-dir": "runDir",
  "--repo-id": "repoId",
  "--task-id": "taskId",
  "--strategy-id": "strategyId",
  "--agent-id": "agentId",
  "--split": "split",
  "--sanitizer-variant": "sanitizerVariant",
  "--manifests-dir": "manifestsDir",
  "--max-budget-usd": "maxBudgetUsd",
} as const;

export function parseEvalCliOptions(
  argv: string[],
  allowedFlags: readonly EvalCliFlag[] = ["--dry-run", "--run-id"],
): EvalCliOptions {
  let dryRun = false;
  let profile = false;
  let useSlm = false;
  let resume = false;
  let strict = false;
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
    if (argument === "--dry-run" || argument === "--profile" || argument === "--use-slm" || argument === "--resume" || argument === "--strict") {
      if (argument === "--dry-run") dryRun = true;
      if (argument === "--profile") profile = true;
      if (argument === "--use-slm") useSlm = true;
      if (argument === "--resume") resume = true;
      if (argument === "--strict") strict = true;
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

  // Convert max-budget-usd to number; remove from `values` to avoid
  // double-typing with the string in the partial record.
  let maxBudgetUsd: number | undefined;
  if (values.maxBudgetUsd !== undefined) {
    const parsed = Number(values.maxBudgetUsd);
    if (Number.isNaN(parsed) || parsed < 0) {
      throw new Error(`--max-budget-usd requires a non-negative number`);
    }
    maxBudgetUsd = parsed;
    delete values.maxBudgetUsd;
  }

  // Drop undefined-valued string flags so they don't bleed into EvalCliOptions
  const cleaned: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v !== undefined) cleaned[k] = v;
  }

  return {
    dryRun,
    ...(profile ? { profile: true } : {}),
    ...(useSlm ? { useSlm: true } : {}),
    ...(resume ? { resume: true } : {}),
    ...(strict ? { strict: true } : {}),
    ...(maxBudgetUsd !== undefined ? { maxBudgetUsd } : {}),
    ...cleaned,
  } as EvalCliOptions;
}

export function isEntrypoint(moduleUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return false;
  }
  return moduleUrl === pathToFileURL(resolve(entrypoint)).href;
}
