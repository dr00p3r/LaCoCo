import { describe, expect, it } from "vitest";
import { computeSemanticProfileMetrics } from "./semantic-profile-metrics.js";

describe("computeSemanticProfileMetrics", () => {
  it("calcula candidatos, traducción, términos no soportados y latencia", () => {
    const result = computeSemanticProfileMetrics({
      exitCode: 0,
      cleanQuery: '"tailwind.config.ts" OR "theme" OR "schema"',
      candidateTerms: ["tailwind.config.ts", "global.css"],
      unsupportedClauses: ["schema"],
      repairCount: 1,
      groundingDurationMs: 4.5,
    }, {
      status: "ready",
      relevantTerms: ["tailwind.config.ts", "theme", "global.css"],
    });

    expect(result.candidateRecallAt20.value).toBeCloseTo(2 / 3);
    expect(result.translationTermPrecision.value).toBeCloseTo(2 / 3);
    expect(result.translationTermRecall.value).toBeCloseTo(2 / 3);
    expect(result.unsupportedTermRate.value).toBe(0.25);
    expect(result.repairCount.value).toBe(1);
    expect(result.groundingLatencyMs.value).toBe(4.5);
  });

  it("excluye métricas de traducción sin gold manual", () => {
    const result = computeSemanticProfileMetrics({
      exitCode: 0,
      cleanQuery: '"theme"',
      candidateTerms: [],
      unsupportedClauses: [],
      repairCount: null,
      groundingDurationMs: null,
    }, { status: "pending_manual_annotation", relevantTerms: [] });

    expect(result.translationTermPrecision.status).toBe("excluded_from_gold_metrics");
    expect(result.candidateRecallAt20.status).toBe("not_applicable");
    expect(result.unsupportedTermRate.status).toBe("not_applicable");
  });
});
