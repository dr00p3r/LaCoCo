import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Estado compartido de los dobles (elevado para las fábricas de vi.mock).
const h = vi.hoisted(() => ({
  dbClose: vi.fn(),
  ollamaAbort: vi.fn(),
  rebuildResult: { termCount: 3, aliasCount: 5, buildId: "build-123" } as {
    termCount: number;
    aliasCount: number;
    buildId: string;
  },
  rebuild: vi.fn(),
  groundResult: {
    candidates: [
      {
        canonicalTerm: "OrderService",
        matchedAliases: ["servicio de pedidos"],
        domains: [{ name: "business-logic" }],
      },
    ],
    durationMs: 4.2,
  } as unknown,
  ground: vi.fn(),
  storeState: {
    status: "ready",
    activeBuildId: "build-123",
    updatedAt: "2026-07-15T00:00:00.000Z",
    lastError: null as string | null,
    evidenceRevision: "rev-actual",
  },
  markStale: vi.fn(),
  extractHashes: ["h1", "h2"] as string[],
  computeRevision: "rev-actual",
}));

// LaCoCoDatabase abre SQLite real: doble que expone getRawDb/close.
vi.mock("../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js", () => ({
  LaCoCoDatabase: vi.fn(function (this: unknown) {
    return { getRawDb: () => ({ raw: true }), close: h.dbClose };
  }),
}));

// OllamaService abriría HTTP: doble con abort.
vi.mock("../../src/slms/ollama-service.js", () => ({
  OllamaService: vi.fn(function (this: unknown) {
    return { abort: h.ollamaAbort };
  }),
}));

// SemanticProfileBuilder corre el SLM por nodo (pesado); computeEvidenceRevision
// se re-exporta desde el mismo módulo.
vi.mock("../../src/semantic-profile/semantic-profile-builder.js", () => ({
  SemanticProfileBuilder: vi.fn(function (this: unknown) {
    return { rebuild: () => h.rebuild() };
  }),
  computeEvidenceRevision: vi.fn(() => h.computeRevision),
}));

// SemanticProfileStore lee/escribe el perfil: doble con getState/markStale.
vi.mock("../../src/semantic-profile/semantic-profile-store.js", () => ({
  SemanticProfileStore: vi.fn(function (this: unknown) {
    return { getState: () => h.storeState, markStale: h.markStale };
  }),
}));

// QueryGrounder recupera candidatos: doble que devuelve groundResult.
vi.mock("../../src/semantic-profile/query-grounder.js", () => ({
  QueryGrounder: vi.fn(function (this: unknown) {
    return { ground: (...args: unknown[]) => h.ground(...args) };
  }),
}));

// DeterministicTermExtractor recorre el grafo: doble con extract().
vi.mock("../../src/semantic-profile/deterministic-term-extractor.js", () => ({
  DeterministicTermExtractor: vi.fn(function (this: unknown) {
    return { extract: () => h.extractHashes.map((sourceHash) => ({ sourceHash })) };
  }),
}));

import { registerProfileCommands } from "../../src/cli/commands/profile-commands.js";

let tempDir: string;
let previousCwd: string;
let previousStateHome: string | undefined;
let previousConfigHome: string | undefined;
let previousExitCode: number | undefined;
let logs: string[];
let errs: string[];
let stdoutChunks: string[];

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "lacoco-profile-cmd-"));
  previousCwd = process.cwd();
  previousStateHome = process.env.XDG_STATE_HOME;
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  previousExitCode = process.exitCode as number | undefined;
  process.env.XDG_STATE_HOME = path.join(tempDir, "state-home");
  process.env.XDG_CONFIG_HOME = path.join(tempDir, "config-home");
  process.exitCode = undefined;
  process.chdir(tempDir);

  // Reinicia estado de los dobles.
  h.storeState = {
    status: "ready",
    activeBuildId: "build-123",
    updatedAt: "2026-07-15T00:00:00.000Z",
    lastError: null,
    evidenceRevision: "rev-actual",
  };
  h.computeRevision = "rev-actual";
  h.rebuild.mockResolvedValue(h.rebuildResult);
  h.ground.mockReturnValue(h.groundResult);
  vi.clearAllMocks();
  h.rebuild.mockResolvedValue(h.rebuildResult);
  h.ground.mockReturnValue(h.groundResult);

  logs = [];
  errs = [];
  stdoutChunks = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
    logs.push(a.map(String).join(" "));
  });
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    errs.push(a.map(String).join(" "));
  });
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stdoutChunks.push(chunk.toString());
    return true;
  }) as never);
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
  registerProfileCommands(program);
  await program.parseAsync(["node", "cli", ...args]);
  // Las acciones lanzan runCliCommand sin devolver la promesa (fire-and-forget);
  // cedemos un tick de macrotarea para que su cadena then/catch (y el finally que
  // libera DB/Ollama) termine antes de las aserciones.
  await new Promise((resolve) => setImmediate(resolve));
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// ---------- profile rebuild ----------
describe("profile rebuild", () => {
  it("reconstruye el perfil e imprime el resumen en texto", async () => {
    await run("profile", "rebuild");

    expect(h.rebuild).toHaveBeenCalledTimes(1);
    expect(logs.join("\n")).toContain("3 términos");
    expect(logs.join("\n")).toContain("build build-123");
    // finally: cierra la DB y aborta Ollama.
    expect(h.ollamaAbort).toHaveBeenCalledTimes(1);
    expect(h.dbClose).toHaveBeenCalledTimes(1);
  });

  it("emite el resultado en JSON con --json", async () => {
    await run("profile", "rebuild", "--json");

    const parsed = JSON.parse(stdoutChunks.join("")) as {
      ok: boolean;
      termCount: number;
      buildId: string;
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.termCount).toBe(3);
    expect(parsed.buildId).toBe("build-123");
  });

  it("captura el fallo del builder y aún así libera recursos", async () => {
    h.rebuild.mockRejectedValueOnce(new Error("boom-rebuild"));

    await run("profile", "rebuild");

    expect(process.exitCode).toBe(1);
    expect(errs.join("\n").length).toBeGreaterThan(0);
    expect(h.ollamaAbort).toHaveBeenCalledTimes(1);
    expect(h.dbClose).toHaveBeenCalledTimes(1);
  });
});

// ---------- profile ground ----------
describe("profile ground", () => {
  it("recupera candidatos e imprime el resumen en texto", async () => {
    // `[project] <query>`: commander asigna posicionalmente, así que pasamos ambos.
    await run("profile", "ground", "mi-proyecto", "servicio de pedidos");

    expect(h.ground).toHaveBeenCalledTimes(1);
    // El límite por defecto (20) llega como topTerms.
    expect(h.ground).toHaveBeenCalledWith("servicio de pedidos", { topTerms: 20 });
    const out = logs.join("\n");
    expect(out).toContain("1 candidatos");
    expect(out).toContain("OrderService");
    expect(out).toContain("servicio de pedidos");
    expect(h.dbClose).toHaveBeenCalledTimes(1);
  });

  it("respeta --limit y emite JSON con --json", async () => {
    await run("profile", "ground", "mi-proyecto", "pedidos", "--limit", "5", "--json");

    expect(h.ground).toHaveBeenCalledWith("pedidos", { topTerms: 5 });
    const parsed = JSON.parse(stdoutChunks.join("")) as { query: string; schemaVersion: number };
    expect(parsed.query).toBe("pedidos");
    expect(parsed.schemaVersion).toBe(1);
  });

  it("rechaza --limit no positivo", async () => {
    await expect(run("profile", "ground", "mi-proyecto", "pedidos", "--limit", "0")).rejects.toThrow(
      "--limit debe ser un entero positivo",
    );
  });
});

// ---------- profile status ----------
describe("profile status", () => {
  it("muestra el estado del perfil en texto", async () => {
    await run("profile", "status");

    const out = logs.join("\n");
    expect(out).toContain("Project Semantic Profile: ready");
    expect(out).toContain("Build: build-123");
    // Sin --verify no se recalcula el fingerprint.
    expect(h.markStale).not.toHaveBeenCalled();
    expect(h.dbClose).toHaveBeenCalledTimes(1);
  });

  it("imprime lastError cuando el estado lo trae (texto)", async () => {
    h.storeState = { ...h.storeState, status: "error", lastError: "algo falló" };

    await run("profile", "status");

    expect(logs.join("\n")).toContain("Error: algo falló");
  });

  it("con --verify y revisión distinta marca el perfil como stale", async () => {
    h.computeRevision = "rev-nueva"; // difiere de storeState.evidenceRevision

    await run("profile", "status", "--verify");

    expect(h.markStale).toHaveBeenCalledTimes(1);
  });

  it("con --verify y revisión igual NO marca stale", async () => {
    h.computeRevision = "rev-actual"; // coincide

    await run("profile", "status", "--verify");

    expect(h.markStale).not.toHaveBeenCalled();
  });

  it("emite el estado en JSON con --json", async () => {
    await run("profile", "status", "--json");

    const parsed = JSON.parse(stdoutChunks.join("")) as { status: string; schemaVersion: number };
    expect(parsed.status).toBe("ready");
    expect(parsed.schemaVersion).toBe(1);
  });
});
