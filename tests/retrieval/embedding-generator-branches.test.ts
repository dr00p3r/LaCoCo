import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock de transformers.js: evita descargar el modelo real (~80MB / red).
// `pipeline` devuelve un modelo falso controlable por test; `env` es un objeto
// inspeccionable para verificar el modo offline. Se declara vía vi.hoisted para
// que las referencias existan cuando vi.mock (hoisted) evalúa su factory.
const mocks = vi.hoisted(() => ({
  pipeline: vi.fn(),
  fakeModel: vi.fn(),
  env: {} as Record<string, unknown>,
}));

vi.mock("@xenova/transformers", () => ({
  pipeline: mocks.pipeline,
  env: mocks.env,
}));

import { EmbeddingGenerator } from "../../src/embeddings/embedding-generator.js";
import { EmbeddingCache } from "../../src/embeddings/embedding-cache.js";
import { EMBEDDING_DIM } from "../../src/embeddings/embedding-config.js";

describe("EmbeddingGenerator — ramas del modelo real (mock de pipeline)", () => {
  let workdir: string;
  let cachePath: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "lacoco-gen-branches-"));
    cachePath = join(workdir, "cache.json");
    // Estas pruebas ejercen el path del modelo, no el determinista.
    delete process.env.LACOCO_TEST_EMBEDDINGS;
    // Por defecto, pipeline resuelve al modelo falso.
    mocks.pipeline.mockReset();
    mocks.fakeModel.mockReset();
    mocks.pipeline.mockResolvedValue(mocks.fakeModel);
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    delete process.env.LACOCO_TEST_EMBEDDINGS;
    delete process.env.LACOCO_DISABLE_EMBEDDING_CACHE;
    delete process.env.LACOCO_EMBEDDING_CACHE_PATH;
    vi.restoreAllMocks();
  });

  // ---- generate(): cache hit vs miss ----

  it("generate devuelve el vector cacheado sin invocar el modelo (cache hit)", async () => {
    // Arrange: se pre-carga el cache con un vector conocido.
    const cache = new EmbeddingCache(cachePath);
    cache.set("hola", new Float32Array([9, 8, 7]));
    const gen = new EmbeddingGenerator(cache);

    // Act
    const vec = await gen.generate("hola");

    // Assert: se sirvió desde cache y el modelo nunca se cargó.
    expect(Array.from(vec)).toEqual([9, 8, 7]);
    expect(mocks.pipeline).not.toHaveBeenCalled();
    expect(mocks.fakeModel).not.toHaveBeenCalled();
  });

  it("generate invoca el modelo en cache miss y persiste el resultado", async () => {
    // Arrange: modelo falso que devuelve un vector de 3 dims.
    mocks.fakeModel.mockResolvedValue({ data: [0.1, 0.2, 0.3] });
    const cache = new EmbeddingCache(cachePath);
    const gen = new EmbeddingGenerator(cache);

    // Act
    const vec = await gen.generate("nuevo");

    // Assert: vector del modelo + guardado en cache.
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec[0]).toBeCloseTo(0.1, 6);
    expect(vec[2]).toBeCloseTo(0.3, 6);
    expect(mocks.fakeModel).toHaveBeenCalledTimes(1);
    const stored = cache.get("nuevo");
    expect(stored).not.toBeNull();

    // Segunda llamada: hit de cache, el modelo NO se vuelve a invocar.
    await gen.generate("nuevo");
    expect(mocks.fakeModel).toHaveBeenCalledTimes(1);
  });

  it("generate funciona con cache=null (nunca consulta ni guarda cache)", async () => {
    // Arrange
    mocks.fakeModel.mockResolvedValue({ data: [1, 0, 0] });
    const gen = new EmbeddingGenerator(null);

    // Act
    const vec = await gen.generate("sin-cache");

    // Assert
    expect(Array.from(vec)).toEqual([1, 0, 0]);
    expect(mocks.fakeModel).toHaveBeenCalledTimes(1);
  });

  // ---- generateBatch(): rutas del modelo ----

  it("generateBatch invoca el modelo UNA vez y trocea el tensor por texto", async () => {
    // Arrange: tensor flat de 2 filas × 3 dims.
    mocks.fakeModel.mockResolvedValue({ data: [1, 2, 3, 4, 5, 6], dims: [2, 3] });
    const cache = new EmbeddingCache(cachePath);
    const gen = new EmbeddingGenerator(cache);

    // Act
    const result = await gen.generateBatch(["uno", "dos"]);

    // Assert: cada slice corresponde a su fila y se cacheó.
    expect(result).toHaveLength(2);
    expect(Array.from(result[0]!)).toEqual([1, 2, 3]);
    expect(Array.from(result[1]!)).toEqual([4, 5, 6]);
    expect(mocks.fakeModel).toHaveBeenCalledTimes(1);
    expect(cache.get("uno")).not.toBeNull();
    expect(cache.get("dos")).not.toBeNull();
  });

  it("generateBatch mezcla hits de cache con textos faltantes", async () => {
    // Arrange: "uno" ya está en cache; solo "dos" debe ir al modelo.
    const cache = new EmbeddingCache(cachePath);
    cache.set("uno", new Float32Array([7, 7, 7]));
    mocks.fakeModel.mockResolvedValue({ data: [4, 5, 6], dims: [1, 3] });
    const gen = new EmbeddingGenerator(cache);

    // Act
    const result = await gen.generateBatch(["uno", "dos"]);

    // Assert: solo el faltante se pasó al modelo, en el orden original.
    expect(Array.from(result[0]!)).toEqual([7, 7, 7]);
    expect(Array.from(result[1]!)).toEqual([4, 5, 6]);
    expect(mocks.fakeModel).toHaveBeenCalledTimes(1);
    expect(mocks.fakeModel).toHaveBeenCalledWith(["dos"], expect.any(Object));
  });

  it("generateBatch con todo cacheado no invoca el modelo (early return)", async () => {
    // Arrange
    const cache = new EmbeddingCache(cachePath);
    cache.set("a", new Float32Array([1, 1, 1]));
    cache.set("b", new Float32Array([2, 2, 2]));
    const gen = new EmbeddingGenerator(cache);

    // Act
    const result = await gen.generateBatch(["a", "b"]);

    // Assert
    expect(Array.from(result[0]!)).toEqual([1, 1, 1]);
    expect(Array.from(result[1]!)).toEqual([2, 2, 2]);
    expect(mocks.pipeline).not.toHaveBeenCalled();
    expect(mocks.fakeModel).not.toHaveBeenCalled();
  });

  it("generateBatch degrada a vectores vacíos si el modelo lanza error", async () => {
    // Arrange: el modelo rechaza; se silencia el console.error esperado.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.fakeModel.mockRejectedValue(new Error("boom"));
    const gen = new EmbeddingGenerator(null);

    // Act
    const result = await gen.generateBatch(["z"]);

    // Assert: no rompe al consumidor; devuelve Float32Array vacío.
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(result[0]!.length).toBe(0);
    expect(errSpy).toHaveBeenCalled();
  });

  it("generateBatch degrada a vectores vacíos si las dims son inesperadas", async () => {
    // Arrange: dims[0] (1) no coincide con nº de textos (2).
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.fakeModel.mockResolvedValue({ data: [1, 2, 3], dims: [1, 3] });
    const gen = new EmbeddingGenerator(null);

    // Act
    const result = await gen.generateBatch(["p", "q"]);

    // Assert
    expect(result).toHaveLength(2);
    expect(result[0]!.length).toBe(0);
    expect(result[1]!.length).toBe(0);
    expect(errSpy).toHaveBeenCalled();
  });

  it("generateBatch degrada a vectores vacíos si falta dims por completo", async () => {
    // Arrange: sin dims → misma rama de guarda.
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.fakeModel.mockResolvedValue({ data: [1, 2, 3] });
    const gen = new EmbeddingGenerator(null);

    // Act
    const result = await gen.generateBatch(["solo"]);

    // Assert
    expect(result[0]!.length).toBe(0);
    expect(errSpy).toHaveBeenCalled();
  });

  // ---- dispose(): libera el modelo cacheado ----

  it("dispose fuerza recarga del modelo en la siguiente generación", async () => {
    // Arrange
    mocks.fakeModel.mockResolvedValue({ data: [0.5, 0.5, 0.5] });
    const gen = new EmbeddingGenerator(null);

    // Act + Assert: primera carga = 1 llamada a pipeline.
    await gen.generate("t1");
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);

    // Sin dispose, se reutiliza (sigue en 1).
    await gen.generate("t2");
    expect(mocks.pipeline).toHaveBeenCalledTimes(1);

    // Tras dispose, la siguiente generación recarga (2).
    gen.dispose();
    await gen.generate("t3");
    expect(mocks.pipeline).toHaveBeenCalledTimes(2);
  });

  // ---- Constructor: default param (cache habilitada vs deshabilitada) ----

  it("constructor por defecto crea cache cuando está habilitada", async () => {
    // Arrange: cache habilitada por defecto; se redirige el path a temp para
    // no ensuciar el repo. En path determinista el cache no se toca, así que
    // basta con verificar que se construye sin error.
    process.env.LACOCO_EMBEDDING_CACHE_PATH = join(workdir, "default.json");
    delete process.env.LACOCO_DISABLE_EMBEDDING_CACHE;

    // Act
    const gen = new EmbeddingGenerator();
    mocks.fakeModel.mockResolvedValue({ data: [0.2, 0.2, 0.2] });
    const vec = await gen.generate("con-cache-default");

    // Assert
    expect(vec).toBeInstanceOf(Float32Array);
  });

  it("constructor por defecto usa cache=null cuando está deshabilitada", async () => {
    // Arrange
    process.env.LACOCO_DISABLE_EMBEDDING_CACHE = "1";
    mocks.fakeModel.mockResolvedValue({ data: [0.3, 0.3, 0.3] });

    // Act
    const gen = new EmbeddingGenerator();
    const vec = await gen.generate("sin-cache-default");

    // Assert
    expect(Array.from(vec)).toEqual([expect.closeTo(0.3, 6), expect.closeTo(0.3, 6), expect.closeTo(0.3, 6)]);
  });

  // ---- Path determinista de test ----

  it("generate en modo determinista devuelve vector normalizado de 384 dims sin modelo", async () => {
    // Arrange
    process.env.LACOCO_TEST_EMBEDDINGS = "1";
    const gen = new EmbeddingGenerator(null);

    // Act
    const vec = await gen.generate("determinista");

    // Assert: 384 dims, norma L2 ≈ 1, y no se cargó el modelo.
    expect(vec.length).toBe(EMBEDDING_DIM);
    let norm = 0;
    for (const v of vec) norm += v * v;
    expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
    expect(mocks.pipeline).not.toHaveBeenCalled();
  });

  it("generate determinista con texto vacío evita división por cero (norma=0)", async () => {
    // Arrange: texto vacío → vector de ceros → norma 0 → fallback `|| 1`.
    process.env.LACOCO_TEST_EMBEDDINGS = "1";
    const gen = new EmbeddingGenerator(null);

    // Act
    const vec = await gen.generate("");

    // Assert: no hay NaN (no dividió por 0); vector de ceros de 384 dims.
    expect(vec.length).toBe(EMBEDDING_DIM);
    expect(Array.from(vec).every((v) => v === 0)).toBe(true);
  });

  it("generate determinista es estable para el mismo texto", async () => {
    // Arrange
    process.env.LACOCO_TEST_EMBEDDINGS = "1";
    const gen = new EmbeddingGenerator(null);

    // Act
    const a = await gen.generate("igual");
    const b = await gen.generate("igual");

    // Assert
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});

// El flag de modo offline se evalúa a nivel de módulo (una sola vez al importar),
// así que se prueba con un import fresco tras setear la variable.
describe("EmbeddingGenerator — modo offline (LACOCO_EMBEDDINGS_OFFLINE)", () => {
  afterEach(() => {
    delete process.env.LACOCO_EMBEDDINGS_OFFLINE;
    vi.resetModules();
  });

  it("deshabilita modelos remotos cuando LACOCO_EMBEDDINGS_OFFLINE=1", async () => {
    // Arrange: estado limpio + flag activo.
    mocks.env.allowRemoteModels = true;
    process.env.LACOCO_EMBEDDINGS_OFFLINE = "1";
    vi.resetModules();

    // Act: import fresco re-ejecuta el bloque de nivel de módulo.
    await import("../../src/embeddings/embedding-generator.js");

    // Assert
    expect(mocks.env.allowRemoteModels).toBe(false);
  });
});
