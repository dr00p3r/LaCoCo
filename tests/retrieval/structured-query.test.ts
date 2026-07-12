import { describe, expect, it } from "vitest";
import { buildFrozenSanitizer, assertRagSanitizer } from "../../src/retriever/utilities/structured-query.js";

describe("buildFrozenSanitizer", () => {
  const complete = {
    clean_query: '"OrderService" OR "order.service"',
    embedding_input: "servicio de pedidos y su creación",
    intent: "debug",
    dimensions: ["CPG"],
  };

  it("congela un SanitizerOutput cuando la clasificación está completa", () => {
    const out = buildFrozenSanitizer(complete);
    expect(out).not.toBeNull();
    expect(out).toMatchObject({
      route: "RAG",
      clean_query: complete.clean_query,
      intent: "debug",
      dimensions: ["CPG"],
      confidence: 0.9,
    });
  });

  it("devuelve null si no se aporta ningún campo (→ fallback al SLM)", () => {
    expect(buildFrozenSanitizer({})).toBeNull();
  });

  it("devuelve null si la clasificación es parcial (→ fallback al SLM)", () => {
    expect(buildFrozenSanitizer({ clean_query: "OrderService" })).toBeNull();
    expect(buildFrozenSanitizer({ clean_query: "x", intent: "debug" })).toBeNull();
  });

  it("respeta la confidence provista", () => {
    const out = buildFrozenSanitizer({ ...complete, confidence: 0.42 });
    expect(out?.confidence).toBe(0.42);
  });

  it("lanza error claro si un campo presente es inválido (intent)", () => {
    expect(() => buildFrozenSanitizer({ ...complete, intent: "explicame" })).toThrow(/intent inválido/);
  });

  it("lanza error claro si dimensions contiene un valor no soportado", () => {
    expect(() => buildFrozenSanitizer({ ...complete, dimensions: ["CPG", "XYZ"] })).toThrow(/dimensions/);
  });

  it("lanza error si clean_query está presente pero vacío", () => {
    expect(() => buildFrozenSanitizer({ ...complete, clean_query: "   " })).toThrow(/clean_query/);
  });
});

describe("assertRagSanitizer", () => {
  it("exige route RAG", () => {
    expect(() =>
      assertRagSanitizer({
        route: "LLM_DIRECT",
        clean_query: "x",
        embedding_input: "y",
        intent: "debug",
        dimensions: ["CPG"],
        confidence: 0.9,
      }),
    ).toThrow(/route 'RAG'/);
  });
});
