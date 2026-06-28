import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface EvalCliOptions {
  dryRun: boolean;
  runId?: string;
}

export function parseEvalCliOptions(argv: string[]): EvalCliOptions {
  let dryRun = false;
  let runId: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--run-id") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--run-id requires a value");
      }
      runId = value;
      index += 1;
      continue;
    }
    throw new Error(`unknown argument: ${argument}`);
  }

  return runId === undefined ? { dryRun } : { dryRun, runId };
}

export function isEntrypoint(moduleUrl: string): boolean {
  const entrypoint = process.argv[1];
  if (entrypoint === undefined) {
    return false;
  }
  return moduleUrl === pathToFileURL(resolve(entrypoint)).href;
}
