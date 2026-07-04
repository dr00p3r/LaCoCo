import { describe, expect, it } from "vitest";
import {
  getEffectiveStrategyParameters,
  STRATEGY_REGISTRY,
} from "../../src/retriever/strategies/registry.js";

describe("strategy registry parameters", () => {
  it("expone los defaults efectivos de cada estrategia", () => {
    expect(getEffectiveStrategyParameters("hybrid")).toEqual({ anchorLimit: 20 });
    expect(getEffectiveStrategyParameters("clcr")).toMatchObject({
      primaryHops: 2,
      primaryDecay: 0.5,
      cascadeDecay: 0.7,
      chunkLimit: 50,
    });
    expect(getEffectiveStrategyParameters("rpr")).toMatchObject({
      maxDepth: 3,
      maxCandidates: 5000,
    });
  });

  it("mapea --chunks al parámetro soportado por cada estrategia", () => {
    expect(getEffectiveStrategyParameters("hybrid", { chunks: 7 }).anchorLimit).toBe(7);
    for (const strategy of ["agentic", "ictd", "clcr", "rpr"] as const) {
      expect(getEffectiveStrategyParameters(strategy, { chunks: 7 }).chunkLimit).toBe(7);
    }
  });

  it("rechaza límites de chunks inválidos", () => {
    expect(() => getEffectiveStrategyParameters("hybrid", { chunks: 0 })).toThrow(
      "entero positivo",
    );
  });

  it("mantiene los defaults del registro inmutables al calcular overrides", () => {
    getEffectiveStrategyParameters("ictd", { chunks: 3 });
    expect(STRATEGY_REGISTRY.ictd.defaultParameters.chunkLimit).toBe(50);
  });
});
