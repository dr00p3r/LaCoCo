/**
 * grounding-profile — parámetros de la construcción offline del Project Semantic
 * Profile (Ollama), declarados en `run.yaml` (`grounding:` top-level).
 *
 * `enrichConcurrency` solo acelera el build (lotes de enriquecimiento en vuelo
 * simultáneos). El QueryGrounder en tiempo de consulta es determinista, así que
 * este valor NO altera la línea base del A/B de retrieval — únicamente el
 * wall-clock del build.
 *
 * El bloque es OPCIONAL: si falta (o falta el campo), se usa el default, de modo
 * que el `run.yaml` de `swe-polybench/` y los locks viejos siguen cargando.
 */
import { asNumber, asRecord } from "./config.js";

export interface GroundingProfile {
  /** Lotes de enriquecimiento en vuelo simultáneos. Requiere OLLAMA_NUM_PARALLEL>=este valor. */
  enrichConcurrency: number;
}

export const DEFAULT_GROUNDING_PROFILE: GroundingProfile = {
  enrichConcurrency: 4,
};

/** Lee el bloque `grounding:` de run.yaml; devuelve el default si falta el bloque o el campo. */
export function resolveGroundingProfile(runManifest: Record<string, unknown>): GroundingProfile {
  if (runManifest.grounding === undefined) return { ...DEFAULT_GROUNDING_PROFILE };
  const grounding = asRecord(runManifest.grounding, "run.yaml.grounding");
  const enrichConcurrency = grounding.enrich_concurrency === undefined
    ? DEFAULT_GROUNDING_PROFILE.enrichConcurrency
    : asNumber(grounding.enrich_concurrency, "run.yaml.grounding.enrich_concurrency");
  if (!Number.isInteger(enrichConcurrency) || enrichConcurrency <= 0) {
    throw new Error("run.yaml.grounding.enrich_concurrency must be a positive integer");
  }
  return { enrichConcurrency };
}
