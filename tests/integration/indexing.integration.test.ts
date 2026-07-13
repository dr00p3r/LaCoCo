import * as lancedb from "@lancedb/lancedb";
import { describe, expect, it } from "vitest";
import {
  createIntegrationProject,
  findNodeByName,
  hasEdge,
  indexGraph,
  indexVectors,
  withGraph,
} from "./helpers.js";

describe("LaCoCo indexing integration", () => {
  it("indexes a fixture project into SQLite with searchable nodes and typed edges", () => {
    const project = createIntegrationProject("lacoco-indexing-");
    try {
      indexGraph(project);

      withGraph(project.dbPath, (db) => {
        expect(findNodeByName(db, "OrderService")).toMatchObject({ kind: "CLASS" });
        expect(findNodeByName(db, "createOrder")).toMatchObject({ kind: "METHOD" });
        expect(findNodeByName(db, "CreateOrderDto")).toMatchObject({ kind: "INTERFACE" });
        expect(findNodeByName(db, "findCustomer")).toBeTruthy();

        expect(hasEdge(db, "OrderService", "createOrder", "DECLARES")).toBe(true);
        expect(hasEdge(db, "createOrder", "findCustomer", "CALLS")).toBe(true);
        expect(hasEdge(db, "createOrder", "CreateOrderDto", "CONSUMES_DATA")).toBe(true);

        const symbolHit = db.prepare("SELECT node_id FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT 1").get("OrderService");
        const pathHit = db.prepare("SELECT node_id FROM nodes_fts WHERE nodes_fts MATCH ? LIMIT 1").get("order");
        expect(symbolHit).toBeDefined();
        expect(pathHit).toBeDefined();
      });
    } finally {
      project.cleanup();
    }
  });

  it("indexes deterministic embeddings into a real LanceDB table", async () => {
    const project = createIntegrationProject("lacoco-vectors-");
    try {
      indexVectors(project);

      const db = await lancedb.connect(project.lanceDbPath);
      try {
        const table = await db.openTable("node_embeddings");
        const rows = await table.query().limit(20).toArray();
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.map((row) => row.node_id)).toContain(project.orderServicePath + "#OrderService");
      } finally {
        await db.close();
      }
    } finally {
      project.cleanup();
    }
  });
});
