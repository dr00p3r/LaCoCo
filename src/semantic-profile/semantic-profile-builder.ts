import crypto from "node:crypto";
import type Database from "better-sqlite3";
import type { LlmClient } from "../slms/llm-client.js";
import { DeterministicTermExtractor } from "./deterministic-term-extractor.js";
import { SemanticProfileStore } from "./semantic-profile-store.js";
import { SEMANTIC_ENRICHMENT_PROMPT_VERSION, SemanticTermEnricher } from "./semantic-term-enricher.js";
import type { EnrichedTerm, SemanticProfileBuildResult } from "./types.js";

export class SemanticProfileBuilder {
  constructor(
    private readonly db: Database.Database,
    private readonly projectRoot: string,
    private readonly llm: LlmClient,
    private readonly model: string,
    // Lotes de enriquecimiento en vuelo simultáneos. Default 1 = secuencial
    // (deja el path del daemon, con refrescos incrementales chicos, sin cambios).
    private readonly enrichConcurrency: number = 1,
  ) {}

  async rebuild(): Promise<SemanticProfileBuildResult> {
    const store = new SemanticProfileStore(this.db);
    const terms = new DeterministicTermExtractor(this.db, this.projectRoot).extract();
    const evidenceRevision = computeEvidenceRevision(terms.map(({ sourceHash }) => sourceHash));
    const reusable = store.loadReusableTerms(terms);
    const pending = terms.filter((term) => !reusable.has(term.sourceHash));
    const buildId = store.beginBuild(this.model, SEMANTIC_ENRICHMENT_PROMPT_VERSION, evidenceRevision);
    try {
      const newlyEnriched = await new SemanticTermEnricher(this.llm, this.enrichConcurrency).enrich(pending);
      const newByHash = new Map(newlyEnriched.map((term) => [term.sourceHash, term]));
      const enriched = terms.map((term): EnrichedTerm => {
        const cached = reusable.get(term.sourceHash);
        if (cached) return { ...cached, ...term };
        const fresh = newByHash.get(term.sourceHash);
        if (!fresh) throw new Error(`No se enriqueció el término ${term.id}`);
        return fresh;
      });
      return store.completeBuild(buildId, enriched);
    } catch (error) {
      store.failBuild(buildId, error);
      throw error;
    }
  }
}

export function computeEvidenceRevision(sourceHashes: readonly string[]): string {
  return crypto.createHash("sha256")
    .update([...sourceHashes].sort().join("\n"))
    .digest("hex");
}
