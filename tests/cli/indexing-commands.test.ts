import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Estado compartido, elevado para poder referenciarlo desde las fábricas de vi.mock.
const h = vi.hoisted(() => ({
  graphIndex: vi.fn(),
  graphInstances: [] as Array<{ dbPath: string; tsconfigs: string[] }>,
  graphIndexError: null as Error | null,
  vectorsIndex: vi.fn(async () => undefined),
  vectorsInstances: [] as Array<{ lanceDbPath: string; tsconfigs: string[] }>,
  vectorsIndexError: null as Error | null,
  propsIndex: vi.fn(async () => undefined),
  propsInstances: [] as Array<{ lanceDbPath: string; tsconfigs: string[]; concurrency: number }>,
  ollamaAbort: vi.fn(),
  ollamaArgs: [] as unknown[][],
  hudStart: vi.fn(),
  hudStop: vi.fn(),
  hudEnabledArgs: [] as boolean[],
}));

// El HUD toca stderr/cursor; lo sustituimos por un doble que registra sus llamadas.
vi.mock("../../src/cli/banner/indexing-hud.js", () => ({
  createIndexingHud: vi.fn(() => ({
    start: h.hudStart,
    update: vi.fn(),
    log: vi.fn(),
    stop: h.hudStop,
  })),
  resolveHudEnabled: vi.fn((flagNoAnimation: boolean) => {
    h.hudEnabledArgs.push(flagNoAnimation);
    return false;
  }),
}));

// Los indexadores reales corren el compilador de TS y escriben SQLite/LanceDB;
// los sustituimos por dobles controlables que sólo registran su construcción.
vi.mock("../../src/indexer/graph-indexer.js", () => ({
  GraphIndexer: vi.fn(function (this: unknown, dbPath: string, tsconfigs: string[]) {
    h.graphInstances.push({ dbPath, tsconfigs });
    return {
      index: () => {
        h.graphIndex();
        if (h.graphIndexError) throw h.graphIndexError;
      },
    };
  }),
}));

vi.mock("../../src/indexer/vectors-indexer.js", () => ({
  VectorsIndexer: vi.fn(function (this: unknown, lanceDbPath: string, tsconfigs: string[]) {
    h.vectorsInstances.push({ lanceDbPath, tsconfigs });
    return {
      index: async () => {
        await h.vectorsIndex();
        if (h.vectorsIndexError) throw h.vectorsIndexError;
      },
    };
  }),
}));

vi.mock("../../src/indexer/propositions-indexer.js", () => ({
  PropositionsIndexer: vi.fn(function (
    this: unknown,
    lanceDbPath: string,
    tsconfigs: string[],
    _ollama: unknown,
    concurrency: number,
  ) {
    h.propsInstances.push({ lanceDbPath, tsconfigs, concurrency });
    return { index: () => h.propsIndex() };
  }),
}));

// OllamaService abriría conexiones HTTP; lo neutralizamos.
vi.mock("../../src/slms/ollama-service.js", () => ({
  OllamaService: vi.fn(function (this: unknown, ...args: unknown[]) {
    h.ollamaArgs.push(args);
    return { abort: h.ollamaAbort };
  }),
}));

import { GraphIndexer } from "../../src/indexer/graph-indexer.js";
import { VectorsIndexer } from "../../src/indexer/vectors-indexer.js";
import { PropositionsIndexer } from "../../src/indexer/propositions-indexer.js";
import { registerIndexingCommands } from "../../src/cli/commands/indexing-commands.js";
import { inspectProject } from "../../src/cli/state/project-registry.js";

let tempDir: string;
let previousCwd: string;
let previousStateHome: string | undefined;
let previousConfigHome: string | undefined;
let logs: string[];

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "lacoco-index-cmd-"));
  previousCwd = process.cwd();
  previousStateHome = process.env.XDG_STATE_HOME;
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_STATE_HOME = path.join(tempDir, "state-home");
  process.env.XDG_CONFIG_HOME = path.join(tempDir, "config-home");

  // Reinicia el estado compartido de los dobles.
  h.graphInstances.length = 0;
  h.vectorsInstances.length = 0;
  h.propsInstances.length = 0;
  h.ollamaArgs.length = 0;
  h.hudEnabledArgs.length = 0;
  h.graphIndexError = null;
  h.vectorsIndexError = null;
  vi.clearAllMocks();

  logs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(previousCwd);
  restoreEnv("XDG_STATE_HOME", previousStateHome);
  restoreEnv("XDG_CONFIG_HOME", previousConfigHome);
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------- Helpers ----------
/** Crea un proyecto con un tsconfig.json real que resolveIndexTarget pueda leer. */
function createProject(name: string): { dir: string; tsconfig: string } {
  const dir = path.join(tempDir, name);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"));
  const tsconfig = path.join(dir, "tsconfig.json");
  fs.writeFileSync(tsconfig, "{}\n", "utf-8");
  return { dir, tsconfig };
}

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerIndexingCommands(program);
  await program.parseAsync(["node", "cli", ...args]);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ---------- index_graph ----------
describe("index_graph", () => {
  it("indexa el grafo, registra el proyecto y lo marca como completado", async () => {
    const { dir, tsconfig } = createProject("graph-ok");
    const dbPath = path.join(dir, "salida.sqlite");

    await run("index_graph", tsconfig, "--db", dbPath);

    expect(GraphIndexer).toHaveBeenCalledTimes(1);
    expect(h.graphInstances[0]!.dbPath).toBe(dbPath);
    expect(h.graphInstances[0]!.tsconfigs).toEqual([tsconfig]);
    expect(h.graphIndex).toHaveBeenCalledTimes(1);
    // El proyecto quedó registrado en el estado persistente (registerCurrentProject).
    expect(inspectProject(dir).path.startsWith(fs.realpathSync.native(tempDir))).toBe(true);
  });

  it("usa la ruta SQLite por defecto cuando no se pasa --db", async () => {
    const { dir, tsconfig } = createProject("graph-default");

    await run("index_graph", tsconfig);

    const usedDb = h.graphInstances[0]!.dbPath;
    expect(usedDb.startsWith(dir)).toBe(true);
    expect(usedDb.endsWith("tensor.sqlite")).toBe(true);
  });

  it("marca error y propaga si el indexado del grafo falla", async () => {
    const { tsconfig } = createProject("graph-error");
    h.graphIndexError = new Error("boom-grafo");

    await expect(run("index_graph", tsconfig)).rejects.toThrow("boom-grafo");
    expect(h.graphIndex).toHaveBeenCalledTimes(1);
  });

  it("rechaza pasar argumento posicional y --project-dir a la vez", async () => {
    const { dir, tsconfig } = createProject("graph-both");

    await expect(run("index_graph", tsconfig, "--project-dir", dir)).rejects.toThrow(
      "Usa una sola ruta de indexacion",
    );
  });

  it("rechaza no indicar ninguna ruta de indexado", async () => {
    await expect(run("index_graph")).rejects.toThrow("Debes indicar un tsconfig");
  });
});

// ---------- index_vectors ----------
describe("index_vectors", () => {
  it("indexa vectores con la ruta LanceDB explícita", async () => {
    const { dir, tsconfig } = createProject("vec-ok");
    const lancedb = path.join(dir, "mi-lance");

    await run("index_vectors", tsconfig, "--lancedb", lancedb);

    expect(VectorsIndexer).toHaveBeenCalledTimes(1);
    expect(h.vectorsInstances[0]!.lanceDbPath).toBe(lancedb);
    expect(h.vectorsIndex).toHaveBeenCalledTimes(1);
  });

  it("resuelve --project-dir y cae a la ruta LanceDB por defecto", async () => {
    const { dir } = createProject("vec-default");

    await run("index_vectors", "--project-dir", dir);

    const usedLance = h.vectorsInstances[0]!.lanceDbPath;
    expect(usedLance.startsWith(dir)).toBe(true);
    expect(usedLance.endsWith("lancedb")).toBe(true);
  });

  it("marca error y propaga si el indexado de vectores rechaza", async () => {
    const { tsconfig } = createProject("vec-error");
    h.vectorsIndexError = new Error("boom-vectores");

    await expect(run("index_vectors", tsconfig)).rejects.toThrow("boom-vectores");
  });
});

// ---------- index_propositions ----------
describe("index_propositions", () => {
  it("construye Ollama + PropositionsIndexer y aborta Ollama al final", async () => {
    const { dir, tsconfig } = createProject("props-ok");
    const lancedb = path.join(dir, "lance-props");

    await run("index_propositions", tsconfig, "--lancedb", lancedb, "--ollama", "http://x:1");

    expect(PropositionsIndexer).toHaveBeenCalledTimes(1);
    expect(h.propsInstances[0]!.lanceDbPath).toBe(lancedb);
    expect(h.propsIndex).toHaveBeenCalledTimes(1);
    // El endpoint --ollama debe llegar como primer argumento del OllamaService.
    expect(h.ollamaArgs[0]![0]).toBe("http://x:1");
    // finally: siempre aborta el servicio Ollama.
    expect(h.ollamaAbort).toHaveBeenCalledTimes(1);
  });

  it("aborta Ollama incluso si el indexado de proposiciones falla", async () => {
    const { tsconfig } = createProject("props-error");
    h.propsIndex.mockRejectedValueOnce(new Error("boom-props"));

    await expect(run("index_propositions", tsconfig)).rejects.toThrow("boom-props");
    expect(h.ollamaAbort).toHaveBeenCalledTimes(1);
  });
});

// ---------- HUD de indexación ----------
describe("HUD de indexación", () => {
  it("arranca y para el HUD en index_graph (éxito)", async () => {
    const { tsconfig } = createProject("hud-graph-ok");
    await run("index_graph", tsconfig);
    expect(h.hudStart).toHaveBeenCalledTimes(1);
    expect(h.hudStop).toHaveBeenCalledTimes(1);
  });

  it("para el HUD aunque index_graph falle (finally)", async () => {
    const { tsconfig } = createProject("hud-graph-err");
    h.graphIndexError = new Error("boom");
    await expect(run("index_graph", tsconfig)).rejects.toThrow("boom");
    expect(h.hudStart).toHaveBeenCalledTimes(1);
    expect(h.hudStop).toHaveBeenCalledTimes(1);
  });

  it("arranca y para el HUD en index_vectors", async () => {
    const { tsconfig } = createProject("hud-vec-ok");
    await run("index_vectors", tsconfig);
    expect(h.hudStart).toHaveBeenCalledTimes(1);
    expect(h.hudStop).toHaveBeenCalledTimes(1);
  });

  it("--no-animation propaga la desactivación a resolveHudEnabled", async () => {
    const { tsconfig } = createProject("hud-noanim");
    await run("index_graph", tsconfig, "--no-animation");
    expect(h.hudEnabledArgs).toContain(true);
  });

  it("sin la bandera, resolveHudEnabled recibe false", async () => {
    const { tsconfig } = createProject("hud-anim");
    await run("index_vectors", tsconfig);
    expect(h.hudEnabledArgs).toContain(false);
  });
});
