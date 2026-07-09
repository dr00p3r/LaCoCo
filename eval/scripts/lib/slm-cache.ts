/**
 * slm-cache — Cache persistente cross-run para la salida del intermediario SLM.
 *
 * El eval runner (run-retrieval.ts) invoca el intermediario una vez por
 * (task, variant) para congelar el `SanitizerOutput` que los subprocesos de
 * retrieval reutilizan. Sin cache, re-correr el mismo run (cambiando
 * `--strategy-id` o `--sanitizer-variant`) repite las ~5s de la llamada al
 * SLM, y un A/B con dos variants paga el doble. La salida es determinista
 * (`temperature: 0, seed: 42`, mismo prompt, mismo modelo, mismo schema),
 * así que cachearla es seguro.
 *
 * La key incluye `variant + intermediaryModel + schemaVersion` → cambiar el
 * modelo o bumpear `CLASSIFIER_SCHEMA_VERSION` (en `classifier.ts`) invalida
 * el cache automáticamente. La invalidación por schema es la red de seguridad
 * ante cambios silenciosos en `SYSTEM_PROMPT` o `CLASSIFICATION_SCHEMA` que
 * olvidarían bumpear la constante.
 *
 * El path es override-able vía `LACOCO_SLM_CACHE_PATH`. El cache se desactiva
 * con `LACOCO_DISABLE_SLM_CACHE=1`.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { SanitizerOutput } from "../../../src/retriever/models/utilities/types.js";
import type { QueryGrounding } from "../../../src/semantic-profile/types.js";
import { CLASSIFIER_SCHEMA_VERSION } from "../../../src/retriever/utilities/mini-agents/agent-intermediary/classifier.js";

const CACHE_FILENAME = "slm-cache.json";

export function getSlmCacheKey(
  prompt: string,
  variant: string,
  model: string,
  schemaVersion: number = CLASSIFIER_SCHEMA_VERSION,
): string {
  const payload = `${variant}|${model}|${schemaVersion}|${prompt}`;
  return createHash("sha256").update(payload).digest("hex").slice(0, 16);
}

export function isSlmCacheEnabled(): boolean {
  return process.env.LACOCO_DISABLE_SLM_CACHE !== "1";
}

export interface FrozenEntry {
  sanitizer: SanitizerOutput;
  grounding: QueryGrounding | null;
  duration_ms: number;
}

interface CacheFile {
  version: 1;
  entries: Record<string, FrozenEntry>;
}

export class SlmCache {
  private readonly path: string;
  private readonly model: string;
  private readonly schemaVersion: number;
  private readonly entries: Map<string, FrozenEntry> = new Map();

  constructor(
    path: string,
    model: string,
    schemaVersion: number = CLASSIFIER_SCHEMA_VERSION,
  ) {
    this.path = path;
    this.model = model;
    this.schemaVersion = schemaVersion;
    this.load();
  }

  getPath(): string {
    return this.path;
  }

  size(): number {
    return this.entries.size;
  }

  get(prompt: string, variant: string): FrozenEntry | null {
    const key = getSlmCacheKey(prompt, variant, this.model, this.schemaVersion);
    return this.entries.get(key) ?? null;
  }

  set(prompt: string, variant: string, entry: FrozenEntry): void {
    const key = getSlmCacheKey(prompt, variant, this.model, this.schemaVersion);
    this.entries.set(key, entry);
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
        this.entries.set(key, value);
      }
    } catch {
      // Cache corrupto: ignorar y seguir con cache vacío.
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

export function defaultSlmCachePath(workdir: string): string {
  const envPath = process.env.LACOCO_SLM_CACHE_PATH;
  if (envPath && envPath.length > 0) return envPath;
  return `${workdir.replace(/\/+$/, "")}/cache/${CACHE_FILENAME}`;
}
