/**
 * embedding-profile — fuente de verdad ÚNICA del modelo de embeddings del eval.
 *
 * El modelo/dim/quantized se declaran en `run.yaml` (`embedding:`) y se propagan
 * como variables de entorno (`LACOCO_EMBEDDING_*`, ver
 * `src/embeddings/embedding-config.ts`) a TODOS los procesos que indexan y que
 * recuperan. Antes se exportaban a mano en la línea de comando y **se caían en
 * silencio** (el classifier de permisos las cortó en un smoke) → el run usaba
 * MiniLM/384 creyendo que usaba Jina/768, produciendo números silenciosamente
 * inválidos. Centralizar aquí elimina ese modo de fallo.
 *
 * Además persiste la metadata junto al índice (`embedding.json`) para poder
 * VERIFICAR, al recuperar, que el índice se construyó con el mismo modelo que
 * declara el run (un query-MiniLM sobre índice-Jina no da error, solo basura).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { asBoolean, asNumber, asRecord, asString } from "./config.js";

export interface EmbeddingProfile {
  model: string;
  dim: number;
  quantized: boolean;
}

/** Nombre del archivo de metadata escrito junto al índice. */
export const EMBEDDING_METADATA_FILENAME = "embedding.json";

/** Lee el perfil de embedding declarado en run.yaml (`embedding:` top-level). */
export function resolveEmbeddingProfile(runManifest: Record<string, unknown>): EmbeddingProfile {
  const embedding = asRecord(runManifest.embedding, "run.yaml.embedding");
  return {
    model: asString(embedding.model, "run.yaml.embedding.model"),
    dim: asNumber(embedding.dim, "run.yaml.embedding.dim"),
    quantized: asBoolean(embedding.quantized, "run.yaml.embedding.quantized"),
  };
}

/** Variables de entorno que consume `embedding-config.ts` en cualquier proceso. */
export function embeddingEnv(profile: EmbeddingProfile): Record<string, string> {
  return {
    LACOCO_EMBEDDING_MODEL: profile.model,
    LACOCO_EMBEDDING_DIM: String(profile.dim),
    LACOCO_EMBEDDING_QUANTIZED: String(profile.quantized),
  };
}

/**
 * Fija el perfil en `process.env` para este proceso y todos los subprocesos que
 * hereden el entorno (`index_vectors`, `eval:retrieve:deterministic` vía
 * `executeCommand`, que mergea `{...process.env, ...}`). Es el punto ÚNICO donde
 * el eval decide el modelo — el operador ya no exporta env a mano.
 */
export function applyEmbeddingEnv(profile: EmbeddingProfile): void {
  for (const [key, value] of Object.entries(embeddingEnv(profile))) {
    process.env[key] = value;
  }
}

/** Metadata persistida junto al índice para trazar con qué modelo se construyó. */
export interface EmbeddingMetadata {
  embedding_model: string;
  embedding_dim: number;
  embedding_quantized: boolean;
}

export function embeddingMetadataFromProfile(profile: EmbeddingProfile): EmbeddingMetadata {
  return {
    embedding_model: profile.model,
    embedding_dim: profile.dim,
    embedding_quantized: profile.quantized,
  };
}

/** Escribe `embedding.json` en el directorio del índice recién construido. */
export function writeIndexEmbeddingMetadata(
  indexDirectory: string,
  profile: EmbeddingProfile,
): void {
  writeFileSync(
    join(indexDirectory, EMBEDDING_METADATA_FILENAME),
    `${JSON.stringify(embeddingMetadataFromProfile(profile), null, 2)}\n`,
    "utf8",
  );
}

/** Lee la metadata del índice; `null` si no existe (índice legacy sin registro). */
export function readIndexEmbeddingMetadata(indexDirectory: string): EmbeddingMetadata | null {
  const path = join(indexDirectory, EMBEDDING_METADATA_FILENAME);
  if (!existsSync(path)) return null;
  const parsed = asRecord(JSON.parse(readFileSync(path, "utf8")), path);
  return {
    embedding_model: asString(parsed.embedding_model, `${path}.embedding_model`),
    embedding_dim: asNumber(parsed.embedding_dim, `${path}.embedding_dim`),
    embedding_quantized: asBoolean(parsed.embedding_quantized, `${path}.embedding_quantized`),
  };
}

export interface EmbeddingConsistency {
  ok: boolean;
  /** Motivo del veredicto: mensaje de warn (metadata ausente) o de bloqueo (desajuste). */
  reason: string | null;
  /** true solo si hay un desajuste REAL (modelo/dim/quantized distintos). */
  mismatch: boolean;
}

/**
 * Compara el perfil declarado (run.yaml) con la metadata del índice.
 * - metadata ausente (`null`) → índice legacy: NO bloquea (warn), no se puede verificar.
 * - desajuste real → invalidez silenciosa: bloquea (`mismatch: true`).
 */
export function checkEmbeddingConsistency(
  profile: EmbeddingProfile,
  metadata: EmbeddingMetadata | null,
): EmbeddingConsistency {
  if (metadata === null) {
    return {
      ok: true,
      mismatch: false,
      reason: `sin ${EMBEDDING_METADATA_FILENAME} (índice legacy); no verificable — se continúa`,
    };
  }
  const mismatches: string[] = [];
  if (metadata.embedding_model !== profile.model) {
    mismatches.push(`model ${metadata.embedding_model} != ${profile.model}`);
  }
  if (metadata.embedding_dim !== profile.dim) {
    mismatches.push(`dim ${metadata.embedding_dim} != ${profile.dim}`);
  }
  if (metadata.embedding_quantized !== profile.quantized) {
    mismatches.push(`quantized ${metadata.embedding_quantized} != ${profile.quantized}`);
  }
  return mismatches.length === 0
    ? { ok: true, mismatch: false, reason: null }
    : { ok: false, mismatch: true, reason: mismatches.join("; ") };
}
