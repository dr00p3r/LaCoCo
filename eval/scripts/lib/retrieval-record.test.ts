import { describe, expect, it } from "vitest";
import { parseRetrievalJson } from "./retrieval-record.js";

describe("parseRetrievalJson", () => {
  it("normalizes CLI chunks and preserves optional metadata", () => {
    const parsed = parseRetrievalJson(JSON.stringify({
      schemaVersion: 2,
      ok: true,
      classification: { cleanQuery: "OrderService", embeddingInput: "Order service" },
      grounding: {
        enabled: false,
        profileBuildId: null,
        candidates: [],
        usedTermIds: [],
        initialUnsupportedClauses: [],
        repairCount: 0,
        durationMs: null,
      },
      retrieval: {
        strategyParameters: { anchorLimit: 20 },
        chunks: [{
          chunkId: "src/order.ts#OrderService",
          nodeId: "src/order.ts#OrderService",
          score: 0.75,
          source: "HYBRID",
          text: "class OrderService {}",
          filepath: "src/order.ts",
          kind: "class",
          diagnostics: { duplicateCount: 3 },
        }],
      },
    }));

    expect(parsed).toEqual({
      rankedNodes: [{
        rank: 1,
        chunk_id: "src/order.ts#OrderService",
        node_id: "src/order.ts#OrderService",
        score: 0.75,
        source: "HYBRID",
        text: "class OrderService {}",
        filepath: "src/order.ts",
        kind: "class",
        duplicate_count: 3,
      }],
      effectiveParameters: { anchorLimit: 20 },
      classification: { cleanQuery: "OrderService", embeddingInput: "Order service" },
      grounding: {
        enabled: false,
        profileBuildId: null,
        candidateTermIds: [],
        candidateTerms: [],
        usedTermIds: [],
        initialUnsupportedClauses: [],
        repairCount: 0,
        durationMs: null,
      },
      error: null,
    });
  });

  it("keeps structured CLI errors instead of treating them as rankings", () => {
    const parsed = parseRetrievalJson(JSON.stringify({
      schemaVersion: 2,
      ok: false,
      error: { stage: "retrieval:hybrid", message: "failed" },
    }));

    expect(parsed.error).toEqual({
      type: "cli_error",
      stage: "retrieval:hybrid",
      message: "failed",
    });
    expect(parsed.rankedNodes).toEqual([]);
    expect(parsed.effectiveParameters).toBeNull();
    expect(parsed.classification).toBeNull();
    expect(parsed.grounding).toBeNull();
  });
});
