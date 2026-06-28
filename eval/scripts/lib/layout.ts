import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { asRecord, asString } from "./config.js";
import { PROJECT_ROOT } from "./paths.js";
import type { RunConfigurationManifest } from "./types.js";

export interface EvalLayout {
  runId: string;
  workdir: string;
  reposDirectory: string;
  indexesDirectory: string;
  runsDirectory: string;
  runDirectory: string;
  lockFile: string;
  prepareLogsDirectory: string;
  indexLogsDirectory: string;
}

function absoluteProjectPath(path: string): string {
  return isAbsolute(path) ? path : resolve(PROJECT_ROOT, path);
}

function readGitShortSha(): string {
  const gitDirectory = resolve(PROJECT_ROOT, ".git");
  try {
    const head = readFileSync(resolve(gitDirectory, "HEAD"), "utf8").trim();
    if (!head.startsWith("ref: ")) {
      return head.slice(0, 7);
    }
    const reference = head.slice(5);
    const looseReference = resolve(gitDirectory, reference);
    if (existsSync(looseReference)) {
      return readFileSync(looseReference, "utf8").trim().slice(0, 7);
    }
    const packedRefs = readFileSync(resolve(gitDirectory, "packed-refs"), "utf8");
    const match = packedRefs
      .split("\n")
      .find((line) => !line.startsWith("#") && line.endsWith(` ${reference}`));
    return match?.split(" ")[0]?.slice(0, 7) ?? "unknown";
  } catch {
    return "unknown";
  }
}

function defaultRunId(manifest: RunConfigurationManifest): string {
  const run = asRecord(manifest.run, "run.yaml.run");
  const template = asString(run.default_id_template, "run.yaml.run.default_id_template");
  const label = asString(run.label, "run.yaml.run.label");
  const timezone = asString(run.timezone, "run.yaml.run.timezone");
  const dateParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes): string =>
    dateParts.find((entry) => entry.type === type)?.value ?? "00";
  const date = `${part("year")}-${part("month")}-${part("day")}`;
  return template
    .replaceAll("{date_yyyy_mm_dd}", date)
    .replaceAll("{git_short_sha}", readGitShortSha())
    .replaceAll("{label}", label);
}

export function resolveEvalLayout(
  manifest: RunConfigurationManifest,
  requestedRunId?: string,
): EvalLayout {
  const paths = asRecord(manifest.paths, "run.yaml.paths");
  const runId = requestedRunId ?? defaultRunId(manifest);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(runId)) {
    throw new Error("run id may only contain letters, numbers, dots, underscores, and hyphens");
  }

  const workdir = absoluteProjectPath(asString(paths.workdir, "run.yaml.paths.workdir"));
  const reposDirectory = absoluteProjectPath(asString(paths.repos, "run.yaml.paths.repos"));
  const indexesDirectory = absoluteProjectPath(asString(paths.indexes, "run.yaml.paths.indexes"));
  const runsDirectory = absoluteProjectPath(asString(paths.runs, "run.yaml.paths.runs"));
  const lockTemplate = asString(paths.lock_file, "run.yaml.paths.lock_file");
  const lockFile = absoluteProjectPath(lockTemplate.replaceAll("{run_id}", runId));
  const runDirectory = resolve(runsDirectory, runId);

  return {
    runId,
    workdir,
    reposDirectory,
    indexesDirectory,
    runsDirectory,
    runDirectory,
    lockFile,
    prepareLogsDirectory: resolve(runDirectory, "logs", "prepare"),
    indexLogsDirectory: resolve(runDirectory, "logs", "index"),
  };
}
