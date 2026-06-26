import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  Bm25Service,
  normalizeFts5Query,
} from "../../src/retriever/utilities/search/bm25-service.js";
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

  it("mantiene FTS sincronizado al actualizar y eliminar nodos", () => {
    const node = {
      id: "/tmp/fts.ts#SearchTarget",
      kind: "CLASS",
      name: "SearchTarget",
      filepath: "/tmp/fts.ts",
      signature: "olduniqueterm",
      isDeprecated: 0,
    };

    db.insertNode(node);
    db.insertNode({ ...node, signature: "newuniqueterm" });

    expect(service.search("olduniqueterm")).toEqual([]);
    expect(service.search("newuniqueterm")).toHaveLength(1);

    db.deleteNodesByFile(node.filepath);
    expect(service.search("newuniqueterm")).toEqual([]);
  });

  it("normaliza caracteres especiales a sintaxis FTS5 segura", () => {
    expect(normalizeFts5Query("OrderService(save)")).toBe('"OrderService(save)"');
    expect(normalizeFts5Query("createOrder(dto: CreateOrderDto)")).toBe(
      '"createOrder(dto: CreateOrderDto)"'
    );
    expect(normalizeFts5Query('"OrderService" OR "`"')).toBe('"OrderService" OR "`"');
    expect(normalizeFts5Query('"OrderService" OR "save"')).toBe('"OrderService" OR "save"');
  });

  it("no lanza errores FTS5 con paréntesis, comillas, backticks, saltos de línea ni unicode", () => {
    const queries = [
      "OrderService(save)",
      "OrderService(createOrder(dto))",
      "OrderService's save",
      'OrderService "save"',
      "`",
      "OrderService\ncreateOrder",
      "qué hace OrderService",
    ];

    for (const query of queries) {
      const hits = service.search(query);
      expect(hits).toBeInstanceOf(Array);
      expect(hits.length).toBeGreaterThanOrEqual(0);
      for (const hit of hits) {
        expect(hit).toHaveProperty("nodeId");
        expect(hit).toHaveProperty("score");
        expect(hit).toHaveProperty("text");
        expect(typeof hit.score).toBe("number");
      }
    }
  });

});
