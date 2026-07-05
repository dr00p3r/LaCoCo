import { describe, expect, it } from "vitest";
import { parseRetrievalJson } from "./retrieval-record.js";

describe("parseRetrievalJson", () => {
  it("normalizes CLI chunks and preserves optional metadata", () => {
    const parsed = parseRetrievalJson(JSON.stringify({
      schemaVersion: 1,
      ok: true,
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
      error: null,
    });
  });

  it("keeps structured CLI errors instead of treating them as rankings", () => {
    const parsed = parseRetrievalJson(JSON.stringify({
      schemaVersion: 1,
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
  });
});
