import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyEmbeddingEnv,
  checkEmbeddingConsistency,
  EMBEDDING_METADATA_FILENAME,
  embeddingEnv,
  readIndexEmbeddingMetadata,
  resolveEmbeddingProfile,
  writeIndexEmbeddingMetadata,
  type EmbeddingProfile,
} from "./embedding-profile.js";

const JINA: EmbeddingProfile = {
  model: "jinaai/jina-embeddings-v2-base-code",
  dim: 768,
  quantized: false,
};

describe("resolveEmbeddingProfile", () => {
  it("reads the embedding block from run.yaml", () => {
    const profile = resolveEmbeddingProfile({
      embedding: { model: "jinaai/jina-embeddings-v2-base-code", dim: 768, quantized: false },
    });
    expect(profile).toEqual(JINA);
  });

  it("throws when the embedding block is missing", () => {
    expect(() => resolveEmbeddingProfile({})).toThrow(/run\.yaml\.embedding/);
  });
});

describe("embeddingEnv / applyEmbeddingEnv", () => {
  const saved = {
    model: process.env.LACOCO_EMBEDDING_MODEL,
    dim: process.env.LACOCO_EMBEDDING_DIM,
    quantized: process.env.LACOCO_EMBEDDING_QUANTIZED,
  };
  afterEach(() => {
    process.env.LACOCO_EMBEDDING_MODEL = saved.model;
    process.env.LACOCO_EMBEDDING_DIM = saved.dim;
    process.env.LACOCO_EMBEDDING_QUANTIZED = saved.quantized;
  });

  it("maps the profile to LACOCO_EMBEDDING_* strings", () => {
    expect(embeddingEnv(JINA)).toEqual({
      LACOCO_EMBEDDING_MODEL: "jinaai/jina-embeddings-v2-base-code",
      LACOCO_EMBEDDING_DIM: "768",
      LACOCO_EMBEDDING_QUANTIZED: "false",
    });
  });

  it("sets process.env so subprocesses inherit the profile", () => {
    applyEmbeddingEnv(JINA);
    expect(process.env.LACOCO_EMBEDDING_MODEL).toBe("jinaai/jina-embeddings-v2-base-code");
    expect(process.env.LACOCO_EMBEDDING_DIM).toBe("768");
    expect(process.env.LACOCO_EMBEDDING_QUANTIZED).toBe("false");
  });
});

describe("index embedding metadata roundtrip", () => {
  it("writes and reads back the profile", () => {
    const dir = mkdtempSync(join(tmpdir(), "lacoco-emb-"));
    writeIndexEmbeddingMetadata(dir, JINA);
    const onDisk = JSON.parse(
      readFileSync(join(dir, EMBEDDING_METADATA_FILENAME), "utf8"),
    ) as Record<string, unknown>;
    expect(onDisk).toMatchObject({
      embedding_model: JINA.model,
      embedding_dim: JINA.dim,
      embedding_quantized: JINA.quantized,
    });
    expect(readIndexEmbeddingMetadata(dir)).toEqual({
      embedding_model: JINA.model,
      embedding_dim: JINA.dim,
      embedding_quantized: JINA.quantized,
    });
  });

  it("returns null when the index has no metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "lacoco-emb-empty-"));
    expect(readIndexEmbeddingMetadata(dir)).toBeNull();
  });
});

describe("checkEmbeddingConsistency", () => {
  it("passes when index metadata matches the profile", () => {
    const result = checkEmbeddingConsistency(JINA, {
      embedding_model: JINA.model,
      embedding_dim: JINA.dim,
      embedding_quantized: JINA.quantized,
    });
    expect(result).toEqual({ ok: true, mismatch: false, reason: null });
  });

  it("flags a real mismatch as blocking (MiniLM index under Jina profile)", () => {
    const result = checkEmbeddingConsistency(JINA, {
      embedding_model: "Xenova/all-MiniLM-L6-v2",
      embedding_dim: 384,
      embedding_quantized: true,
    });
    expect(result.ok).toBe(false);
    expect(result.mismatch).toBe(true);
    expect(result.reason).toContain("model");
    expect(result.reason).toContain("dim");
  });

  it("warns (not blocks) when index metadata is absent (legacy)", () => {
    const result = checkEmbeddingConsistency(JINA, null);
    expect(result.ok).toBe(true);
    expect(result.mismatch).toBe(false);
    expect(result.reason).toContain("legacy");
  });
});
