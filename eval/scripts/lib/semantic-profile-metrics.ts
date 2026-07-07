export type SemanticMetricStatus = "computed" | "excluded_from_gold_metrics" | "failed_execution" | "not_applicable";

export interface SemanticMetricValue {
  status: SemanticMetricStatus;
  value: number | null;
}

export interface SemanticProfileMetricInput {
  exitCode: number | null;
  cleanQuery: string | null;
  candidateTerms: string[];
  unsupportedClauses: string[];
  repairCount: number | null;
  groundingDurationMs: number | null;
}

export interface TranslationGoldInput {
  status: string;
  relevantTerms: string[];
}

export interface SemanticProfileMetricSet {
  candidateRecallAt20: SemanticMetricValue;
  translationTermPrecision: SemanticMetricValue;
  translationTermRecall: SemanticMetricValue;
  unsupportedTermRate: SemanticMetricValue;
  repairCount: SemanticMetricValue;
  groundingLatencyMs: SemanticMetricValue;
}

export function computeSemanticProfileMetrics(
  input: SemanticProfileMetricInput,
  gold: TranslationGoldInput,
): SemanticProfileMetricSet {
  if (input.exitCode !== 0) return allMetrics("failed_execution");
  const noGold = gold.status !== "ready" || gold.relevantTerms.length === 0;
  const relevant = new Set(gold.relevantTerms.map(normalize));
  const clauses = input.cleanQuery === null ? [] : splitCleanQuery(input.cleanQuery).map(normalize);
  const candidates = input.candidateTerms.slice(0, 20).map(normalize);
  const intersection = (values: string[]): number => new Set(values.filter((value) => relevant.has(value))).size;
  const translationStatus: SemanticMetricStatus = noGold ? "excluded_from_gold_metrics" : "computed";
  const matchedClauses = intersection(clauses);
  const matchedCandidates = intersection(candidates);
  const unsupportedDenominator = clauses.length + input.unsupportedClauses.length;
  return {
    candidateRecallAt20: candidates.length === 0
      ? metric("not_applicable", null)
      : noGold
        ? metric(translationStatus, null)
        : metric("computed", matchedCandidates / relevant.size),
    translationTermPrecision: noGold
      ? metric(translationStatus, null)
      : metric("computed", clauses.length === 0 ? 0 : matchedClauses / new Set(clauses).size),
    translationTermRecall: noGold
      ? metric(translationStatus, null)
      : metric("computed", matchedClauses / relevant.size),
    unsupportedTermRate: input.repairCount === null
      ? metric("not_applicable", null)
      : metric("computed", unsupportedDenominator === 0 ? 0 : input.unsupportedClauses.length / unsupportedDenominator),
    repairCount: input.repairCount === null
      ? metric("not_applicable", null)
      : metric("computed", input.repairCount),
    groundingLatencyMs: input.groundingDurationMs === null
      ? metric("not_applicable", null)
      : metric("computed", input.groundingDurationMs),
  };
}

function allMetrics(status: SemanticMetricStatus): SemanticProfileMetricSet {
  const unavailable = metric(status, null);
  return {
    candidateRecallAt20: unavailable,
    translationTermPrecision: unavailable,
    translationTermRecall: unavailable,
    unsupportedTermRate: unavailable,
    repairCount: unavailable,
    groundingLatencyMs: unavailable,
  };
}

function metric(status: SemanticMetricStatus, value: number | null): SemanticMetricValue {
  return { status, value };
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim().replace(/\s+/gu, " ");
}

function splitCleanQuery(query: string): string[] {
  return query.split(/\s+OR\s+/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .map((clause) => clause.startsWith('"') && clause.endsWith('"') ? clause.slice(1, -1) : clause);
}
