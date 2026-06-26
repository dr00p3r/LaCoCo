import { describe, expect, it } from "vitest";
import { DIMENSIONS, KIND_TO_DIM, RELATION_TO_DIM } from "../../src/domain/dimensions.js";

describe("dimensions taxonomy", () => {
  it("maps every known relation to a canonical dimension", () => {
    for (const dimension of Object.values(RELATION_TO_DIM)) {
      expect(DIMENSIONS).toContain(dimension);
    }
  });

  it("maps every fallback kind to a canonical dimension", () => {
    for (const dimension of Object.values(KIND_TO_DIM)) {
      expect(DIMENSIONS).toContain(dimension);
    }
  });
});
