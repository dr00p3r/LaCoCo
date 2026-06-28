import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

export const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const PROJECT_ROOT = resolve(EVAL_ROOT, "..");
export const MANIFESTS_DIR = join(EVAL_ROOT, "manifests");

export const MANIFEST_FILENAMES = {
  repos: "repos.yaml",
  strategies: "strategies.yaml",
  agents: "agents.yaml",
  metrics: "metrics.yaml",
  run: "run.yaml",
  tasks: "tasks.yaml",
} as const;

export type ManifestName = keyof typeof MANIFEST_FILENAMES;

export function getManifestPaths(manifestsDirectory = MANIFESTS_DIR): Record<ManifestName, string> {
  return Object.fromEntries(
    Object.entries(MANIFEST_FILENAMES).map(([name, filename]) => [
      name,
      join(manifestsDirectory, filename),
    ]),
  ) as Record<ManifestName, string>;
}
