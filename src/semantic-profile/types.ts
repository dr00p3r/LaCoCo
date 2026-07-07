import type { Dimension } from "../domain/dimensions.js";

export const SEMANTIC_DOMAINS = [
  "ui-style",
  "ui-components",
  "routing",
  "api",
  "auth",
  "db-persistence",
  "business-logic",
  "validation",
  "state-management",
  "testing",
  "configuration",
  "build-tooling",
  "documentation",
  "observability",
  "developer-tooling",
  "retrieval-search",
  "indexing-analysis",
  "unknown",
] as const;

export type SemanticDomain = (typeof SEMANTIC_DOMAINS)[number];
export type SemanticProfileStatus = "missing" | "building" | "ready" | "stale" | "error";
export type SemanticTermKind =
  | "symbol"
  | "source-file"
  | "project-file"
  | "dependency"
  | "external-import";

export interface DeterministicTerm {
  id: string;
  canonicalTerm: string;
  normalizedTerm: string;
  kind: SemanticTermKind;
  nodeId?: string;
  path?: string;
  dimensions: Dimension[];
  evidence: string[];
  sourceHash: string;
}

export interface SemanticAlias {
  value: string;
  language: "es" | "en" | "unknown";
  confidence: number;
}

export interface SemanticDomainScore {
  name: SemanticDomain;
  score: number;
}

export interface EnrichedTerm extends DeterministicTerm {
  aliases: SemanticAlias[];
  domains: SemanticDomainScore[];
  description: string;
  confidence: number;
}

export interface SemanticProfileState {
  status: SemanticProfileStatus;
  activeBuildId: string | null;
  graphRevision: string | null;
  evidenceRevision: string | null;
  model: string | null;
  promptVersion: number | null;
  updatedAt: string;
  lastError: string | null;
}

export interface ProjectTermCandidate {
  termId: string;
  canonicalTerm: string;
  kind: SemanticTermKind;
  path?: string;
  nodeId?: string;
  score: number;
  matchedAliases: string[];
  matchReasons: Array<"exact" | "fts5">;
  aliases: SemanticAlias[];
  domains: SemanticDomainScore[];
}

export interface DomainCandidate {
  name: SemanticDomain;
  score: number;
}

export interface QueryGrounding {
  profileBuildId: string;
  candidates: ProjectTermCandidate[];
  domains: DomainCandidate[];
  durationMs: number;
}

export interface GroundingDiagnostics {
  enabled: boolean;
  profileBuildId: string | null;
  candidates: ProjectTermCandidate[];
  domains: DomainCandidate[];
  usedTermIds: string[];
  initialUnsupportedClauses: string[];
  repairCount: number;
  durationMs: number | null;
}

export interface SemanticProfileBuildResult {
  buildId: string;
  termCount: number;
  aliasCount: number;
  evidenceRevision: string;
}
