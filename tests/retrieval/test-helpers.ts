import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { SanitizerOutput } from "../../src/retriever/models/utilities/types.js";

export function createGraphDb(): LaCoCoDatabase {
  const db = new LaCoCoDatabase(":memory:");

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
    id: "file1#CreateOrderDto",
    kind: "TYPE",
    name: "CreateOrderDto",
    filepath: "/project/src/order.dto.ts",
    signature: "type CreateOrderDto = { amount: number }",
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
  db.insertNode({
    id: "file3#Result",
    kind: "TYPE",
    name: "Result",
    filepath: "/project/src/result.ts",
    signature: "type Result<T> = { ok: boolean; value?: T }",
    isDeprecated: 0,
  });

  db.insertEdge({
    sourceId: "file1#OrderService",
    targetId: "file1#OrderService.createOrder",
    relation: "CALLS",
  });
  db.insertEdge({
    sourceId: "file1#OrderService.createOrder",
    targetId: "file1#CreateOrderDto",
    relation: "CONSUMES_DATA",
  });
  db.insertEdge({
    sourceId: "file1#OrderService.createOrder",
    targetId: "file3#Result",
    relation: "PRODUCES",
  });
  db.insertEdge({
    sourceId: "file2#UserRepository",
    targetId: "file1#OrderService",
    relation: "IMPORTS_EXTERNAL",
  });

  db.populateMetadata();
  return db;
}

export function makeQuery(
  text: string,
  dimensions: ("SYS" | "CPG" | "DTG")[] = ["CPG"]
): SanitizerOutput {
  return {
    route: "RAG",
    clean_query: text.toLowerCase(),
    embedding_input: text,
    dimensions,
    intent: "understand",
    confidence: 0.8,
  };
}
