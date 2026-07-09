import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SlmCache,
  defaultSlmCachePath,
  getSlmCacheKey,
  isSlmCacheEnabled,
  type FrozenEntry,
} from "./slm-cache.js";
import type { SanitizerOutput } from "../../../src/retriever/models/utilities/types.js";

function makeSanitizer(overrides: Partial<SanitizerOutput> = {}): SanitizerOutput {
  return {
    route: "RAG",
    clean_query: '"OrderService" OR "save"',
    embedding_input: "Depurar OrderService save",
    dimensions: ["CPG", "DTG"],
    intent: "debug",
    confidence: 0.92,
    ...overrides,
  };
}

function makeEntry(overrides: Partial<FrozenEntry> = {}): FrozenEntry {
  return {
    sanitizer: makeSanitizer(),
    grounding: null,
    duration_ms: 4500,
    ...overrides,
  };
}

describe("SlmCache", () => {
  let workdir: string;
  let cachePath: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "lacoco-slm-cache-"));
    cachePath = join(workdir, "slm-cache.json");
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    delete process.env.LACOCO_DISABLE_SLM_CACHE;
    delete process.env.LACOCO_SLM_CACHE_PATH;
    vi.restoreAllMocks();
  });

  it("recupera una entrada cacheada por (prompt, variant, model, schemaVersion)", () => {
    const cache = new SlmCache(cachePath, "qwen3:4b-instruct");
    cache.set("OrderService save falla", "baseline", makeEntry());

    const hit = cache.get("OrderService save falla", "baseline");
    expect(hit).not.toBeNull();
    expect(hit!.sanitizer.intent).toBe("debug");
    expect(hit!.duration_ms).toBe(4500);
  });

  it("persiste entre instancias y rehidrata al re-cargar el archivo", () => {
    const first = new SlmCache(cachePath, "qwen3:4b-instruct");
    first.set("prompt A", "grounded", makeEntry({
      sanitizer: makeSanitizer({ clean_query: '"A"' }),
      duration_ms: 5000,
    }));

    expect(existsSync(cachePath)).toBe(true);
    const reloaded = new SlmCache(cachePath, "qwen3:4b-instruct");
    expect(reloaded.size()).toBe(1);
    const hit = reloaded.get("prompt A", "grounded");
    expect(hit).not.toBeNull();
    expect(hit!.sanitizer.clean_query).toBe('"A"');
    expect(hit!.duration_ms).toBe(5000);
  });

  it("invalida entradas cuando cambia el modelo del intermediario", () => {
    const cache = new SlmCache(cachePath, "qwen2.5-coder:1.5b");
    cache.set("prompt X", "baseline", makeEntry());

    // Una nueva cache con un modelo distinto computa keys distintas → las
    // entradas guardadas con la clave vieja no son alcanzables vía get.
    const cacheWithDifferentModel = new SlmCache(cachePath, "qwen3:4b-instruct");
    expect(cacheWithDifferentModel.get("prompt X", "baseline")).toBeNull();
    // Una escritura con la nueva clave es independiente del legado.
    cacheWithDifferentModel.set("prompt X", "baseline", makeEntry());
    expect(cacheWithDifferentModel.get("prompt X", "baseline")).not.toBeNull();
  });

  it("invalida entradas cuando cambia el schemaVersion", () => {
    const cacheV1 = new SlmCache(cachePath, "qwen3:4b-instruct", 1);
    cacheV1.set("prompt Y", "baseline", makeEntry());
    const json = readFileSync(cachePath, "utf8");
    expect(json).toContain("duration_ms");

    // Bumpear schemaVersion: las entradas v1 no son visibles para una cache v2.
    const cacheV2 = new SlmCache(cachePath, "qwen3:4b-instruct", 2);
    expect(cacheV2.get("prompt Y", "baseline")).toBeNull();
  });

  it("getSlmCacheKey produce keys distintas para distintos variants", () => {
    const keyBase = getSlmCacheKey("prompt", "baseline", "model", 1);
    const keyGrounded = getSlmCacheKey("prompt", "grounded", "model", 1);
    expect(keyBase).not.toBe(keyGrounded);
    expect(keyBase).toMatch(/^[0-9a-f]{16}$/);
  });

  it("getSlmCacheKey produce keys distintas para distintos modelos", () => {
    const keyA = getSlmCacheKey("prompt", "baseline", "modelA", 1);
    const keyB = getSlmCacheKey("prompt", "baseline", "modelB", 1);
    expect(keyA).not.toBe(keyB);
  });

  it("ignora archivos corruptos y arranca con cache vacio", () => {
    const fs = require("node:fs") as typeof import("node:fs");
    fs.writeFileSync(cachePath, "{ not valid JSON", "utf8");
    const cache = new SlmCache(cachePath, "qwen3:4b-instruct");
    expect(cache.size()).toBe(0);
    cache.set("recover", "baseline", makeEntry());
    const reloaded = new SlmCache(cachePath, "qwen3:4b-instruct");
    expect(reloaded.get("recover", "baseline")).not.toBeNull();
  });

  it("defaultSlmCachePath respeta LACOCO_SLM_CACHE_PATH y resuelve relativo al cwd", () => {
    const customPath = join(workdir, "custom", "cache.json");
    process.env.LACOCO_SLM_CACHE_PATH = customPath;
    expect(defaultSlmCachePath("/tmp/whatever")).toBe(customPath);
  });

  it("defaultSlmCachePath usa workdir/cache/slm-cache.json por default", () => {
    const resolved = defaultSlmCachePath("/tmp/eval-workdir");
    expect(resolved).toBe("/tmp/eval-workdir/cache/slm-cache.json");
  });

  it("isSlmCacheEnabled responde a LACOCO_DISABLE_SLM_CACHE", () => {
    expect(isSlmCacheEnabled()).toBe(true);
    process.env.LACOCO_DISABLE_SLM_CACHE = "1";
    expect(isSlmCacheEnabled()).toBe(false);
  });
});
