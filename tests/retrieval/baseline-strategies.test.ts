import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { RepographStrategy } from "../../src/retriever/strategies/repograph-strategy.js";
import { PprStrategy } from "../../src/retriever/strategies/ppr-strategy.js";
import type { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { createGraphDb, makeQuery } from "./test-helpers.js";

vi.mock("../../src/embeddings/embedding-generator.js", () => {
  class MockEmbeddingGenerator {
    generate = vi.fn().mockResolvedValue(new Float32Array(384));
  }
  return { EmbeddingGenerator: MockEmbeddingGenerator };
});

/**
 * Baselines de aislamiento del consenso (docs/posicionamiento-novedad.md):
 * repograph (grafo plano) y ppr (PageRank personalizado, estilo Aider). Ambos
 * expanden desde las anclas híbridas pero SIN ponderación por intención — ese es
 * el eje que los diferencia de consensus.
 */
describe("estrategias baseline (repograph, ppr)", () => {
  let db: LaCoCoDatabase;
  let search: ReturnType<typeof vi.fn>;
  let lanceDb: LaCoCoLanceDb;

  beforeEach(() => {
    db = createGraphDb();
    search = vi.fn().mockResolvedValue([
      { node_id: "file1#OrderService.createOrder", score: 0.9 },
    ]);
    lanceDb = { search } as unknown as LaCoCoLanceDb;
  });

  afterEach(() => {
    db.close();
  });

  it("repograph expande el ego-graph plano desde las anclas", async () => {
    const chunks = await new RepographStrategy(db, lanceDb, {
      anchorLimit: 10,
      maxHops: 2,
    }).retrieve(makeQuery("OrderService", ["CPG"]));

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.source).toBe("REPOGRAPH");
    expect(chunks[0]!.score).toBeGreaterThan(0);
    // El ancla debe seguir siendo el head (proximidad 0 hops = score máximo).
    expect(chunks[0]!.nodeId).toBe("file1#OrderService.createOrder");
    // Alcanza vecinos que el anclaje no vio (p.ej. el caller OrderService).
    expect(chunks.map((c) => c.nodeId)).toContain("file1#OrderService");
    expect(search).toHaveBeenCalledWith(expect.any(Float32Array), undefined, 10);
  });

  it("ppr rankea por centralidad personalizada hacia las anclas", async () => {
    const chunks = await new PprStrategy(db, lanceDb, {
      anchorLimit: 10,
      subgraphMaxHops: 3,
    }).retrieve(makeQuery("OrderService", ["CPG"]));

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.source).toBe("PPR");
    expect(chunks[0]!.score).toBeGreaterThan(0);
    // Recupera vecinos multi-hop del subgrafo inducido.
    expect(chunks.map((c) => c.nodeId)).toContain("file1#OrderService");
    expect(search).toHaveBeenCalledWith(expect.any(Float32Array), undefined, 10);
  });

  it("ninguno depende de la intención de la query (agnósticos a la dimensión)", async () => {
    const rankFor = async (make: () => RepographStrategy | PprStrategy, dims: ("SYS" | "CPG" | "DTG")[]) =>
      (await make().retrieve(makeQuery("OrderService", dims))).map((c) => c.nodeId);

    const repoCpg = await rankFor(() => new RepographStrategy(db, lanceDb, { anchorLimit: 10 }), ["CPG"]);
    const repoDtg = await rankFor(() => new RepographStrategy(db, lanceDb, { anchorLimit: 10 }), ["DTG"]);
    expect(repoCpg).toEqual(repoDtg);

    const pprCpg = await rankFor(() => new PprStrategy(db, lanceDb, { anchorLimit: 10 }), ["CPG"]);
    const pprDtg = await rankFor(() => new PprStrategy(db, lanceDb, { anchorLimit: 10 }), ["DTG"]);
    expect(pprCpg).toEqual(pprDtg);
  });

  it("degradan a las anclas cuando no hay vecindad útil", async () => {
    // Nodo huérfano (sin aristas incidentes) → la expansión de grafo no aporta nada.
    db.insertNode({
      id: "file9#Orphan",
      kind: "FUNCTION",
      name: "orphan",
      filepath: "/project/src/orphan.ts",
      signature: "function orphan(): void",
      isDeprecated: 0,
    });
    search.mockResolvedValue([{ node_id: "file9#Orphan", score: 0.7 }]);

    const repo = await new RepographStrategy(db, lanceDb, { anchorLimit: 10 })
      .retrieve(makeQuery("orphan", ["DTG"]));
    expect(repo).toHaveLength(1);
    expect(repo[0]!.nodeId).toBe("file9#Orphan");
    expect(repo[0]!.source).toBe("REPOGRAPH");

    const ppr = await new PprStrategy(db, lanceDb, { anchorLimit: 10 })
      .retrieve(makeQuery("orphan", ["DTG"]));
    expect(ppr).toHaveLength(1);
    expect(ppr[0]!.nodeId).toBe("file9#Orphan");
    expect(ppr[0]!.source).toBe("PPR");
  });
});
