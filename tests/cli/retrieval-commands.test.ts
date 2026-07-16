import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Estado compartido de los dobles (elevado para las fábricas de vi.mock).
const h = vi.hoisted(() => ({
  runContextExport: vi.fn(async () => 0),
  runRetrieve: vi.fn(async () => 0),
  inspect: vi.fn(async () => undefined),
  inspectQuery: vi.fn(async () => undefined),
}));

// El pipeline real abre SQLite/LanceDB y ejecuta el RAG; sustituimos las tres
// entradas que usa retrieval-commands. strategyHelp debe devolver un string
// porque se invoca en tiempo de registro del comando.
vi.mock("../../src/cli/pipeline.js", () => ({
  runContextExport: (...args: unknown[]) => h.runContextExport(...args),
  runRetrieve: (...args: unknown[]) => h.runRetrieve(...args),
  strategyHelp: () => "estrategias: hybrid, agentic",
}));

// inspect/inspectQuery renderizan HTML tras recorrer el grafo; los neutralizamos.
vi.mock("../../src/cli/inspect.js", () => ({
  inspect: (...args: unknown[]) => h.inspect(...args),
  inspectQuery: (...args: unknown[]) => h.inspectQuery(...args),
}));

import { registerRetrievalCommands } from "../../src/cli/commands/retrieval-commands.js";
import { registerCurrentProject } from "../../src/cli/state/project-registry.js";

let tempDir: string;
let previousCwd: string;
let previousStateHome: string | undefined;
let previousConfigHome: string | undefined;
let previousExitCode: number | undefined;
let errs: string[];

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "lacoco-retrieval-cmd-"));
  previousCwd = process.cwd();
  previousStateHome = process.env.XDG_STATE_HOME;
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  previousExitCode = process.exitCode as number | undefined;
  process.env.XDG_STATE_HOME = path.join(tempDir, "state-home");
  process.env.XDG_CONFIG_HOME = path.join(tempDir, "config-home");
  process.exitCode = undefined;
  process.chdir(tempDir);

  vi.clearAllMocks();
  h.runContextExport.mockResolvedValue(0);
  h.runRetrieve.mockResolvedValue(0);

  errs = [];
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(previousCwd);
  process.exitCode = previousExitCode;
  restoreEnv("XDG_STATE_HOME", previousStateHome);
  restoreEnv("XDG_CONFIG_HOME", previousConfigHome);
  rmSync(tempDir, { recursive: true, force: true });
});

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });
  registerRetrievalCommands(program);
  await program.parseAsync(["node", "cli", ...args]);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ---------- context export ----------
describe("context export", () => {
  it("delega en runContextExport con proyecto, query y --output", async () => {
    await run("context", "export", "mi-proyecto", "OrderService", "-o", "out.md");

    expect(h.runContextExport).toHaveBeenCalledTimes(1);
    const [query, , , , project] = h.runContextExport.mock.calls[0]!;
    expect(query).toBe("OrderService");
    expect(project).toBe("mi-proyecto");
    expect(process.exitCode).toBeUndefined();
  });

  it("propaga el exit code distinto de cero del pipeline", async () => {
    h.runContextExport.mockResolvedValueOnce(3);

    await run("context", "export", "proj", "q", "--output", "out.md");

    expect(process.exitCode).toBe(3);
  });

  it("falla si falta la opción requerida --output", async () => {
    await expect(run("context", "export", "proj", "q")).rejects.toThrow(/output/u);
  });
});

// ---------- retrieve ----------
describe("retrieve", () => {
  it("delega en runRetrieve con proyecto y query", async () => {
    await run("retrieve", "mi-proyecto", "OrderService");

    expect(h.runRetrieve).toHaveBeenCalledTimes(1);
    const [query, options, , , project] = h.runRetrieve.mock.calls[0]!;
    expect(query).toBe("OrderService");
    expect(project).toBe("mi-proyecto");
    expect((options as { json: boolean }).json).toBe(false);
  });

  it("propaga el exit code del pipeline en retrieve", async () => {
    h.runRetrieve.mockResolvedValueOnce(1);

    await run("retrieve", "proj", "q", "--json");

    expect(process.exitCode).toBe(1);
  });

  it("rechaza --chunks no entero positivo (InvalidArgumentError)", async () => {
    await expect(run("retrieve", "proj", "q", "--chunks", "0")).rejects.toThrow();
    expect(h.runRetrieve).not.toHaveBeenCalled();
  });
});

// ---------- inspect ----------
describe("inspect", () => {
  it("invoca inspect con budget y focus válidos", async () => {
    await run("inspect", "file1#OrderService", "-b", "10", "-f", "SYS", "-o", "grafo.html");

    expect(h.inspect).toHaveBeenCalledTimes(1);
    const opts = h.inspect.mock.calls[0]![0] as {
      rootNode: string;
      budget: number;
      focus: string;
      output: string;
    };
    expect(opts.rootNode).toBe("file1#OrderService");
    expect(opts.budget).toBe(10);
    expect(opts.focus).toBe("SYS");
    expect(opts.output).toBe("grafo.html");
  });

  it("normaliza un focus desconocido a ALL", async () => {
    await run("inspect", "n1", "-f", "ZZZ");

    const opts = h.inspect.mock.calls[0]![0] as { focus: string };
    expect(opts.focus).toBe("ALL");
  });

  it("aborta con budget inválido sin invocar inspect", async () => {
    await run("inspect", "n1", "-b", "cero");

    expect(h.inspect).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("--budget debe ser un número positivo");
  });
});

// ---------- inspect-query ----------
describe("inspect-query", () => {
  it("invoca inspectQuery resolviendo rutas del proyecto registrado", async () => {
    const dir = path.join(tempDir, "proj-reg");
    fs.mkdirSync(path.join(dir, "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, ".git"));
    const record = registerCurrentProject(dir);

    await run("inspect-query", record.id, "explica pedidos", "-m", "tensor");

    expect(h.inspectQuery).toHaveBeenCalledTimes(1);
    const opts = h.inspectQuery.mock.calls[0]![0] as {
      prompt: string;
      mode: string;
      db: string;
      lancedb: string;
    };
    expect(opts.prompt).toBe("explica pedidos");
    expect(opts.mode).toBe("tensor");
    // Las rutas se resuelven desde el path real del proyecto registrado.
    expect(opts.db.startsWith(fs.realpathSync.native(dir))).toBe(true);
    expect(opts.lancedb.startsWith(fs.realpathSync.native(dir))).toBe(true);
  });

  it("normaliza un modo desconocido a default y cae al cwd sin proyecto", async () => {
    // Sin project: commander toma la primera posición como [project]; para
    // ejercitar el fallback usamos un id que no existe → se usa como ruta.
    await run("inspect-query", "no-registrado", "un prompt", "-m", "raro");

    const opts = h.inspectQuery.mock.calls[0]![0] as { mode: string };
    expect(opts.mode).toBe("default");
  });

  it("aborta inspect-query con budget inválido", async () => {
    await run("inspect-query", "proj", "prompt", "-b", "-5");

    expect(h.inspectQuery).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });
});
