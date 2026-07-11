import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DaemonManager } from "../extractor/daemon.js";
import { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { resolveNumberConfig } from "./config.js";
import { formatProjectDetails, formatProjectList } from "./formatters.js";
import { projectPathFromTsconfig, resolveDbPath, resolveLanceDbPath } from "./storage-paths.js";
import {
  configureProjectWatcher,
  inspectProject,
  listProjects,
  markWatcherError,
  markWatcherRunning,
  markWatcherStarting,
  markWatcherStopped,
  type ProjectRecord,
} from "./state/project-registry.js";
import { acquireWatchLock, type WatchLock } from "./state/watch-lock.js";

interface JsonOption { json: boolean; }

function printBanner(tsconfig: string, dbPath: string, lanceDbPath: string): void {
  console.log(`LaCoCo watch\n  tsconfig: ${tsconfig}\n  sqlite:   ${dbPath}\n  lancedb:  ${lanceDbPath}`);
}

function writeProjectResult(project: ProjectRecord, json: boolean): void {
  console.log(json ? JSON.stringify(project, null, 2) : formatProjectDetails(project));
}

export interface WatchForegroundOptions {
  db?: string;
  lancedb?: string;
  verbose: boolean;
}

interface ResolvedWatchOptions {
  db: string;
  lancedb: string;
  verbose: boolean;
}

export interface WatchCliOptions extends JsonOption {
  foreground: boolean;
  verbose: boolean;
}

export function runWatchCommand(
  action: string | undefined,
  project: string | undefined,
  options: WatchCliOptions,
): void {
  if (action === undefined || action === "list") {
    const projects = listProjects();
    if (options.json) {
      console.log(JSON.stringify(projects, null, 2));
      return;
    }
    console.log(formatProjectList(projects));
    return;
  }

  if (action === "status") {
    writeProjectResult(inspectProject(project ?? process.cwd()), options.json);
    return;
  }

  if (action === "start") {
    startManagedWatcher(project ?? process.cwd(), options);
    return;
  }

  if (action === "stop") {
    stopManagedWatcher(project ?? process.cwd(), options.json);
    return;
  }

  if (action === "restart") {
    stopManagedWatcher(project ?? process.cwd(), options.json, true);
    startManagedWatcher(project ?? process.cwd(), options);
    return;
  }

  throw new Error(`Acción watch no soportada: ${action}`);
}

function startManagedWatcher(target: string, options: WatchCliOptions): void {
  const project = resolveProjectForWatcher(target);
  const lock = acquireWatchLock(project.id);
  let launchAttempted = false;

  try {
    const current = inspectProject(project.id);
    const resolvedOptions = resolveWatchOptions(current);

    if (current.watcher.status === "running") {
      throw new Error(`Ya existe un watcher activo para ${current.name} (pid ${current.watcher.pid})`);
    }

    const tsconfig = current.watcher.tsconfig;
    if (!tsconfig) throw new Error(`Proyecto sin tsconfig configurado: ${current.name}`);

    if (options.foreground) {
      startForegroundWatcher(tsconfig, { ...resolvedOptions, verbose: options.verbose }, current.id, lock);
      return;
    }

    markWatcherStarting(current.id);
    launchAttempted = true;
    const { command, childPid } = spawnDetachedWatcher(current, tsconfig, resolvedOptions);
    const updated = markWatcherRunning(current.id, childPid, command);
    if (options.json) {
      console.log(JSON.stringify(updated, null, 2));
      return;
    }
    console.log(`Watcher iniciado: ${updated.name} (pid ${childPid})`);
  } catch (err) {
    if (launchAttempted) markWatcherError(project.id);
    lock.release();
    throw err;
  } finally {
    if (!options.foreground) lock.release();
  }
}

function stopManagedWatcher(selector: string, json: boolean, quiet = false): void {
  const project = inspectProject(selector);

  if (project.watcher.status === "running" && project.watcher.pid !== null) {
    process.kill(project.watcher.pid, "SIGTERM");
  }

  const updated = markWatcherStopped(project.id);
  if (quiet) return;
  if (json) {
    console.log(JSON.stringify(updated, null, 2));
    return;
  }
  console.log(`Watcher detenido: ${updated.name}`);
}

function resolveProjectForWatcher(target: string): ProjectRecord {
  const project = inspectProject(target);
  const tsconfig = project.watcher.tsconfig ?? inferTsconfig(project);
  const dbPath = project.watcher.dbPath ?? project.storage.dbPath ?? resolveDbPath(project.path);
  const lanceDbPath = project.watcher.lanceDbPath ?? project.storage.lanceDbPath ?? resolveLanceDbPath(project.path);
  return configureProjectWatcher(project.path, {
    tsconfig,
    dbPath,
    lanceDbPath,
  });
}

function resolveWatchOptions(project: ProjectRecord): ResolvedWatchOptions {
  return {
    db: project.watcher.dbPath ?? resolveDbPath(project.path),
    lancedb: project.watcher.lanceDbPath ?? resolveLanceDbPath(project.path),
    verbose: false,
  };
}

function inferTsconfig(project: ProjectRecord): string {
  const candidate = path.join(project.repoRoot, "tsconfig.json");
  if (!fs.existsSync(candidate)) {
    throw new Error(`No hay tsconfig configurado y no existe ${candidate}`);
  }
  return candidate;
}

export function startForegroundWatcher(
  rutaTsconfig: string,
  options: WatchForegroundOptions,
  projectId?: string,
  existingLock?: WatchLock,
): void {
  const projectPath = projectPathFromTsconfig(rutaTsconfig);
  const resolvedOptions: ResolvedWatchOptions = {
    db: resolveDbPath(projectPath, options.db),
    lancedb: resolveLanceDbPath(projectPath, options.lancedb),
    verbose: options.verbose,
  };
  printBanner(rutaTsconfig, resolvedOptions.db, resolvedOptions.lancedb);
  const project = configureProjectWatcher(projectPath, {
    tsconfig: rutaTsconfig,
    dbPath: resolvedOptions.db,
    lanceDbPath: resolvedOptions.lancedb,
  });
  const watcherProjectId = projectId ?? project.id;
  const lock = existingLock ?? acquireWatchLock(watcherProjectId);
  const current = inspectProject(watcherProjectId);

  if (
    current.watcher.status === "running" &&
    current.watcher.pid !== null &&
    current.watcher.pid !== process.pid
  ) {
    lock.release();
    throw new Error(`Ya existe un watcher activo para ${current.name} (pid ${current.watcher.pid})`);
  }

  markWatcherRunning(watcherProjectId, process.pid, process.argv);

  const db = new LaCoCoDatabase(resolvedOptions.db);

  const daemon = new DaemonManager({
    tsConfigFilePath: rutaTsconfig,
    db,
    verbose: resolvedOptions.verbose,
    indexEmbeddings: true,
    lanceDbPath: resolvedOptions.lancedb,
    watchDebounceMs: resolveNumberConfig("watcher.debounceMs"),
  });

  let shuttingDown = false;

  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");

    console.log("\n[CLI] Señal de apagado recibida...");
    markWatcherStopped(watcherProjectId);
    lock.release();
    daemon.stop().then(() => process.exit(0)).catch(() => process.exit(1));
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  try {
    daemon.start();
  } catch (err) {
    markWatcherError(watcherProjectId);
    lock.release();
    console.error(
      "[CLI] ❌ Error fatal durante el arranque:",
      err instanceof Error ? err.message : err
    );
    daemon.stop().then(() => process.exit(1)).catch(() => process.exit(1));
  }
}

function spawnDetachedWatcher(
  project: ProjectRecord,
  tsconfig: string,
  options: ResolvedWatchOptions,
): { command: string[]; childPid: number } {
  const entrypoint = process.argv[1];
  if (!entrypoint) throw new Error("No se pudo resolver el entrypoint de la CLI");

  const command = buildWatchCommand(entrypoint, tsconfig, options);
  const logsDir = resolveProjectPath(project, String(project.config["paths.logs"] ?? ".lacoco/logs"));
  fs.mkdirSync(logsDir, { recursive: true });
  const out = fs.openSync(path.join(logsDir, "watcher.log"), "a");
  const err = fs.openSync(path.join(logsDir, "watcher.err.log"), "a");

  const [cmd, ...args] = command;
  if (!cmd) throw new Error("Comando de watcher inválido");

  const child = spawn(cmd, args, {
    cwd: project.path,
    detached: true,
    stdio: ["ignore", out, err],
    env: {
      ...process.env,
      LACOCO_WATCH_PROJECT_ID: project.id,
      LACOCO_WATCH_SKIP_LOCK: "1",
    },
  });

  fs.closeSync(out);
  fs.closeSync(err);

  if (!child.pid) throw new Error("No se pudo iniciar el proceso watcher");
  child.unref();
  return { command, childPid: child.pid };
}

function buildWatchCommand(
  entrypoint: string,
  tsconfig: string,
  options: ResolvedWatchOptions,
): string[] {
  const args = [
    "_watch-foreground",
    tsconfig,
    "--db",
    options.db,
    "--lancedb",
    options.lancedb,
  ];
  if (options.verbose) args.push("--verbose");

  if (entrypoint.endsWith(".ts")) {
    return [process.execPath, "--import", "tsx", entrypoint, ...args];
  }
  return [process.execPath, entrypoint, ...args];
}

function resolveProjectPath(project: ProjectRecord, maybeRelativePath: string): string {
  return path.isAbsolute(maybeRelativePath)
    ? maybeRelativePath
    : path.join(project.path, maybeRelativePath);
}

export function noopWatchLock(): WatchLock {
  return {
    path: "",
    release: () => {},
  };
}
