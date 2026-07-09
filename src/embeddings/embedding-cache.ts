/**
 * EmbeddingCache — Cache persistente cross-proceso para embeddings de query.
 *
 * LaCoCo invoca el modelo de embeddings (all-MiniLM-L6-v2) cada vez que
 * `HybridAnchorService.search` se ejecuta. En el benchmark A/B el mismo
 * prompt corre N veces (N estrategias × M variantes), pagando ~30-80 ms CPU
 * por inferencia redundante. La salida del modelo es determinista para
 * (text, model, dim, quantized), así que cachearla es seguro.
 *
 * El cache vive en disco (JSON) bajo `.lacoco/cache/embeddings.json`. La
 * persistencia permite compartir entre invocaciones del CLI (`lacoco retrieve`)
 * y entre el eval runner (`eval:retrieval`) y sus subprocesos
 * (`eval:retrieve:deterministic`). El path es override-able vía
 * `LACOCO_EMBEDDING_CACHE_PATH` y el cache entero se desactiva con
 * `LACOCO_DISABLE_EMBEDDING_CACHE=1`.
 *
 * Tamaño esperado: 384 dims × 4 bytes × N entradas. Para 1000 entries ≈ 1.5 MB.
 * El cache crece monótonamente; no hay TTL ni compactación. Un cache corrupto
 * se ignora silenciosamente (mejor seguir con cache vacío que abortar la query).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  EMBEDDING_DIM,
  EMBEDDING_MODEL,
  EMBEDDING_QUANTIZED,
} from "./embedding-config.js";

const DEFAULT_CACHE_PATH = ".lacoco/cache/embeddings.json";

export function getEmbeddingCacheKey(text: string): string {
  const payload = `${text}|${EMBEDDING_MODEL}|${EMBEDDING_DIM}|${EMBEDDING_QUANTIZED}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function resolveEmbeddingCachePath(): string {
  const envPath = process.env.LACOCO_EMBEDDING_CACHE_PATH;
  if (envPath && envPath.length > 0) {
    return isAbsolute(envPath) ? envPath : resolve(process.cwd(), envPath);
  }
  return resolve(process.cwd(), DEFAULT_CACHE_PATH);
}

export function isEmbeddingCacheEnabled(): boolean {
  return process.env.LACOCO_DISABLE_EMBEDDING_CACHE !== "1";
}

interface CacheFile {
  version: 1;
  entries: Record<string, { vector: number[] }>;
}

interface CacheEntry {
  vector: number[];
}

export class EmbeddingCache {
  private readonly path: string;
  private readonly entries: Map<string, CacheEntry> = new Map();

  constructor(path: string = resolveEmbeddingCachePath()) {
    this.path = path;
    this.load();
  }

  getPath(): string {
    return this.path;
  }

  size(): number {
    return this.entries.size;
  }

  get(text: string): Float32Array | null {
    const entry = this.entries.get(getEmbeddingCacheKey(text));
    if (entry === undefined) return null;
    return Float32Array.from(entry.vector);
  }

  set(text: string, vector: Float32Array): void {
    this.entries.set(getEmbeddingCacheKey(text), { vector: Array.from(vector) });
    this.persist();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const raw = readFileSync(this.path, "utf8");
      const parsed = JSON.parse(raw) as CacheFile;
      if (parsed.version !== 1 || typeof parsed.entries !== "object" || parsed.entries === null) {
        return;
      }
      for (const [key, value] of Object.entries(parsed.entries)) {
        if (!value || !Array.isArray(value.vector)) continue;
        this.entries.set(key, { vector: value.vector });
      }
    } catch {
      // Cache corrupto: no abortar la query. Las próximas escrituras regeneran
      // el archivo desde el Map en memoria.
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const data: CacheFile = { version: 1, entries: Object.fromEntries(this.entries) };
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), "utf8");
    renameSync(tmp, this.path);
  }
}
