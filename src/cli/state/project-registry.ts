import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "./json-store.js";
import { listConfig, type ConfigValue } from "./config-store.js";

export type IndexStatus = "never" | "completed" | "error";
export type WatcherStatus = "running" | "stopped" | "starting" | "error" | "stale" | "missing";

export interface ProjectRecord {
  id: string;
  name: string;
  path: string;
  repoRoot: string;
  registeredAt: string;
  lastIndexedAt: string | null;
  lastIndexStatus: IndexStatus;
  config: Record<string, ConfigValue>;
  watcher: {
    status: WatcherStatus;
    pid: number | null;
    tsconfig: string | null;
    dbPath: string | null;
    lanceDbPath: string | null;
    command: string[] | null;
    startedAt: string | null;
    updatedAt: string | null;
  };
}

export interface WatcherConfig {
  tsconfig: string;
  dbPath: string;
  lanceDbPath: string;
}

interface ProjectRegistryFile {
  version: 1;
  projects: ProjectRecord[];
}

const REGISTRY_VERSION = 1;
export function registerCurrentProject(projectPath = process.cwd()): ProjectRecord {
  const normalizedPath = normalizeExistingPath(projectPath);
  const repoRoot = findRepoRoot(normalizedPath);
  const now = new Date().toISOString();
  const id = createProjectId(repoRoot);
  const registry = readRegistry();
  const existingIndex = registry.projects.findIndex((project) => project.id === id);
  const existing = existingIndex >= 0 ? registry.projects[existingIndex] : undefined;

  const record: ProjectRecord = {
    id,
    name: existing?.name ?? path.basename(repoRoot),
    path: normalizedPath,
    repoRoot,
    registeredAt: existing?.registeredAt ?? now,
    lastIndexedAt: existing?.lastIndexedAt ?? null,
    lastIndexStatus: existing?.lastIndexStatus ?? "never",
    config: snapshotConfig(),
    watcher: existing?.watcher ?? {
      status: "stopped",
      pid: null,
      tsconfig: null,
      dbPath: null,
      lanceDbPath: null,
      command: null,
      startedAt: null,
      updatedAt: null,
    },
  };

  if (existingIndex >= 0) {
    registry.projects[existingIndex] = record;
  } else {
    registry.projects.push(record);
  }

  writeRegistry(registry);
  return record;
}

export function markProjectIndexStatus(
  projectPath: string,
  status: IndexStatus,
): ProjectRecord {
  const normalizedPath = normalizeExistingPath(projectPath);
  const repoRoot = findRepoRoot(normalizedPath);
  const id = createProjectId(repoRoot);
  const registry = readRegistry();
  const project = registry.projects.find((entry) => entry.id === id);
  const record = project ?? registerCurrentProject(projectPath);

  record.lastIndexedAt = new Date().toISOString();
  record.lastIndexStatus = status;
  record.config = snapshotConfig();

  if (!project) return record;

  writeRegistry(registry);
  return record;
}

export function configureProjectWatcher(
  projectPath: string,
  config: WatcherConfig,
): ProjectRecord {
  const registered = registerCurrentProject(projectPath);
  const registry = readRegistry();
  const index = findProjectIndex(registry, registered.id);
  if (index < 0) throw new Error(`Proyecto no encontrado tras registrar: ${projectPath}`);

  const project = registry.projects[index]!;
  project.watcher = {
    ...project.watcher,
    tsconfig: path.resolve(config.tsconfig),
    dbPath: config.dbPath,
    lanceDbPath: config.lanceDbPath,
    updatedAt: new Date().toISOString(),
  };
  writeRegistry(registry);
  return withComputedWatcherStatus(project);
}

export function markWatcherStarting(selector: string): ProjectRecord {
  return updateWatcher(selector, {
    status: "starting",
    pid: null,
    command: null,
    startedAt: null,
    updatedAt: new Date().toISOString(),
  });
}

export function markWatcherRunning(
  selector: string,
  pid: number,
  command: string[],
): ProjectRecord {
  const now = new Date().toISOString();
  return updateWatcher(selector, {
    status: "running",
    pid,
    command,
    startedAt: now,
    updatedAt: now,
  });
}

export function markWatcherStopped(selector: string): ProjectRecord {
  return updateWatcher(selector, {
    status: "stopped",
    pid: null,
    command: null,
    updatedAt: new Date().toISOString(),
  });
}

export function markWatcherError(selector: string): ProjectRecord {
  return updateWatcher(selector, {
    status: "error",
    pid: null,
    command: null,
    updatedAt: new Date().toISOString(),
  });
}

export function listProjects(): ProjectRecord[] {
  return readRegistry().projects.map(withComputedWatcherStatus);
}

export function inspectProject(selector: string): ProjectRecord {
  const project = findProject(selector);
  if (!project) throw new Error(`Proyecto no encontrado: ${selector}`);
  return withComputedWatcherStatus(project);
}

export function removeProject(selector: string): ProjectRecord {
  const registry = readRegistry();
  const index = findProjectIndex(registry, selector);
  if (index < 0) throw new Error(`Proyecto no encontrado: ${selector}`);

  const [removed] = registry.projects.splice(index, 1);
  writeRegistry(registry);
  return removed!;
}

export function getProjectsPath(): string {
  return projectsPath();
}

function findProject(selector: string): ProjectRecord | undefined {
  const registry = readRegistry();
  const index = findProjectIndex(registry, selector);
  return index < 0 ? undefined : registry.projects[index];
}

function updateWatcher(
  selector: string,
  patch: Partial<ProjectRecord["watcher"]>,
): ProjectRecord {
  const registry = readRegistry();
  const index = findProjectIndex(registry, selector);
  if (index < 0) throw new Error(`Proyecto no encontrado: ${selector}`);

  const project = registry.projects[index]!;
  project.watcher = { ...project.watcher, ...patch };
  writeRegistry(registry);
  return withComputedWatcherStatus(project);
}

function findProjectIndex(registry: ProjectRegistryFile, selector: string): number {
  const normalizedSelector = tryNormalizePath(selector);
  const repoRootSelector = normalizedSelector === null ? null : findRepoRoot(normalizedSelector);

  return registry.projects.findIndex(
    (project) =>
      project.id === selector ||
      project.name === selector ||
      project.path === selector ||
      (normalizedSelector !== null && project.path === normalizedSelector) ||
      (repoRootSelector !== null && project.repoRoot === repoRootSelector),
  );
}

function readRegistry(): ProjectRegistryFile {
  const registryPath = projectsPath();
  const registry = readJsonFile<ProjectRegistryFile>(registryPath, {
    version: REGISTRY_VERSION,
    projects: [],
  });

  if (registry.version !== REGISTRY_VERSION || !Array.isArray(registry.projects)) {
    throw new Error(`Registro de proyectos corrupto o versión no soportada: ${registryPath}`);
  }

  registry.projects = registry.projects.map(normalizeProjectRecord);
  return registry;
}

function writeRegistry(registry: ProjectRegistryFile): void {
  writeJsonFileAtomic(projectsPath(), registry);
}

function normalizeProjectRecord(project: ProjectRecord): ProjectRecord {
  return {
    ...project,
    watcher: {
      status: project.watcher.status,
      pid: project.watcher.pid,
      tsconfig: project.watcher.tsconfig ?? null,
      dbPath: project.watcher.dbPath ?? null,
      lanceDbPath: project.watcher.lanceDbPath ?? null,
      command: project.watcher.command ?? null,
      startedAt: project.watcher.startedAt ?? null,
      updatedAt: project.watcher.updatedAt ?? null,
    },
  };
}

function normalizeExistingPath(projectPath: string): string {
  const absolutePath = path.resolve(projectPath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`La ruta del proyecto no existe: ${absolutePath}`);
  }
  return fs.realpathSync.native(absolutePath);
}

function tryNormalizePath(projectPath: string): string | null {
  try {
    return normalizeExistingPath(projectPath);
  } catch {
    return null;
  }
}

function findRepoRoot(projectPath: string): string {
  let current = projectPath;

  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return fs.realpathSync.native(current);
    }

    const parent = path.dirname(current);
    if (parent === current) return projectPath;
    current = parent;
  }
}

function createProjectId(repoRoot: string): string {
  return crypto.createHash("sha256").update(repoRoot).digest("hex").slice(0, 12);
}

function snapshotConfig(): Record<string, ConfigValue> {
  return Object.fromEntries(
    listConfig().map((entry) => [entry.key, entry.value]),
  ) as Record<string, ConfigValue>;
}

function withComputedWatcherStatus(project: ProjectRecord): ProjectRecord {
  const exists = fs.existsSync(project.path);
  if (!exists) {
    return {
      ...project,
      watcher: { ...project.watcher, status: "missing" },
    };
  }

  if (project.watcher.status === "running" && project.watcher.pid !== null) {
    return {
      ...project,
      watcher: {
        ...project.watcher,
        status: isWatcherProcessActive(project) ? "running" : "stale",
      },
    };
  }

  return project;
}

function isPidActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isWatcherProcessActive(project: ProjectRecord): boolean {
  const pid = project.watcher.pid;
  if (pid === null || !isPidActive(pid)) return false;

  const command = project.watcher.command;
  if (!command?.includes("_watch-foreground")) return true;

  const actualCommand = readProcessCommand(pid);
  if (actualCommand === null) return true;

  if (!actualCommand.includes("_watch-foreground")) return false;
  if (project.watcher.tsconfig && !actualCommand.includes(project.watcher.tsconfig)) {
    return false;
  }

  return true;
}

function readProcessCommand(pid: number): string[] | null {
  const procPath = `/proc/${pid}/cmdline`;
  if (!fs.existsSync(procPath)) return null;

  try {
    return fs
      .readFileSync(procPath, "utf-8")
      .split("\0")
      .filter((part) => part.length > 0);
  } catch {
    return null;
  }
}

function projectsPath(): string {
  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
    "lacoco",
    "projects.json",
  );
}
