import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { HybridAnchorService } from "../../src/retriever/utilities/search/hybrid-anchor-service.js";
import type { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { PropositionsSearcher } from "../../src/persistence/lacoco-propositions-manager/lacoco-propositions-db.js";
import type { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { createGraphDb, makeQuery } from "./test-helpers.js";

// Embeddings deterministas sin cargar el modelo.
beforeAll(() => {
  process.env.LACOCO_TEST_EMBEDDINGS = "1";
});

afterEach(() => {
  delete process.env.LACOCO_PROPOSITIONS;
});

// Devuelve un nodo de código (createOrder) por ANN; ninguna coincidencia BM25
// para la query usada, de modo que UserRepository solo puede entrar por el canal
// de proposiciones.
function annLanceDb(): LaCoCoLanceDb {
  return {
    search: vi.fn().mockResolvedValue([
      { node_id: "file1#OrderService.createOrder", score: 0.9, dimension: "CPG" },
    ]),
  } as unknown as LaCoCoLanceDb;
}

describe("HybridAnchorService — canal de proposiciones (C2)", () => {
  let db: LaCoCoDatabase;
  beforeAll(() => { db = createGraphDb(); });

  it("con el flag ON, una proposición rescata un nodo ausente de BM25/ANN", async () => {
    process.env.LACOCO_PROPOSITIONS = "1";
    const propositions: PropositionsSearcher = {
      search: vi.fn().mockResolvedValue([{ realNodeId: "file2#UserRepository", score: 0.95 }]),
    };
    const service = new HybridAnchorService(db, annLanceDb(), propositions);

    const anchors = await service.search(makeQuery("zzznomatchquery"), 20);
    const ids = anchors.map((a) => a.nodeId);

    expect(propositions.search).toHaveBeenCalled();
    expect(ids).toContain("file2#UserRepository"); // rescatado por proposición
    expect(ids).toContain("file1#OrderService.createOrder"); // sigue el ANN
    // El ancla resuelve a su firma real (colapsó a real_node_id, no un fantasma).
    const rescued = anchors.find((a) => a.nodeId === "file2#UserRepository")!;
    expect(rescued.text).toContain("UserRepository");
  });

  it("con el flag OFF, el canal no se consulta y el resultado es el previo", async () => {
    const propositions: PropositionsSearcher = {
      search: vi.fn().mockResolvedValue([{ realNodeId: "file2#UserRepository", score: 0.95 }]),
    };
    const service = new HybridAnchorService(db, annLanceDb(), propositions);

    const anchors = await service.search(makeQuery("zzznomatchquery"), 20);

    expect(propositions.search).not.toHaveBeenCalled();
    expect(anchors.map((a) => a.nodeId)).not.toContain("file2#UserRepository");
  });

  it("es best-effort: si el canal falla, el anclaje no se rompe", async () => {
    process.env.LACOCO_PROPOSITIONS = "1";
    const propositions: PropositionsSearcher = {
      search: vi.fn().mockRejectedValue(new Error("boom")),
    };
    const service = new HybridAnchorService(db, annLanceDb(), propositions);

    const anchors = await service.search(makeQuery("zzznomatchquery"), 20);

    expect(anchors.map((a) => a.nodeId)).toContain("file1#OrderService.createOrder");
  });

  it("sin searcher (undefined) el flag ON no tiene efecto", async () => {
    process.env.LACOCO_PROPOSITIONS = "1";
    const service = new HybridAnchorService(db, annLanceDb());

    const anchors = await service.search(makeQuery("zzznomatchquery"), 20);

    expect(anchors.map((a) => a.nodeId)).toContain("file1#OrderService.createOrder");
    expect(anchors.map((a) => a.nodeId)).not.toContain("file2#UserRepository");
  });
});
