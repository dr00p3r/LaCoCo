import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

// Estado compartido con las fábricas de vi.mock (hoisted para poder referenciarlo
// desde los factories, que se elevan por encima de las declaraciones normales).
const h = vi.hoisted(() => ({
  daemonInstances: [] as Array<{
    opts: unknown;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
  }>,
  daemonStartError: null as Error | null,
  spawnCalls: [] as unknown[][],
  spawnChild: { pid: 4321, unref: vi.fn() } as { pid: number | undefined; unref: () => void },
}));

// El DaemonManager real arranca chokidar y un pipeline de indexado pesado; lo
// sustituimos por un doble controlable. La implementación se (re)aplica en
// beforeEach porque restoreAllMocks la despoja tras cada test.
vi.mock("../../src/extractor/daemon.js", () => ({ DaemonManager: vi.fn() }));

// La base SQLite abre un archivo real; el doble evita I/O y dependencias nativas.
vi.mock("../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js", () => ({
  LaCoCoDatabase: vi.fn(),
}));

// OllamaService abriría conexiones HTTP; lo neutralizamos.
vi.mock("../../src/slms/ollama-service.js", () => ({ OllamaService: vi.fn() }));

// Sólo interceptamos spawn (proceso detached real); el resto de child_process intacto.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from "node:child_process";
import { DaemonManager } from "../../src/extractor/daemon.js";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { OllamaService } from "../../src/slms/ollama-service.js";
import {
  configureProjectWatcher,
  inspectProject,
  markWatcherRunning,
  registerCurrentProject,
} from "../../src/cli/state/project-registry.js";
import {
  noopWatchLock,
  runWatchCommand,
  startForegroundWatcher,
  type WatchCliOptions,
} from "../../src/cli/watch.js";

// ---------- Estado del entorno de prueba ----------
let tempDir: string;
let previousCwd: string;
let previousStateHome: string | undefined;
let previousConfigHome: string | undefined;
let previousArgv1: string;

let logs: string[];
let errs: string[];
let exitCalls: Array<number | undefined>;
let baseSigint: NodeJS.SignalsListener[];
let baseSigterm: NodeJS.SignalsListener[];

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "lacoco-watch-"));
  previousCwd = process.cwd();
  previousStateHome = process.env.XDG_STATE_HOME;
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  previousArgv1 = process.argv[1] ?? "";

  process.env.XDG_STATE_HOME = path.join(tempDir, "state-home");
  process.env.XDG_CONFIG_HOME = path.join(tempDir, "config-home");

  // Reinicia el estado compartido de los dobles.
  h.daemonInstances.length = 0;
  h.daemonStartError = null;
  h.spawnCalls.length = 0;
  h.spawnChild = { pid: 4321, unref: vi.fn() };

  // Limpia el historial de llamadas acumulado por los dobles de módulo entre tests.
  vi.clearAllMocks();

  // Reaplica las implementaciones de los dobles de módulo (restoreAllMocks las
  // despoja). Se usan `function` (no arrow) porque se invocan con `new`.
  vi.mocked(DaemonManager).mockImplementation(function (this: unknown, opts: unknown) {
    const instance = {
      opts,
      start: vi.fn(() => {
        if (h.daemonStartError) throw h.daemonStartError;
      }),
      stop: vi.fn(() => Promise.resolve()),
    };
    h.daemonInstances.push(instance);
    return instance;
  } as never);
  vi.mocked(LaCoCoDatabase).mockImplementation(function (this: unknown, p: string) {
    return { path: p, close: vi.fn() };
  } as never);
  vi.mocked(OllamaService).mockImplementation(function (this: unknown) {
    return {};
  } as never);
  vi.mocked(spawn).mockImplementation(((...args: unknown[]) => {
    h.spawnCalls.push(args);
    return h.spawnChild;
  }) as never);

  logs = [];
  errs = [];
  exitCalls = [];

  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  });
  // process.kill se usa tanto para señales reales como para sondear PIDs vivos;
  // lo forzamos a "PID activo" y no-op para no matar al runner de pruebas.
  vi.spyOn(process, "kill").mockReturnValue(true as unknown as boolean) as unknown as MockInstance;
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCalls.push(code);
    return undefined as never;
  }) as never);

  // Captura los handlers de señal preexistentes para restaurarlos después
  // (startForegroundWatcher registra y removeAllListeners de SIGINT/SIGTERM).
  baseSigint = process.listeners("SIGINT");
  baseSigterm = process.listeners("SIGTERM");
});

afterEach(() => {
  vi.restoreAllMocks();

  process.removeAllListeners("SIGINT");
  process.removeAllListeners("SIGTERM");
  for (const l of baseSigint) process.on("SIGINT", l);
  for (const l of baseSigterm) process.on("SIGTERM", l);

  process.chdir(previousCwd);
  process.argv[1] = previousArgv1;
  restoreEnv("XDG_STATE_HOME", previousStateHome);
  restoreEnv("XDG_CONFIG_HOME", previousConfigHome);
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------- Helpers ----------
function createProjectDir(name: string): string {
  const dir = path.join(tempDir, name);
  mkdirSync(path.join(dir, "src"), { recursive: true });
  mkdirSync(path.join(dir, ".git"));
  writeFileSync(path.join(dir, "tsconfig.json"), "{}\n", "utf-8");
  return dir;
}

/** Registra el proyecto para que inspectProject/list lo encuentren. */
function registerProject(name: string): { dir: string; id: string } {
  const dir = createProjectDir(name);
  const record = registerCurrentProject(dir);
  return { dir, id: record.id };
}

function cliOptions(overrides: Partial<WatchCliOptions> = {}): WatchCliOptions {
  return { json: false, foreground: false, verbose: false, ...overrides };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

/** Devuelve el handler de shutdown registrado por startForegroundWatcher. */
function latestSignalHandler(signal: "SIGINT" | "SIGTERM"): NodeJS.SignalsListener {
  const all = process.listeners(signal) as NodeJS.SignalsListener[];
  const handler = all[all.length - 1];
  if (!handler) throw new Error(`No hay handler registrado para ${signal}`);
  return handler;
}

// ---------- noopWatchLock ----------
describe("noopWatchLock", () => {
  it("devuelve un lock sin ruta cuyo release no lanza", () => {
    const lock = noopWatchLock();

    expect(lock.path).toBe("");
    expect(() => lock.release()).not.toThrow();
  });
});

// ---------- runWatchCommand: list / status ----------
describe("runWatchCommand — list y status", () => {
  it("lista proyectos en texto cuando la acción es undefined", () => {
    registerProject("app-list");

    runWatchCommand(undefined, undefined, cliOptions());

    expect(logs.join("\n")).toContain("PROJECT");
    expect(logs.join("\n")).toContain("app-list");
  });

  it("lista proyectos en JSON con --json", () => {
    registerProject("app-json");

    runWatchCommand("list", undefined, cliOptions({ json: true }));

    const parsed = JSON.parse(logs[0]!) as Array<{ name: string }>;
    expect(parsed.some((p) => p.name === "app-json")).toBe(true);
  });

  it("muestra el detalle de un proyecto en status (texto)", () => {
    const { dir } = registerProject("app-status");

    runWatchCommand("status", dir, cliOptions());

    expect(logs.join("\n")).toContain("watcherStatus");
    expect(logs.join("\n")).toContain("app-status");
  });

  it("muestra el detalle de un proyecto en status (JSON)", () => {
    const { dir, id } = registerProject("app-status-json");

    runWatchCommand("status", dir, cliOptions({ json: true }));

    const parsed = JSON.parse(logs[0]!) as { id: string };
    expect(parsed.id).toBe(id);
  });

  it("cae al cwd cuando status no recibe proyecto", () => {
    const { dir, id } = registerProject("app-cwd");
    process.chdir(dir);

    runWatchCommand("status", undefined, cliOptions({ json: true }));

    const parsed = JSON.parse(logs[0]!) as { id: string };
    expect(parsed.id).toBe(id);
  });

  it("lanza en acciones no soportadas", () => {
    expect(() => runWatchCommand("frobnicate", undefined, cliOptions())).toThrow(
      "Acción watch no soportada: frobnicate",
    );
  });
});

// ---------- runWatchCommand: start (detached) ----------
describe("runWatchCommand — start (detached)", () => {
  it("lanza un watcher detached e imprime el PID (entrypoint .js)", () => {
    const { dir } = registerProject("app-start");
    process.argv[1] = "/fake/cli.js";

    runWatchCommand("start", dir, cliOptions());

    expect(spawn).toHaveBeenCalledTimes(1);
    // El comando .js no incluye el flag --import tsx.
    const [cmd, args] = h.spawnCalls[0] as [string, string[]];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain("_watch-foreground");
    expect(args).not.toContain("tsx");
    expect(logs.join("\n")).toContain("Watcher iniciado");
    expect(logs.join("\n")).toContain("(pid 4321)");
  });

  it("usa el runner tsx cuando el entrypoint es .ts", () => {
    const { dir } = registerProject("app-start-ts");
    process.argv[1] = "/fake/cli.ts";

    runWatchCommand("start", dir, cliOptions());

    const [cmd, args] = h.spawnCalls[0] as [string, string[]];
    expect(cmd).toBe(process.execPath);
    expect(args).toContain("--import");
    expect(args).toContain("tsx");
    expect(args).toContain("_watch-foreground");
  });

  it("emite el registro actualizado en JSON con --json", () => {
    const { dir, id } = registerProject("app-start-json");
    process.argv[1] = "/fake/cli.js";

    runWatchCommand("start", dir, cliOptions({ json: true }));

    const parsed = JSON.parse(logs[0]!) as { id: string; watcher: { pid: number } };
    expect(parsed.id).toBe(id);
    expect(parsed.watcher.pid).toBe(4321);
  });

  it("rechaza arrancar si ya hay un watcher activo", () => {
    const { dir, id } = registerProject("app-already");
    // Deja el watcher marcado como running con un PID que el spy considera activo.
    configureProjectWatcher(dir, {
      tsconfig: path.join(dir, "tsconfig.json"),
      dbPath: path.join(dir, "tensor.sqlite"),
      lanceDbPath: path.join(dir, "lancedb"),
    });
    markWatcherRunning(id, process.pid, ["node", "lacoco"]);

    expect(() => runWatchCommand("start", dir, cliOptions())).toThrow(
      "Ya existe un watcher activo",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("lanza si el proyecto no tiene tsconfig configurado ni inferible", () => {
    // Proyecto sin tsconfig.json en la raíz: inferTsconfig no puede resolverlo.
    const dir = path.join(tempDir, "app-no-tsconfig");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    mkdirSync(path.join(dir, ".git"));
    registerCurrentProject(dir);

    expect(() => runWatchCommand("start", dir, cliOptions())).toThrow(
      "No hay tsconfig configurado y no existe",
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it("propaga y marca error si el spawn no produce PID", () => {
    const { dir } = registerProject("app-nopid");
    process.argv[1] = "/fake/cli.js";
    h.spawnChild = { pid: undefined, unref: vi.fn() };

    expect(() => runWatchCommand("start", dir, cliOptions())).toThrow(
      "No se pudo iniciar el proceso watcher",
    );
    expect(inspectProject(dir).watcher.status).toBe("error");
  });
});

// ---------- runWatchCommand: start (foreground) ----------
describe("runWatchCommand — start (foreground)", () => {
  it("delega en el watcher en primer plano y arranca el daemon", () => {
    const { dir } = registerProject("app-fg");
    process.chdir(dir);

    runWatchCommand("start", dir, cliOptions({ foreground: true }));

    expect(DaemonManager).toHaveBeenCalledTimes(1);
    expect(h.daemonInstances[0]!.start).toHaveBeenCalledTimes(1);
    expect(spawn).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("LaCoCo watch");
  });
});

// ---------- runWatchCommand: stop / restart ----------
describe("runWatchCommand — stop y restart", () => {
  it("detiene un watcher en ejecución enviando SIGTERM", () => {
    const { dir, id } = registerProject("app-stop");
    markWatcherRunning(id, 4321, ["node", "lacoco"]);

    runWatchCommand("stop", dir, cliOptions());

    expect(process.kill).toHaveBeenCalledWith(4321, "SIGTERM");
    expect(inspectProject(dir).watcher.status).toBe("stopped");
    expect(logs.join("\n")).toContain("Watcher detenido");
  });

  it("emite el registro detenido en JSON", () => {
    const { dir, id } = registerProject("app-stop-json");
    markWatcherRunning(id, 4321, ["node", "lacoco"]);

    runWatchCommand("stop", dir, cliOptions({ json: true }));

    const parsed = JSON.parse(logs[0]!) as { watcher: { status: string } };
    expect(parsed.watcher.status).toBe("stopped");
  });

  it("no envía señal si el watcher no estaba corriendo", () => {
    const { dir } = registerProject("app-stop-idle");

    runWatchCommand("stop", dir, cliOptions());

    expect(process.kill).not.toHaveBeenCalled();
    expect(logs.join("\n")).toContain("Watcher detenido");
  });

  it("restart detiene en silencio y vuelve a lanzar detached", () => {
    const { dir, id } = registerProject("app-restart");
    process.argv[1] = "/fake/cli.js";
    markWatcherRunning(id, 4321, ["node", "lacoco"]);

    runWatchCommand("restart", dir, cliOptions());

    // El stop del restart es silencioso: no imprime "Watcher detenido".
    expect(logs.join("\n")).not.toContain("Watcher detenido");
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("Watcher iniciado");
  });
});

// ---------- startForegroundWatcher (directo) ----------
describe("startForegroundWatcher", () => {
  it("configura DB, Ollama y Daemon con las rutas explícitas y marca running", () => {
    const dir = createProjectDir("fg-direct");
    const tsconfig = path.join(dir, "tsconfig.json");
    const dbPath = path.join(dir, "tensor.sqlite");
    const lancePath = path.join(dir, "lancedb");

    startForegroundWatcher(
      tsconfig,
      { db: dbPath, lancedb: lancePath, verbose: true },
      undefined,
      noopWatchLock(),
    );

    expect(LaCoCoDatabase).toHaveBeenCalledWith(dbPath);
    expect(OllamaService).toHaveBeenCalledTimes(1);
    expect(DaemonManager).toHaveBeenCalledTimes(1);
    const opts = h.daemonInstances[0]!.opts as {
      tsConfigFilePath: string;
      lanceDbPath: string;
      verbose: boolean;
    };
    expect(opts.tsConfigFilePath).toBe(tsconfig);
    expect(opts.lanceDbPath).toBe(lancePath);
    expect(opts.verbose).toBe(true);
    expect(inspectProject(dir).watcher.status).toBe("running");
  });

  it("resuelve rutas por defecto cuando no se pasan db/lancedb", () => {
    const dir = createProjectDir("fg-default");
    const tsconfig = path.join(dir, "tsconfig.json");

    startForegroundWatcher(tsconfig, { verbose: false }, undefined, noopWatchLock());

    // Con paths.data por defecto (.lacoco) las rutas caen bajo el proyecto.
    expect(LaCoCoDatabase).toHaveBeenCalledTimes(1);
    const dbArg = (LaCoCoDatabase as unknown as MockInstance).mock.calls[0]![0] as string;
    expect(dbArg.endsWith("tensor.sqlite")).toBe(true);
    expect(dbArg.startsWith(dir)).toBe(true);
  });

  it("libera el lock y lanza si ya hay otro watcher con PID distinto", () => {
    const dir = createProjectDir("fg-busy");
    const tsconfig = path.join(dir, "tsconfig.json");
    const configured = configureProjectWatcher(dir, {
      tsconfig,
      dbPath: path.join(dir, "tensor.sqlite"),
      lanceDbPath: path.join(dir, "lancedb"),
    });
    // PID distinto al del runner y "activo" según el spy de process.kill.
    markWatcherRunning(configured.id, 999_999, ["node", "lacoco"]);

    const lock = noopWatchLock();
    const releaseSpy = vi.spyOn(lock, "release");

    expect(() =>
      startForegroundWatcher(tsconfig, { verbose: false }, undefined, lock),
    ).toThrow("Ya existe un watcher activo");
    expect(releaseSpy).toHaveBeenCalledTimes(1);
    expect(DaemonManager).not.toHaveBeenCalled();
  });

  it("el handler de shutdown detiene el daemon, marca stopped y sale con 0", async () => {
    const dir = createProjectDir("fg-shutdown");
    const tsconfig = path.join(dir, "tsconfig.json");

    startForegroundWatcher(tsconfig, { verbose: false }, undefined, noopWatchLock());
    const shutdown = latestSignalHandler("SIGINT");

    shutdown("SIGINT");
    // Segunda llamada: rama shuttingDown (no debe re-detener).
    shutdown("SIGINT");
    await flushMicrotasks();

    expect(h.daemonInstances[0]!.stop).toHaveBeenCalledTimes(1);
    expect(inspectProject(dir).watcher.status).toBe("stopped");
    expect(exitCalls).toContain(0);
  });

  it("marca error, registra el fallo y sale con 1 si el daemon no arranca", async () => {
    const dir = createProjectDir("fg-start-error");
    const tsconfig = path.join(dir, "tsconfig.json");
    h.daemonStartError = new Error("boom-arranque");

    startForegroundWatcher(tsconfig, { verbose: false }, undefined, noopWatchLock());
    await flushMicrotasks();

    expect(inspectProject(dir).watcher.status).toBe("error");
    expect(errs.join("\n")).toContain("Error fatal durante el arranque");
    expect(exitCalls).toContain(1);
  });

  it("adquiere su propio lock cuando no se le inyecta uno", () => {
    const dir = createProjectDir("fg-own-lock");
    const tsconfig = path.join(dir, "tsconfig.json");

    // Sin existingLock: startForegroundWatcher llama a acquireWatchLock real
    // (escribe en el XDG_STATE_HOME temporal) y arranca el daemon.
    startForegroundWatcher(tsconfig, { verbose: false });

    expect(DaemonManager).toHaveBeenCalledTimes(1);
    expect(inspectProject(dir).watcher.status).toBe("running");
  });
});
