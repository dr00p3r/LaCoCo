import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConfigPath,
  resolveConfig,
  setConfig,
  unsetConfig,
} from "../../src/cli/state/config-store.js";
import {
  configureProjectStorage,
  configureProjectWatcher,
  getProjectsPath,
  inspectProject,
  listProjects,
  markWatcherRunning,
  markWatcherStopped,
  registerCurrentProject,
  removeProject,
} from "../../src/cli/state/project-registry.js";
import {
  acquireWatchLock,
  getWatchLockPath,
} from "../../src/cli/state/watch-lock.js";
import { STRATEGY_NAMES } from "../../src/retriever/strategies/strategy-names.js";

let tempDir: string;
let previousCwd: string;
let previousConfigHome: string | undefined;
let previousStateHome: string | undefined;
let previousStrategy: string | undefined;
let previousAgentModel: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "lacoco-state-"));
  previousCwd = process.cwd();
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  previousStateHome = process.env.XDG_STATE_HOME;
  previousStrategy = process.env.LACOCO_STRATEGY;
  previousAgentModel = process.env.LACOCO_AGENT_MODEL;

  process.env.XDG_CONFIG_HOME = path.join(tempDir, "config-home");
  process.env.XDG_STATE_HOME = path.join(tempDir, "state-home");
  delete process.env.LACOCO_STRATEGY;
  delete process.env.LACOCO_AGENT_MODEL;
});

afterEach(() => {
  process.chdir(previousCwd);
  restoreEnv("XDG_CONFIG_HOME", previousConfigHome);
  restoreEnv("XDG_STATE_HOME", previousStateHome);
  restoreEnv("LACOCO_STRATEGY", previousStrategy);
  restoreEnv("LACOCO_AGENT_MODEL", previousAgentModel);
  rmSync(tempDir, { recursive: true, force: true });
});

describe("config-store", () => {
  it("resuelve precedencia env > local > global > default", () => {
    const projectDir = createProject("app");
    process.chdir(projectDir);

    expect(resolveConfig("strategy.default")).toMatchObject({
      value: "hybrid",
      source: "default",
    });

    setConfig("strategy.default", "agentic", "global");
    expect(resolveConfig("strategy.default")).toMatchObject({
      value: "agentic",
      source: "global",
    });

    setConfig("strategy.default", "rpr", "local");
    expect(resolveConfig("strategy.default")).toMatchObject({
      value: "rpr",
      source: "local",
    });

    process.env.LACOCO_STRATEGY = "ictd";
    expect(resolveConfig("strategy.default")).toMatchObject({
      value: "ictd",
      source: "env",
    });
    delete process.env.LACOCO_STRATEGY;
  });

  it("valida valores antes de guardarlos y escribe archivos versionados", () => {
    const projectDir = createProject("app");
    process.chdir(projectDir);

    expect(() => setConfig("strategy.default", "semantic", "local")).toThrow(
      "strategy.default debe ser una de"
    );
    setConfig("timeout.ms", "1500", "local");

    const file = JSON.parse(fs.readFileSync(getConfigPath("local"), "utf-8")) as {
      version: number;
      values: { timeout: { ms: number } };
    };

    expect(file.version).toBe(1);
    expect(file.values.timeout.ms).toBe(1500);
  });

  it("acepta todas las estrategias registradas como strategy.default", () => {
    const projectDir = createProject("app");
    process.chdir(projectDir);

    for (const strategy of STRATEGY_NAMES) {
      expect(() => setConfig("strategy.default", strategy, "local")).not.toThrow();
      expect(resolveConfig("strategy.default")).toMatchObject({
        value: strategy,
        source: "local",
      });
    }
  });

  it("resuelve agent.model desde archivo y variable de entorno", () => {
    const projectDir = createProject("app");
    process.chdir(projectDir);

    expect(resolveConfig("agent.model")).toMatchObject({
      value: "qwen3:4b-instruct",
      source: "default",
    });
    setConfig("agent.model", "local-model", "local");
    expect(resolveConfig("agent.model")).toMatchObject({
      value: "local-model",
      source: "local",
    });

    process.env.LACOCO_AGENT_MODEL = "env-model";
    expect(resolveConfig("agent.model")).toMatchObject({
      value: "env-model",
      source: "env",
    });
  });

  it("elimina una propiedad sin destruir el resto del archivo", () => {
    const projectDir = createProject("app");
    process.chdir(projectDir);

    setConfig("timeout.ms", "1500", "local");
    setConfig("strategy.default", "agentic", "local");
    unsetConfig("timeout.ms", "local");

    expect(resolveConfig("timeout.ms")).toMatchObject({
      value: 30_000,
      source: "default",
    });
    expect(resolveConfig("strategy.default")).toMatchObject({
      value: "agentic",
      source: "local",
    });
  });
});

describe("project-registry", () => {
  it("registra proyectos con id estable y no duplica rutas equivalentes", () => {
    const projectDir = createProject("app");
    const first = registerCurrentProject(projectDir);
    const second = registerCurrentProject(path.join(projectDir, ".", "src", ".."));

    expect(second.id).toBe(first.id);
    expect(listProjects()).toHaveLength(1);
    expect(inspectProject(first.id).path).toBe(fs.realpathSync.native(projectDir));
    expect(inspectProject(path.join(projectDir, "src")).id).toBe(first.id);
  });

  it("detecta proyectos removidos como missing al listar", () => {
    const projectDir = createProject("missing-app");
    const project = registerCurrentProject(projectDir);
    rmSync(projectDir, { recursive: true, force: true });

    expect(inspectProject(project.id).watcher.status).toBe("missing");
  });

  it("elimina proyectos por id y usa un archivo de registro versionado", () => {
    const projectDir = createProject("app");
    const project = registerCurrentProject(projectDir);

    expect(getProjectsPath()).toBe(path.join(tempDir, "state-home", "lacoco", "projects.json"));
    expect(removeProject(project.id).id).toBe(project.id);
    expect(listProjects()).toEqual([]);
  });

  it("persiste configuración y estado básico de watcher", () => {
    const projectDir = createProject("watch-app");
    const tsconfig = path.join(projectDir, "tsconfig.json");
    fs.writeFileSync(tsconfig, "{}\n", "utf-8");

    const configured = configureProjectWatcher(projectDir, {
      tsconfig,
      dbPath: "tensor.sqlite",
      lanceDbPath: "./lancedb",
    });
    const running = markWatcherRunning(configured.id, process.pid, ["node", "lacoco"]);

    expect(running.watcher.status).toBe("running");
    expect(running.watcher.pid).toBe(process.pid);
    expect(running.watcher.tsconfig).toBe(tsconfig);
    expect(running.watcher.command).toEqual(["node", "lacoco"]);

    const stopped = markWatcherStopped(configured.id);
    expect(stopped.watcher.status).toBe("stopped");
    expect(stopped.watcher.pid).toBeNull();
    expect(stopped.watcher.command).toBeNull();
  });

  it("persiste rutas de almacenamiento del proyecto separadas del watcher", () => {
    const projectDir = createProject("storage-app");
    const project = configureProjectStorage(projectDir, {
      dbPath: path.join(projectDir, ".lacoco", "tensor.sqlite"),
      lanceDbPath: path.join(projectDir, ".lacoco", "lancedb"),
    });

    expect(project.storage.dbPath).toBe(path.join(projectDir, ".lacoco", "tensor.sqlite"));
    expect(project.storage.lanceDbPath).toBe(path.join(projectDir, ".lacoco", "lancedb"));
    expect(inspectProject(project.id).storage.updatedAt).not.toBeNull();
  });

  it("marca como stale un watcher running cuyo PID ya no existe", () => {
    const projectDir = createProject("stale-app");
    const project = registerCurrentProject(projectDir);
    markWatcherRunning(project.id, 999_999_999, ["node", "lacoco"]);

    expect(inspectProject(project.id).watcher.status).toBe("stale");
  });

  it("marca como stale un PID activo que no coincide con el comando watcher registrado", () => {
    const projectDir = createProject("wrong-process-app");
    const tsconfig = path.join(projectDir, "tsconfig.json");
    fs.writeFileSync(tsconfig, "{}\n", "utf-8");
    const project = configureProjectWatcher(projectDir, {
      tsconfig,
      dbPath: "tensor.sqlite",
      lanceDbPath: "./lancedb",
    });

    markWatcherRunning(project.id, process.pid, ["node", "_watch-foreground", tsconfig]);

    expect(inspectProject(project.id).watcher.status).toBe("stale");
  });
});

describe("watch-lock", () => {
  it("crea un lock atómico y lo libera", () => {
    const lock = acquireWatchLock("project-a");

    expect(fs.existsSync(getWatchLockPath("project-a"))).toBe(true);
    expect(() => acquireWatchLock("project-a")).toThrow("Watcher lock activo");

    lock.release();
    expect(fs.existsSync(getWatchLockPath("project-a"))).toBe(false);
  });

  it("reemplaza locks stale", () => {
    const lockPath = getWatchLockPath("project-b");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(
      lockPath,
      JSON.stringify({
        version: 1,
        projectId: "project-b",
        pid: 999_999_999,
        createdAt: new Date().toISOString(),
      }),
      "utf-8",
    );

    const lock = acquireWatchLock("project-b");

    expect(fs.existsSync(lock.path)).toBe(true);
    lock.release();
  });
});

function createProject(name: string): string {
  const projectDir = path.join(tempDir, name);
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".git"));
  return projectDir;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
