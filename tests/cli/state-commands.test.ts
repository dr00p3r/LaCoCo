import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerStateCommands } from "../../src/cli/commands/state-commands.js";
import { registerCurrentProject } from "../../src/cli/state/project-registry.js";

// state-commands se apoya sólo en el config-store y el project-registry, ambos
// respaldados por archivos JSON baratos bajo XDG_*_HOME. Los ejercitamos con el
// estado REAL (sin mocks) sobre directorios temporales, replicando el patrón de
// state-store.test.ts. Sólo interceptamos console/process.exitCode.

let tempDir: string;
let previousCwd: string;
let previousConfigHome: string | undefined;
let previousStateHome: string | undefined;
let previousExitCode: number | undefined;
let logs: string[];
let errs: string[];

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "lacoco-state-cmd-"));
  previousCwd = process.cwd();
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  previousStateHome = process.env.XDG_STATE_HOME;
  previousExitCode = process.exitCode as number | undefined;

  process.env.XDG_CONFIG_HOME = path.join(tempDir, "config-home");
  process.env.XDG_STATE_HOME = path.join(tempDir, "state-home");
  process.exitCode = undefined;

  logs = [];
  errs = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(previousCwd);
  process.exitCode = previousExitCode;
  restoreEnv("XDG_CONFIG_HOME", previousConfigHome);
  restoreEnv("XDG_STATE_HOME", previousStateHome);
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------- Helpers ----------
function createProject(name: string): string {
  const dir = path.join(tempDir, name);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

/** Construye un program fresco con los comandos de estado registrados. */
async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerStateCommands(program);
  await program.parseAsync(["node", "cli", ...args]);
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ---------- init ----------
describe("state init", () => {
  it("registra el proyecto del cwd y muestra detalle en texto", async () => {
    const dir = createProject("app-init");
    process.chdir(dir);

    await run("init");

    expect(logs.join("\n")).toContain("app-init");
    expect(process.exitCode).toBeUndefined();
  });

  it("registra un project-path explícito y emite JSON con --json", async () => {
    const dir = createProject("app-init-json");

    await run("init", dir, "--json");

    const parsed = JSON.parse(logs[0]!) as { name: string; path: string };
    expect(parsed.name).toBe("app-init-json");
    expect(parsed.path).toContain("app-init-json");
  });
});

// ---------- status ----------
describe("state status", () => {
  it("muestra el estado de un proyecto registrado (texto)", async () => {
    const dir = createProject("app-status");
    registerCurrentProject(dir);

    await run("status", dir);

    expect(logs.join("\n")).toContain("app-status");
  });

  it("cae al cwd cuando no se pasa proyecto (JSON)", async () => {
    const dir = createProject("app-status-cwd");
    const record = registerCurrentProject(dir);
    process.chdir(dir);

    await run("status", "--json");

    const parsed = JSON.parse(logs[0]!) as { id: string };
    expect(parsed.id).toBe(record.id);
  });

  it("captura el error y marca exitCode=1 si el proyecto no existe", async () => {
    await run("status", "proyecto-inexistente");

    expect(process.exitCode).toBe(1);
    expect(errs.join("\n").length).toBeGreaterThan(0);
  });
});

// ---------- config list / get ----------
describe("state config list & get", () => {
  it("lista la configuración resuelta en tabla", async () => {
    await run("config", "list");

    const out = logs.join("\n");
    expect(out).toContain("KEY");
    expect(out).toContain("strategy.default");
  });

  it("lista la configuración en JSON con --json", async () => {
    await run("config", "list", "--json");

    const parsed = JSON.parse(logs[0]!) as Array<{ key: string }>;
    expect(parsed.some((e) => e.key === "strategy.default")).toBe(true);
  });

  it("resuelve una clave concreta en texto", async () => {
    await run("config", "get", "strategy.default");

    expect(logs.join("\n")).toMatch(/hybrid \(default\)/u);
  });

  it("resuelve una clave concreta en JSON", async () => {
    await run("config", "get", "strategy.default", "--json");

    const parsed = JSON.parse(logs[0]!) as { key: string; value: string; source: string };
    expect(parsed.key).toBe("strategy.default");
    expect(parsed.source).toBe("default");
  });

  it("captura clave inválida en get", async () => {
    await run("config", "get", "clave.que.no.existe");

    expect(process.exitCode).toBe(1);
    expect(errs.join("\n").length).toBeGreaterThan(0);
  });
});

// ---------- config set / unset ----------
describe("state config set & unset", () => {
  it("guarda una clave en el alcance local por defecto (texto)", async () => {
    const dir = createProject("cfg-set");
    process.chdir(dir);

    await run("config", "set", "timeout.ms", "1500");

    expect(logs.join("\n")).toContain("escrito en local");
    const file = JSON.parse(
      fs.readFileSync(path.join(dir, ".lacoco", "config.json"), "utf-8"),
    ) as { values: { timeout: { ms: number } } };
    expect(file.values.timeout.ms).toBe(1500);
  });

  it("guarda en el alcance global con --global y emite JSON", async () => {
    const dir = createProject("cfg-set-global");
    process.chdir(dir);

    await run("config", "set", "strategy.default", "agentic", "--global", "--json");

    const parsed = JSON.parse(logs[0]!) as { scope: string; entry: { value: string } };
    expect(parsed.scope).toBe("global");
    expect(parsed.entry.value).toBe("agentic");
  });

  it("rechaza --global y --local simultáneos", async () => {
    await run("config", "set", "timeout.ms", "100", "--global", "--local");

    expect(process.exitCode).toBe(1);
    expect(errs.join("\n")).toContain("Usa solo uno de --global o --local");
  });

  it("elimina una clave previamente escrita (unset)", async () => {
    const dir = createProject("cfg-unset");
    process.chdir(dir);

    await run("config", "set", "timeout.ms", "1500", "--local");
    logs.length = 0;
    await run("config", "unset", "timeout.ms", "--local");

    expect(logs.join("\n")).toContain("eliminado de local");
  });

  it("emite JSON en unset con --json", async () => {
    const dir = createProject("cfg-unset-json");
    process.chdir(dir);

    await run("config", "unset", "timeout.ms", "--local", "--json");

    const parsed = JSON.parse(logs[0]!) as { key: string; unset: boolean };
    expect(parsed.key).toBe("timeout.ms");
    expect(parsed.unset).toBe(true);
  });
});

// ---------- config path / keys ----------
describe("state config path & keys", () => {
  it("muestra la ruta local en texto", async () => {
    const dir = createProject("cfg-path");
    process.chdir(dir);

    await run("config", "path", "--local");

    expect(logs.join("\n")).toContain(path.join(".lacoco", "config.json"));
  });

  it("muestra la ruta global en JSON", async () => {
    await run("config", "path", "--global", "--json");

    const parsed = JSON.parse(logs[0]!) as { scope: string; path: string };
    expect(parsed.scope).toBe("global");
    expect(parsed.path.length).toBeGreaterThan(0);
  });

  it("lista todas las claves válidas", async () => {
    await run("config", "keys");

    expect(logs.join("\n")).toContain("strategy.default");
    expect(logs.join("\n")).toContain("agent.model");
  });
});

// ---------- project ----------
describe("state project", () => {
  it("lista proyectos registrados (texto y JSON)", async () => {
    const dir = createProject("proj-list");
    registerCurrentProject(dir);

    await run("project", "list");
    expect(logs.join("\n")).toContain("proj-list");

    logs.length = 0;
    await run("project", "list", "--json");
    const parsed = JSON.parse(logs[0]!) as Array<{ name: string }>;
    expect(parsed.some((p) => p.name === "proj-list")).toBe(true);
  });

  it("muestra el detalle de un proyecto (inspect, JSON)", async () => {
    const dir = createProject("proj-inspect");
    const record = registerCurrentProject(dir);

    await run("project", "inspect", dir, "--json");

    const parsed = JSON.parse(logs[0]!) as { id: string };
    expect(parsed.id).toBe(record.id);
  });

  it("elimina un proyecto por id (texto)", async () => {
    const dir = createProject("proj-remove");
    const record = registerCurrentProject(dir);

    await run("project", "remove", record.id);

    expect(logs.join("\n")).toContain("Proyecto eliminado");
  });

  it("elimina un proyecto y emite JSON con --json", async () => {
    const dir = createProject("proj-remove-json");
    const record = registerCurrentProject(dir);

    await run("project", "remove", record.id, "--json");

    const parsed = JSON.parse(logs[0]!) as { removed: { id: string } };
    expect(parsed.removed.id).toBe(record.id);
  });

  it("captura el error al eliminar un proyecto inexistente", async () => {
    await run("project", "remove", "no-existe");

    expect(process.exitCode).toBe(1);
    expect(errs.join("\n").length).toBeGreaterThan(0);
  });

  it("muestra la ruta del registro persistente", async () => {
    await run("project", "path");

    expect(logs.join("\n")).toContain(path.join("lacoco", "projects.json"));
  });
});
