import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getConfigPath,
  resolveConfig,
  setConfig,
} from "../../src/cli/state/config-store.js";

// Ramas del config-store centradas en validación, parseo y casteo de valores
// almacenados. Reusa el patrón de state-store.test.ts: XDG_CONFIG_HOME temporal
// + chdir a un proyecto para que el alcance "local" apunte a un .lacoco aislado.

let tempDir: string;
let previousCwd: string;
let previousConfigHome: string | undefined;
const touchedEnv = new Map<string, string | undefined>();

beforeEach(() => {
  tempDir = mkdtempSync(path.join(tmpdir(), "lacoco-cfg-branches-"));
  previousCwd = process.cwd();
  previousConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = path.join(tempDir, "config-home");
  touchedEnv.clear();
});

afterEach(() => {
  process.chdir(previousCwd);
  restoreEnv("XDG_CONFIG_HOME", previousConfigHome);
  for (const [key, value] of touchedEnv) restoreEnv(key, value);
  rmSync(tempDir, { recursive: true, force: true });
});

function createProject(name: string): string {
  const dir = path.join(tempDir, name);
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.mkdirSync(path.join(dir, ".git"));
  return dir;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

/** Fija una variable de entorno recordando su valor previo para restaurarla. */
function setEnv(key: string, value: string): void {
  if (!touchedEnv.has(key)) touchedEnv.set(key, process.env[key]);
  process.env[key] = value;
}

/** Escribe un archivo de configuración local crudo (sin pasar por setConfig). */
function writeLocalConfig(dir: string, values: unknown, version = 1): void {
  const file = path.join(dir, ".lacoco", "config.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ version, values }), "utf-8");
}

describe("config-store — validación al escribir (parseConfigValue)", () => {
  it("rechaza agent.endpoint vacío o solo espacios", () => {
    const dir = createProject("endpoint");
    process.chdir(dir);
    // Arrange/Act/Assert — el trim deja cadena vacía → rama de error.
    expect(() => setConfig("agent.endpoint", "   ", "local")).toThrow(
      "agent.endpoint debe ser una URL no vacía",
    );
  });

  it("rechaza agent.model vacío", () => {
    const dir = createProject("model");
    process.chdir(dir);
    expect(() => setConfig("agent.model", "  ", "local")).toThrow(
      "agent.model debe ser un nombre no vacío",
    );
  });

  it("acepta context.template 'v2' y rechaza un valor desconocido", () => {
    const dir = createProject("template");
    process.chdir(dir);
    // Rama válida (v2).
    expect(() => setConfig("context.template", "v2", "local")).not.toThrow();
    expect(resolveConfig("context.template")).toMatchObject({ value: "v2", source: "local" });
    // Rama de error (ni v1 ni v2).
    expect(() => setConfig("context.template", "v3", "local")).toThrow(
      "context.template debe ser 'v1'",
    );
  });

  it("acepta retrieval.annDimSource 'edge' y rechaza un origen inválido", () => {
    const dir = createProject("dim");
    process.chdir(dir);
    expect(() => setConfig("retrieval.annDimSource", "edge", "local")).not.toThrow();
    expect(() => setConfig("retrieval.annDimSource", "bogus", "local")).toThrow(
      "retrieval.annDimSource debe ser",
    );
  });

  it("valida retrieval.annOverfetch entero en [1,5] cubriendo cada corte", () => {
    const dir = createProject("overfetch");
    process.chdir(dir);
    // Rama válida (todos los operandos true).
    expect(() => setConfig("retrieval.annOverfetch", "3", "local")).not.toThrow();
    expect(resolveConfig("retrieval.annOverfetch")).toMatchObject({ value: 3 });
    // isInteger false (NaN).
    expect(() => setConfig("retrieval.annOverfetch", "abc", "local")).toThrow("entero entre 1 y 5");
    // isInteger false (fraccional).
    expect(() => setConfig("retrieval.annOverfetch", "1.5", "local")).toThrow("entero entre 1 y 5");
    // >= 1 false.
    expect(() => setConfig("retrieval.annOverfetch", "0", "local")).toThrow("entero entre 1 y 5");
    // <= 5 false.
    expect(() => setConfig("retrieval.annOverfetch", "6", "local")).toThrow("entero entre 1 y 5");
  });

  it("valida context.maxTokens entero positivo", () => {
    const dir = createProject("maxtokens");
    process.chdir(dir);
    expect(() => setConfig("context.maxTokens", "0", "local")).toThrow("entero positivo");
    expect(() => setConfig("context.maxTokens", "2.5", "local")).toThrow("entero positivo");
    expect(() => setConfig("context.maxTokens", "8000", "local")).not.toThrow();
  });

  it("valida watcher.debounceMs entero >= 0 (acepta cero, rechaza negativo)", () => {
    const dir = createProject("debounce");
    process.chdir(dir);
    // Cero es válido (>= 0).
    expect(() => setConfig("watcher.debounceMs", "0", "local")).not.toThrow();
    // Negativo rechazado.
    expect(() => setConfig("watcher.debounceMs", "-1", "local")).toThrow("mayor o igual a cero");
    // No entero rechazado.
    expect(() => setConfig("watcher.debounceMs", "1.5", "local")).toThrow("mayor o igual a cero");
  });

  it("valida profile.enrichConcurrency entero positivo", () => {
    const dir = createProject("concurrency");
    process.chdir(dir);
    expect(() => setConfig("profile.enrichConcurrency", "0", "local")).toThrow("entero positivo");
    expect(() => setConfig("profile.enrichConcurrency", "8", "local")).not.toThrow();
  });
});

describe("config-store — parseo de booleanos", () => {
  it("acepta todas las formas truthy y falsy (case-insensitive)", () => {
    const dir = createProject("bool");
    process.chdir(dir);
    for (const truthy of ["true", "1", "yes", "on", "TRUE", "On"]) {
      setConfig("retrieval.propositions", truthy, "local");
      expect(resolveConfig("retrieval.propositions")).toMatchObject({ value: true });
    }
    for (const falsy of ["false", "0", "no", "off", "FALSE", "Off"]) {
      setConfig("retrieval.propositions", falsy, "local");
      expect(resolveConfig("retrieval.propositions")).toMatchObject({ value: false });
    }
  });

  it("rechaza una forma booleana no reconocida", () => {
    const dir = createProject("bool-bad");
    process.chdir(dir);
    expect(() => setConfig("retrieval.propositions", "maybe", "local")).toThrow(
      "debe ser booleano",
    );
  });

  it("parsea el booleano desde variable de entorno (fuente env)", () => {
    setEnv("LACOCO_PROPOSITIONS", "1");
    expect(resolveConfig("retrieval.propositions")).toMatchObject({ value: true, source: "env" });
  });

  it("lanza al leer un booleano mal formado desde variable de entorno", () => {
    setEnv("LACOCO_PROPOSITIONS", "quizas");
    expect(() => resolveConfig("retrieval.propositions")).toThrow("debe ser booleano");
  });
});

describe("config-store — valores almacenados (castStoredValue) y archivo corrupto", () => {
  it("lanza cuando el valor almacenado tiene un tipo distinto al esperado", () => {
    const dir = createProject("cast-type");
    process.chdir(dir);
    // timeout.ms es number; el archivo guarda un string → castStoredValue lanza.
    writeLocalConfig(dir, { timeout: { ms: "no-soy-numero" } });
    expect(() => resolveConfig("timeout.ms")).toThrow("se esperaba number");
  });

  it("lanza cuando el valor almacenado es del tipo correcto pero inválido", () => {
    const dir = createProject("cast-validate");
    process.chdir(dir);
    // Número válido de tipo, pero <= 0 → falla la validación en castStoredValue.
    writeLocalConfig(dir, { timeout: { ms: -5 } });
    expect(() => resolveConfig("timeout.ms")).toThrow("timeout.ms debe ser un entero positivo");
  });

  it("resuelve un valor almacenado válido (rama sin error del casteo)", () => {
    const dir = createProject("cast-ok");
    process.chdir(dir);
    writeLocalConfig(dir, { timeout: { ms: 1234 } });
    expect(resolveConfig("timeout.ms")).toMatchObject({ value: 1234, source: "local" });
  });

  it("lanza ante una versión de configuración no soportada", () => {
    const dir = createProject("bad-version");
    process.chdir(dir);
    writeLocalConfig(dir, {}, 2);
    expect(() => resolveConfig("timeout.ms")).toThrow("Configuración corrupta");
  });

  it("lanza cuando 'values' no es un objeto", () => {
    const dir = createProject("bad-values");
    process.chdir(dir);
    const file = getConfigPath("local");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, values: null }), "utf-8");
    expect(() => resolveConfig("timeout.ms")).toThrow("Configuración corrupta");
  });
});
