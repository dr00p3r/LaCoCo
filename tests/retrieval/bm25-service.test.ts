import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Bm25Service } from "../../src/retriever/utilities/search/bm25-service.js";
import type { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { createGraphDb } from "./test-helpers.js";

describe("Bm25Service", () => {
  let db: LaCoCoDatabase;
  let service: Bm25Service;

  beforeEach(() => {
    db = createGraphDb();
    service = new Bm25Service(db);
  });

  afterEach(() => {
    db.close();
  });

  it("recupera hits con firmas y scores normalizados", () => {
    const hits = service.search("OrderService", 10);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.nodeId).toContain("OrderService");
    expect(hits[0]!.score).toBeGreaterThanOrEqual(0);
    expect(hits[0]!.score).toBeLessThanOrEqual(1);
    expect(hits[0]!.text).toContain("OrderService");
  });

  it("convierte hits a chunks con source configurable", () => {
    const chunks = service.toChunks(service.search("OrderService", 10), "TEST");

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.source).toBe("TEST");
  });

});
