import { describe, it, expect, beforeAll } from "vitest";
import { SqliteManager } from "../../src/shared/db/sqlite-manager.js";
import { BM25Strategy } from "../../src/retriever/strategies/bm25-strategy.js";
import type { SanitizerOutput } from "../../src/retriever/strategies/base.js";

describe("BM25Strategy", () => {
  let db: SqliteManager;
  let strategy: BM25Strategy;

  beforeAll(() => {
    // Base de datos en memoria para tests aislados
    db = new SqliteManager(":memory:");

    // Poblar nodos de prueba (los triggers FTS5 sincronizan automáticamente)
    db.insertNode({
      id: "file1#OrderService",
      kind: "CLASS",
      name: "OrderService",
      filepath: "/project/src/order.service.ts",
      signature: "class OrderService extends BaseService implements IHandler",
      isDeprecated: 0,
    });
    db.insertNode({
      id: "file1#OrderService.createOrder",
      kind: "METHOD",
      name: "createOrder",
      filepath: "/project/src/order.service.ts",
      signature: "createOrder(dto: CreateOrderDto): Promise<Order>",
      isDeprecated: 0,
    });
    db.insertNode({
      id: "file2#UserRepository",
      kind: "CLASS",
      name: "UserRepository",
      filepath: "/project/src/user.repo.ts",
      signature: "class UserRepository extends Repository<User>",
      isDeprecated: 0,
    });

    strategy = new BM25Strategy(db);
  });

  function makeQuery(text: string): SanitizerOutput {
    return {
      route: "RAG",
      clean_query: text.toLowerCase(),
      embedding_input: text,
      dimensions: ["CPG"],
      intent: "understand",
      confidence: 0.8,
    };
  }

  it("recupera nodos relevantes para query 'OrderService'", async () => {
    const result = await strategy.retrieve(makeQuery("OrderService"));
    expect(result.length).toBeGreaterThan(0);
    const ids = result.map((r) => r.nodeId);
    expect(ids).toContain("file1#OrderService");
  });

  it("recupera nodos relevantes para query 'createOrder'", async () => {
    const result = await strategy.retrieve(makeQuery("createOrder"));
    expect(result.length).toBeGreaterThan(0);
    const ids = result.map((r) => r.nodeId);
    expect(ids.some((id) => id.includes("createOrder"))).toBe(true);
  });

  it("devuelve scores entre 0 y 1", async () => {
    const result = await strategy.retrieve(makeQuery("OrderService"));
    for (const chunk of result) {
      expect(chunk.score).toBeGreaterThanOrEqual(0);
      expect(chunk.score).toBeLessThanOrEqual(1);
    }
  });

  it("marca source como BM25", async () => {
    const result = await strategy.retrieve(makeQuery("OrderService"));
    expect(result[0]!.source).toBe("BM25");
  });
});
