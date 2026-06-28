import path from "node:path";
import { inspectProject, type ProjectRecord } from "./state/project-registry.js";
import { resolveStringConfig } from "./config.js";

export function projectPathFromTsconfig(tsconfigPath: string): string {
  return path.dirname(path.resolve(tsconfigPath));
}

export function resolveDbPath(projectPath: string, explicitPath?: string): string {
  return resolveStoragePath(projectPath, explicitPath, "dbPath", "tensor.sqlite");
}

export function resolveLanceDbPath(projectPath: string, explicitPath?: string): string {
  return resolveStoragePath(projectPath, explicitPath, "lanceDbPath", "lancedb");
}

export function resolveProjectPath(project: ProjectRecord, maybeRelativePath: string): string {
  return path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.join(project.path, maybeRelativePath);
}

function resolveStoragePath(
  projectPath: string,
  explicitPath: string | undefined,
  storageKey: "dbPath" | "lanceDbPath",
  defaultName: string,
): string {
  if (explicitPath !== undefined) return path.resolve(explicitPath);
  const project = tryInspectProject(projectPath);
  const storedPath = project?.storage[storageKey] ?? project?.watcher[storageKey];
  if (storedPath) return storedPath;
  return path.join(resolveProjectDataDir(project?.path ?? projectPath), defaultName);
}

function resolveProjectDataDir(projectPath: string): string {
  const dataPath = resolveStringConfig("paths.data");
  return path.isAbsolute(dataPath) ? dataPath : path.join(path.resolve(projectPath), dataPath);
}

function tryInspectProject(projectPath: string): ProjectRecord | null {
  try {
    return inspectProject(projectPath);
  } catch {
    return null;
  }
}
