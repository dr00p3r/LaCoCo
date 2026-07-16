import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Estado compartido de los dobles (elevado para las fábricas de vi.mock).
const h = vi.hoisted(() => ({
  sessionClose: vi.fn(async () => undefined),
  sessionOpenArgs: [] as unknown[],
  serverConnect: vi.fn(async () => undefined),
  serverConfig: null as unknown,
  transportInstances: 0,
}));

// El transporte stdio real toma control de stdin/stdout del proceso; lo
// sustituimos por un constructor vacío.
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(function (this: unknown) {
    h.transportInstances += 1;
    return {};
  }),
}));

// El servidor MCP real registra tools y abre el canal; doble con connect().
vi.mock("../../src/mcp/server.js", () => ({
  createLacocoMcpServer: vi.fn((config: unknown) => {
    h.serverConfig = config;
    return { connect: (...args: unknown[]) => h.serverConnect(...args) };
  }),
}));

// RetrievalSession abre SQLite/LanceDB; doble con close(). strategyHelp se usa en
// tiempo de registro y debe devolver string.
vi.mock("../../src/cli/pipeline.js", () => ({
  RetrievalSession: {
    open: (config: unknown) => {
      h.sessionOpenArgs.push(config);
      return { close: (...args: unknown[]) => h.sessionClose(...args) };
    },
  },
  strategyHelp: () => "estrategias: hybrid, agentic",
}));

import { registerMcpCommand } from "../../src/cli/commands/mcp-command.js";

let tempDir: string;
let previousCwd: string;
let previousStateHome: string | undefined;
let previousConfigHome: string | undefined;
let previousExitCode: number | undefined;
let errs: string[];
let exitCalls: Array<number | undefined>;
let baseSigint: NodeJS.SignalsListener[];
let baseSigterm: NodeJS.SignalsListener[];

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "lacoco-mcp-cmd-"));
  previousCwd = process.cwd();
  previousStateHome = process.env.XDG_STATE_HOME;
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  previousExitCode = process.exitCode as number | undefined;
  process.env.XDG_STATE_HOME = path.join(tempDir, "state-home");
  process.env.XDG_CONFIG_HOME = path.join(tempDir, "config-home");
  process.exitCode = undefined;
  process.chdir(tempDir);

  h.sessionOpenArgs.length = 0;
  h.serverConfig = null;
  h.transportInstances = 0;
  vi.clearAllMocks();
  h.sessionClose.mockResolvedValue(undefined);
  h.serverConnect.mockResolvedValue(undefined);

  errs = [];
  exitCalls = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    errs.push(chunk.toString());
    return true;
  }) as never);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCalls.push(code);
    return undefined as never;
  }) as never);

  // Capturamos los handlers de señal previos para restaurarlos (la acción MCP
  // registra SIGINT/SIGTERM).
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
  process.exitCode = previousExitCode;
  restoreEnv("XDG_STATE_HOME", previousStateHome);
  restoreEnv("XDG_CONFIG_HOME", previousConfigHome);
  rmSync(tempDir, { recursive: true, force: true });
});

// ---------- Helpers ----------
/** Crea el archivo SQLite en la ruta por defecto para un proyecto no registrado. */
function createIndexedDb(projectDir: string): string {
  const dbPath = path.join(projectDir, ".lacoco", "tensor.sqlite");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, "", "utf-8");
  return dbPath;
}

async function run(...args: string[]): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerMcpCommand(program);
  await program.parseAsync(["node", "cli", ...args]);
}

/** Devuelve el último handler de señal registrado (el shutdown del servidor). */
function latestSignalHandler(signal: "SIGINT" | "SIGTERM"): NodeJS.SignalsListener {
  const all = process.listeners(signal) as NodeJS.SignalsListener[];
  const handler = all[all.length - 1];
  if (!handler) throw new Error(`No hay handler registrado para ${signal}`);
  return handler;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ---------- mcp: proyecto no indexado ----------
describe("mcp — proyecto no indexado", () => {
  it("sale con código 1 y no abre sesión si no existe la DB", async () => {
    await run("mcp", tempDir);

    expect(process.exitCode).toBe(1);
    expect(errs.join("")).toContain("Proyecto no indexado");
    expect(h.sessionOpenArgs).toHaveLength(0);
    expect(h.serverConnect).not.toHaveBeenCalled();
  });
});

// ---------- mcp: arranque nominal ----------
describe("mcp — arranque del servidor", () => {
  it("abre sesión, conecta el servidor por stdio y anuncia disponibilidad", async () => {
    createIndexedDb(tempDir);

    await run("mcp", tempDir, "-s", "agentic", "--max-tokens", "1234");

    // Sesión abierta con la ruta db resuelta del proyecto.
    expect(h.sessionOpenArgs).toHaveLength(1);
    const openCfg = h.sessionOpenArgs[0] as { db: string };
    expect(openCfg.db).toBe(path.join(tempDir, ".lacoco", "tensor.sqlite"));

    // El servidor recibe los defaults resueltos (estrategia y max-tokens explícitos).
    const cfg = h.serverConfig as { defaultStrategy: string; defaultMaxTokens: number };
    expect(cfg.defaultStrategy).toBe("agentic");
    expect(cfg.defaultMaxTokens).toBe(1234);

    // Conectó el transporte stdio y anunció que está listo.
    expect(h.transportInstances).toBe(1);
    expect(h.serverConnect).toHaveBeenCalledTimes(1);
    expect(errs.join("")).toContain("Servidor lacoco listo");
  });

  it("el handler de apagado cierra la sesión y sale con 0 (idempotente)", async () => {
    createIndexedDb(tempDir);

    await run("mcp", tempDir);
    const shutdown = latestSignalHandler("SIGINT");

    shutdown("SIGINT");
    // Segunda invocación: la guarda `closing` evita re-cerrar.
    shutdown("SIGINT");
    await new Promise((resolve) => setImmediate(resolve));

    expect(h.sessionClose).toHaveBeenCalledTimes(1);
    expect(exitCalls).toContain(0);
  });
});
