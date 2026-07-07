import crypto from "node:crypto";
import type Database from "better-sqlite3";
import { SEMANTIC_DOMAIN_DESCRIPTIONS } from "./domains.js";
import {
  SEMANTIC_DOMAINS,
  type DomainCandidate,
  type EnrichedTerm,
  type ProjectTermCandidate,
  type QueryGrounding,
  type SemanticAlias,
  type SemanticDomain,
  type SemanticDomainScore,
  type SemanticProfileBuildResult,
  type SemanticProfileState,
  type SemanticTermKind,
  type DeterministicTerm,
} from "./types.js";

interface StateRow {
  status: SemanticProfileState["status"];
  active_build_id: string | null;
  updated_at: string;
  last_error: string | null;
  graph_revision: string | null;
  evidence_revision: string | null;
  model: string | null;
  prompt_version: number | null;
}

interface TermRow {
  id: string;
  canonical_term: string;
  kind: SemanticTermKind;
  node_id: string | null;
  path: string | null;
}

export class SemanticProfileStore {
  constructor(private readonly db: Database.Database) {}

  getState(): SemanticProfileState {
    const row = this.db.prepare(`
      SELECT s.status, s.active_build_id, s.updated_at, s.last_error,
             b.graph_revision, b.evidence_revision, b.model, b.prompt_version
      FROM semantic_profile_state s
      LEFT JOIN semantic_profile_builds b ON b.id = s.active_build_id
      WHERE s.id = 1
    `).get() as StateRow;
    return {
      status: row.status,
      activeBuildId: row.active_build_id,
      graphRevision: row.graph_revision,
      evidenceRevision: row.evidence_revision,
      model: row.model,
      promptVersion: row.prompt_version,
      updatedAt: row.updated_at,
      lastError: row.last_error,
    };
  }

  getGraphRevision(): string {
    const row = this.db.prepare("SELECT revision FROM graph_state WHERE id = 1").get() as {
      revision: string;
    };
    return row.revision;
  }

  bumpGraphRevision(): string {
    const revision = crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(
        "UPDATE graph_state SET revision = ?, updated_at = ? WHERE id = 1",
      ).run(revision, now);
      this.db.prepare(`
        UPDATE semantic_profile_state
        SET status = CASE WHEN active_build_id IS NULL THEN 'missing' ELSE 'stale' END,
            updated_at = ?, last_error = NULL
        WHERE id = 1
      `).run(now);
    })();
    return revision;
  }

  markStale(): void {
    this.db.prepare(`
      UPDATE semantic_profile_state
      SET status = CASE WHEN active_build_id IS NULL THEN 'missing' ELSE 'stale' END,
          updated_at = ?
      WHERE id = 1
    `).run(new Date().toISOString());
  }

  beginBuild(model: string, promptVersion: number, evidenceRevision: string): string {
    this.#seedDomains();
    const buildId = crypto.randomUUID();
    const now = new Date().toISOString();
    const graphRevision = this.getGraphRevision();
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO semantic_profile_builds(
          id, status, graph_revision, evidence_revision, model, prompt_version, created_at
        ) VALUES (?, 'building', ?, ?, ?, ?, ?)
      `).run(buildId, graphRevision, evidenceRevision, model, promptVersion, now);
      this.db.prepare(`
        UPDATE semantic_profile_state
        SET status = 'building', last_error = NULL, updated_at = ?
        WHERE id = 1
      `).run(now);
    })();
    return buildId;
  }

  completeBuild(buildId: string, terms: readonly EnrichedTerm[]): SemanticProfileBuildResult {
    const insertTerm = this.db.prepare(`
      INSERT INTO semantic_terms(
        build_id, id, canonical_term, normalized_term, kind, node_id, path,
        description, dimensions_json, evidence_json, confidence, source_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertAlias = this.db.prepare(`
      INSERT INTO semantic_aliases(
        build_id, term_id, value, normalized_value, language, confidence
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertDomain = this.db.prepare(`
      INSERT INTO semantic_term_domains(build_id, term_id, domain, score)
      VALUES (?, ?, ?, ?)
    `);
    const insertFts = this.db.prepare(`
      INSERT INTO semantic_profile_fts(
        build_id, term_id, canonical_term, aliases, description, path, domains
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    let aliasCount = 0;
    const completedAt = new Date().toISOString();

    this.db.transaction(() => {
      for (const term of terms) {
        insertTerm.run(
          buildId,
          term.id,
          term.canonicalTerm,
          term.normalizedTerm,
          term.kind,
          term.nodeId ?? null,
          term.path ?? null,
          term.description,
          JSON.stringify(term.dimensions),
          JSON.stringify(term.evidence),
          term.confidence,
          term.sourceHash,
        );
        for (const alias of term.aliases) {
          insertAlias.run(
            buildId,
            term.id,
            alias.value,
            normalizeSemanticText(alias.value),
            alias.language,
            alias.confidence,
          );
          aliasCount++;
        }
        for (const domain of term.domains) {
          insertDomain.run(buildId, term.id, domain.name, domain.score);
        }
        insertFts.run(
          buildId,
          term.id,
          term.canonicalTerm,
          term.aliases.map(({ value }) => value).join(" "),
          term.description,
          term.path ?? "",
          term.domains.map(({ name }) => name).join(" "),
        );
      }

      this.db.prepare(`
        UPDATE semantic_profile_builds
        SET status = 'ready', completed_at = ?, error = NULL
        WHERE id = ?
      `).run(completedAt, buildId);
      this.db.prepare(`
        UPDATE semantic_profile_state
        SET active_build_id = ?, status = 'ready', last_error = NULL, updated_at = ?
        WHERE id = 1
      `).run(buildId, completedAt);
      this.db.prepare("DELETE FROM semantic_profile_fts WHERE build_id <> ?").run(buildId);
      this.db.prepare("DELETE FROM semantic_profile_builds WHERE id <> ?").run(buildId);
    })();

    const build = this.db.prepare(
      "SELECT evidence_revision FROM semantic_profile_builds WHERE id = ?",
    ).get(buildId) as { evidence_revision: string };
    return { buildId, termCount: terms.length, aliasCount, evidenceRevision: build.evidence_revision };
  }

  failBuild(buildId: string, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE semantic_profile_builds
        SET status = 'error', completed_at = ?, error = ?
        WHERE id = ?
      `).run(now, message, buildId);
      this.db.prepare(`
        UPDATE semantic_profile_state
        SET status = 'error', last_error = ?, updated_at = ?
        WHERE id = 1
      `).run(message, now);
    })();
  }

  assertReady(): { buildId: string; graphRevision: string } {
    const state = this.getState();
    if (state.status === "stale") {
      throw new Error("Project Semantic Profile está obsoleto. Ejecuta profile rebuild.");
    }
    if (state.status !== "ready" || !state.activeBuildId || !state.graphRevision) {
      throw new Error(
        `Project Semantic Profile no está listo (estado: ${state.status}). Ejecuta profile rebuild.`,
      );
    }
    const graphRevision = this.getGraphRevision();
    if (graphRevision !== state.graphRevision) {
      this.markStale();
      throw new Error("Project Semantic Profile está obsoleto. Ejecuta profile rebuild.");
    }
    return { buildId: state.activeBuildId, graphRevision };
  }

  loadReusableTerms(terms: readonly DeterministicTerm[]): Map<string, EnrichedTerm> {
    const state = this.getState();
    if (!state.activeBuildId || terms.length === 0) return new Map();
    const requested = new Map(terms.map((term) => [term.sourceHash, term]));
    const hashes = [...requested.keys()];
    const result = new Map<string, EnrichedTerm>();
    for (let offset = 0; offset < hashes.length; offset += 500) {
      const batch = hashes.slice(offset, offset + 500);
      const placeholders = batch.map(() => "?").join(", ");
      const rows = this.db.prepare(`
        SELECT id, canonical_term, normalized_term, kind, node_id, path,
               description, dimensions_json, evidence_json, confidence, source_hash
        FROM semantic_terms
        WHERE build_id = ? AND source_hash IN (${placeholders})
      `).all(state.activeBuildId, ...batch) as Array<{
        id: string;
        canonical_term: string;
        normalized_term: string;
        kind: SemanticTermKind;
        node_id: string | null;
        path: string | null;
        description: string;
        dimensions_json: string;
        evidence_json: string;
        confidence: number;
        source_hash: string;
      }>;
      if (rows.length === 0) continue;
      const termIds = rows.map(({ id }) => id);
      const termPlaceholders = termIds.map(() => "?").join(", ");
      const aliasRows = this.db.prepare(`
        SELECT term_id, value, language, confidence FROM semantic_aliases
        WHERE build_id = ? AND term_id IN (${termPlaceholders})
        ORDER BY confidence DESC, value ASC
      `).all(state.activeBuildId, ...termIds) as Array<SemanticAlias & { term_id: string }>;
      const domainRows = this.db.prepare(`
        SELECT term_id, domain AS name, score FROM semantic_term_domains
        WHERE build_id = ? AND term_id IN (${termPlaceholders})
        ORDER BY score DESC, domain ASC
      `).all(state.activeBuildId, ...termIds) as Array<SemanticDomainScore & { term_id: string }>;
      for (const row of rows) {
        const aliases = aliasRows
          .filter(({ term_id }) => term_id === row.id)
          .map(({ value, language, confidence }) => ({ value, language, confidence }));
        const domains = domainRows
          .filter(({ term_id }) => term_id === row.id)
          .map(({ name, score }) => ({ name, score }));
        result.set(row.source_hash, {
          id: row.id,
          canonicalTerm: row.canonical_term,
          normalizedTerm: row.normalized_term,
          kind: row.kind,
          ...(row.node_id ? { nodeId: row.node_id } : {}),
          ...(row.path ? { path: row.path } : {}),
          dimensions: JSON.parse(row.dimensions_json) as EnrichedTerm["dimensions"],
          evidence: JSON.parse(row.evidence_json) as string[],
          sourceHash: row.source_hash,
          aliases,
          domains,
          description: row.description,
          confidence: row.confidence,
        });
      }
    }
    return result;
  }

  groundQuery(query: string, limit = 20, topDomains = 3): QueryGrounding {
    const startedAt = performance.now();
    const { buildId } = this.assertReady();
    const normalizedQuery = normalizeSemanticText(query);
    const exactRanks = this.#exactRanks(buildId, normalizedQuery);
    const ftsRanks = this.#ftsRanks(buildId, query, Math.max(limit * 3, 50));
    const ids = new Set([...exactRanks.keys(), ...ftsRanks.keys()]);
    const ranked = [...ids].map((termId) => ({
      termId,
      score:
        (exactRanks.has(termId) ? 1 / (60 + exactRanks.get(termId)!) : 0) +
        (ftsRanks.has(termId) ? 1 / (60 + ftsRanks.get(termId)!) : 0),
    })).sort((left, right) => right.score - left.score || left.termId.localeCompare(right.termId));
    const selected = ranked.slice(0, limit);
    const candidates = this.#loadCandidates(
      buildId,
      selected,
      normalizedQuery,
      exactRanks,
      ftsRanks,
    );
    return {
      profileBuildId: buildId,
      candidates,
      domains: aggregateDomains(candidates).slice(0, topDomains),
      durationMs: performance.now() - startedAt,
    };
  }

  #seedDomains(): void {
    const statement = this.db.prepare(
      "INSERT OR IGNORE INTO semantic_domains(name, description) VALUES (?, ?)",
    );
    const transaction = this.db.transaction(() => {
      for (const domain of SEMANTIC_DOMAINS) {
        statement.run(domain, SEMANTIC_DOMAIN_DESCRIPTIONS[domain]);
      }
    });
    transaction();
  }

  #exactRanks(buildId: string, normalizedQuery: string): Map<string, number> {
    const rows = this.db.prepare(`
      SELECT term_id, MAX(match_length) AS match_length
      FROM (
        SELECT term_id, LENGTH(normalized_value) AS match_length
        FROM semantic_aliases
        WHERE build_id = ? AND LENGTH(normalized_value) >= 3
          AND INSTR(?, normalized_value) > 0
        UNION ALL
        SELECT id AS term_id, LENGTH(normalized_term) AS match_length
        FROM semantic_terms
        WHERE build_id = ? AND LENGTH(normalized_term) >= 3
          AND INSTR(?, normalized_term) > 0
      )
      GROUP BY term_id
      ORDER BY match_length DESC, term_id ASC
    `).all(buildId, normalizedQuery, buildId, normalizedQuery) as Array<{
      term_id: string;
      match_length: number;
    }>;
    return new Map(rows.map((row, index) => [row.term_id, index + 1]));
  }

  #ftsRanks(buildId: string, query: string, limit: number): Map<string, number> {
    const ftsQuery = createLexicalFtsQuery(query);
    if (!ftsQuery) return new Map();
    const rows = this.db.prepare(`
      SELECT term_id, MIN(rank) AS score
      FROM semantic_profile_fts
      WHERE semantic_profile_fts MATCH ? AND build_id = ?
      GROUP BY term_id
      ORDER BY score ASC, term_id ASC
      LIMIT ?
    `).all(ftsQuery, buildId, limit) as Array<{ term_id: string; score: number }>;
    return new Map(rows.map((row, index) => [row.term_id, index + 1]));
  }

  #loadCandidates(
    buildId: string,
    ranking: Array<{ termId: string; score: number }>,
    normalizedQuery: string,
    exactRanks: ReadonlyMap<string, number>,
    ftsRanks: ReadonlyMap<string, number>,
  ): ProjectTermCandidate[] {
    if (ranking.length === 0) return [];
    const placeholders = ranking.map(() => "?").join(", ");
    const ids = ranking.map(({ termId }) => termId);
    const terms = this.db.prepare(`
      SELECT id, canonical_term, kind, node_id, path
      FROM semantic_terms
      WHERE build_id = ? AND id IN (${placeholders})
    `).all(buildId, ...ids) as TermRow[];
    const aliases = this.db.prepare(`
      SELECT term_id, value, normalized_value, language, confidence
      FROM semantic_aliases
      WHERE build_id = ? AND term_id IN (${placeholders})
      ORDER BY confidence DESC, value ASC
    `).all(buildId, ...ids) as Array<{
      term_id: string;
      value: string;
      normalized_value: string;
      language: SemanticAlias["language"];
      confidence: number;
    }>;
    const domains = this.db.prepare(`
      SELECT term_id, domain, score
      FROM semantic_term_domains
      WHERE build_id = ? AND term_id IN (${placeholders})
      ORDER BY score DESC, domain ASC
    `).all(buildId, ...ids) as Array<{
      term_id: string;
      domain: SemanticDomain;
      score: number;
    }>;
    const termById = new Map(terms.map((term) => [term.id, term]));
    return ranking.flatMap(({ termId, score }) => {
      const term = termById.get(termId);
      if (!term) return [];
      const termAliases = aliases.filter(({ term_id }) => term_id === termId);
      return [{
        termId,
        canonicalTerm: term.canonical_term,
        kind: term.kind,
        ...(term.path ? { path: term.path } : {}),
        ...(term.node_id ? { nodeId: term.node_id } : {}),
        score,
        matchedAliases: termAliases
          .filter(({ normalized_value }) => normalizedQuery.includes(normalized_value))
          .map(({ value }) => value),
        matchReasons: [
          ...(exactRanks.has(termId) ? ["exact" as const] : []),
          ...(ftsRanks.has(termId) ? ["fts5" as const] : []),
        ],
        aliases: termAliases.map(({ value, language, confidence }) => ({
          value,
          language,
          confidence,
        })),
        domains: domains
          .filter(({ term_id }) => term_id === termId)
          .map(({ domain, score: domainScore }) => ({ name: domain, score: domainScore })),
      }];
    });
  }
}

export function normalizeSemanticText(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim().replace(/\s+/g, " ");
}

export function createLexicalFtsQuery(value: string): string {
  const tokens = normalizeSemanticText(value).match(/[\p{L}\p{N}_./#-]+/gu) ?? [];
  return [...new Set(tokens.filter((token) => token.length >= 2))]
    .map((token) => `"${token.replace(/"/g, '""')}"`)
    .join(" OR ");
}

function aggregateDomains(candidates: readonly ProjectTermCandidate[]): DomainCandidate[] {
  const scores = new Map<SemanticDomain, number>();
  for (const candidate of candidates) {
    for (const domain of candidate.domains) {
      scores.set(domain.name, (scores.get(domain.name) ?? 0) + candidate.score * domain.score);
    }
  }
  return [...scores].map(([name, score]) => ({ name, score }))
    .sort((left, right) => right.score - left.score || left.name.localeCompare(right.name));
}
