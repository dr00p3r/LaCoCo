import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EmbeddingGenerator } from "../../src/embeddings/embedding-generator.js";
import { EmbeddingCache } from "../../src/embeddings/embedding-cache.js";

describe("EmbeddingGenerator.generateBatch", () => {
  let workdir: string;

  beforeEach(() => {
    workdir = mkdtempSync(join(tmpdir(), "lacoco-gen-batch-"));
    process.env.LACOCO_TEST_EMBEDDINGS = "1";
  });

  afterEach(() => {
    rmSync(workdir, { recursive: true, force: true });
    delete process.env.LACOCO_TEST_EMBEDDINGS;
    vi.restoreAllMocks();
  });

  it("devuelve un Float32Array por texto en el mismo orden", async () => {
    const gen = new EmbeddingGenerator(null);
    const texts = ["alpha", "beta", "gamma", "delta", "epsilon"];
    const result = await gen.generateBatch(texts);
    expect(result).toHaveLength(5);
    for (const vec of result) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(384);
    }
  });

  it("devuelve [] para input vacío", async () => {
    const gen = new EmbeddingGenerator(null);
    const result = await gen.generateBatch([]);
    expect(result).toEqual([]);
  });

  it("no consulta el cache cuando LACOCO_TEST_EMBEDDINGS=1", async () => {
    // El path determinista ignora el cache por diseño (tests baratos, repetibles).
    const cache = new EmbeddingCache(join(workdir, "embeddings.json"));
    const getSpy = vi.spyOn(cache, "get");
    const setSpy = vi.spyOn(cache, "set");
    const gen = new EmbeddingGenerator(cache);
    await gen.generateBatch(["a", "b"]);
    expect(getSpy).not.toHaveBeenCalled();
    expect(setSpy).not.toHaveBeenCalled();
  });
});
