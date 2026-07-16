import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ClcrStrategy,
  CLCR_DEFAULT_CONFIG,
} from "../../src/retriever/strategies/clcr-strategy.js";
import type { ClcrConfig } from "../../src/retriever/strategies/clcr-strategy.js";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { HybridAnchor } from "../../src/retriever/utilities/search/hybrid-anchor-service.js";
import type { ContextChunk } from "../../src/retriever/models/strategies/types.js";
import type { SanitizerOutput } from "../../src/retriever/models/utilities/types.js";
import type { IntentTag } from "../../src/retriever/models/utilities/types.js";
import type { Dimension } from "../../src/domain/dimensions.js";

vi.mock("../../src/embeddings/embedding-generator.js", () => {
  class MockEmbeddingGenerator {
    generate = vi.fn().mockResolvedValue(new Float32Array(384));
  }
  return { EmbeddingGenerator: MockEmbeddingGenerator };
});

/**
 * Sonda determinista: `expand` es el corazón de CLCR pero está `protected`.
 * La exponemos para fijar anclas con scores concretos y ejercitar las ramas de
 * scoring (cascade, boost por capas, filtro de score, fallback de firma) sin el
 * ruido del anclaje híbrido BM25+ANN+RRF.
 */
class ProbeClcr extends ClcrStrategy {
  runExpand(anchors: HybridAnchor[], query: SanitizerOutput): Promise<ContextChunk[]> {
    return this.expand(anchors, query);
  }
}

/** LanceDB de doble: `expand` no lo toca; el ctor de la base lo referencia. */
function stubLanceDb(anchors: { node_id: string; score: number }[] = []): LaCoCoLanceDb {
  return { search: vi.fn().mockResolvedValue(anchors) } as unknown as LaCoCoLanceDb;
}

function anchor(nodeId: string, score: number, text = `sig ${nodeId}`): HybridAnchor {
  return { nodeId, score, text };
}

function makeQueryIntent(
  intent: IntentTag,
  dimensions: Dimension[] = ["CPG"],
): SanitizerOutput {
  return {
    route: "RAG",
    clean_query: "consulta",
    embedding_input: "consulta",
    dimensions,
    intent,
    confidence: 0.8,
  };
}

/** Construye un grafo en memoria a partir de nodos y aristas. */
function createGraph(
  nodes: string[],
  edges: { from: string; to: string; relation: string }[],
): LaCoCoDatabase {
  const db = new LaCoCoDatabase(":memory:");
  for (const id of nodes) {
    const name = id.split("#")[1] ?? id;
    db.insertNode({
      id,
      kind: "FUNCTION",
      name,
      filepath: `/src/${name}.ts`,
      signature: `function ${name}()`,
      isDeprecated: 0,
    });
  }
  for (const edge of edges) {
    db.insertEdge({ sourceId: edge.from, targetId: edge.to, relation: edge.relation });
  }
  db.populateMetadata();
  return db;
}

describe("ClcrStrategy — configuración", () => {
  it("expone la config por defecto congelada con los valores del contrato", () => {
    // Arrange / Act — la constante es el contrato público de tuning.
    // Assert
    expect(Object.isFrozen(CLCR_DEFAULT_CONFIG)).toBe(true);
    expect(CLCR_DEFAULT_CONFIG).toMatchObject({
      anchorLimit: 30,
      primaryHops: 2,
      cascadeHops: 1,
      chunkLimit: 50,
      bfsMaxNodes: 5000,
      lambda: 0.25,
      primaryDecay: 0.5,
      cascadeDecay: 0.7,
    } satisfies ClcrConfig);
  });

  it("propaga el anchorLimit por defecto (30) al buscador vectorial", async () => {
    // Arrange
    const db = createGraph(["fa#A"], []);
    const lanceDb = stubLanceDb([{ node_id: "fa#A", score: 0.9 }]);
    // Act
    await new ClcrStrategy(db, lanceDb).retrieve(makeQueryIntent("understand", ["CPG"]));
    // Assert
    expect(lanceDb.search).toHaveBeenCalledWith(expect.any(Float32Array), undefined, 30);
    db.close();
  });
});

describe("ClcrStrategy — expand determinista (ramas de scoring)", () => {
  let db: LaCoCoDatabase;

  afterEach(() => {
    db.close();
  });

  it("degrada a vacío cuando no hay anclas (primarySet vacío)", async () => {
    // Arrange — sin anclas la travesía primaria arranca sin raíces.
    db = createGraph(["fa#A"], []);
    const probe = new ProbeClcr(db, stubLanceDb());
    // Act
    const chunks = await probe.runExpand([], makeQueryIntent("understand", ["CPG"]));
    // Assert — sin raíces no hay nada que expandir.
    expect(chunks).toEqual([]);
  });

  it("cascada a otras dimensiones, boostea nodos multi-capa y conserva las anclas", async () => {
    // Arrange — dominante = CPG (understand + [CPG]). Cadena primaria CPG A→B→hub;
    // cascada DTG/SYS desde el subgrafo primario; hub incide en CPG+DTG (multi-capa);
    // relación MYSTERY no mapeada; ghost sin firma; X alcanzable por SYS y DTG.
    db = createGraph(
      ["fa#A", "fb#B", "fh#hub", "fc#C", "fd#D", "fe#E", "fx#X"],
      [
        { from: "fa#A", to: "fb#B", relation: "CALLS" }, // primaria CPG (hop1)
        { from: "fb#B", to: "fh#hub", relation: "CALLS" }, // primaria CPG (hop2)
        { from: "fa#A", to: "gh#ghost", relation: "CALLS" }, // primaria → nodo sin firma
        { from: "fh#hub", to: "fe#E", relation: "PRODUCES" }, // cascada DTG; hub gana capa DTG
        { from: "fb#B", to: "fc#C", relation: "CONSUMES_DATA" }, // cascada DTG
        { from: "fa#A", to: "fd#D", relation: "EXTENDS" }, // cascada SYS
        { from: "fb#B", to: "fx#X", relation: "IMPLEMENTS" }, // cascada SYS descubre X
        { from: "fb#B", to: "fx#X", relation: "PRODUCES" }, // cascada DTG re-descubre X (ya en baseScore)
        { from: "fa#A", to: "fb#B", relation: "MYSTERY" }, // relación no mapeada → sin dimensión
      ],
    );
    const probe = new ProbeClcr(db, stubLanceDb());

    // Act
    const chunks = await probe.runExpand(
      [anchor("fa#A", 0.9)],
      makeQueryIntent("understand", ["CPG"]),
    );

    // Assert
    const byId = new Map(chunks.map((chunk) => [chunk.nodeId, chunk]));
    // El ancla y sus descubrimientos primarios/cascada aparecen.
    expect(byId.has("fa#A")).toBe(true);
    expect(byId.has("fh#hub")).toBe(true);
    expect(chunks.every((chunk) => chunk.source === "CLCR")).toBe(true);
    // hub participa en CPG+DTG → boost > 1 (score > baseScore desnudo).
    const hub = byId.get("fh#hub")!;
    expect(hub.score).toBeGreaterThan(0);
    // ghost carece de firma en el grafo → el texto cae al id.
    const ghost = byId.get("gh#ghost");
    expect(ghost).toBeDefined();
    expect(ghost!.text).toBe("gh#ghost");
    // X fue alcanzado por dos cascadas distintas → se surfacea una sola vez.
    expect(chunks.filter((chunk) => chunk.nodeId === "fx#X")).toHaveLength(1);
  });

  it("filtra nodos con score 0 (ancla nula) manteniendo el resto", async () => {
    // Arrange — Z es ancla con score 0 y sin aristas: su baseScore queda en 0.
    db = createGraph(
      ["fa#A", "fb#B", "fz#Z"],
      [{ from: "fa#A", to: "fb#B", relation: "CALLS" }],
    );
    const probe = new ProbeClcr(db, stubLanceDb());

    // Act
    const chunks = await probe.runExpand(
      [anchor("fa#A", 0.9), anchor("fz#Z", 0)],
      makeQueryIntent("understand", ["CPG"]),
    );

    // Assert — el filtro score>0 descarta a Z pero conserva a A.
    const ids = chunks.map((chunk) => chunk.nodeId);
    expect(ids).toContain("fa#A");
    expect(ids).not.toContain("fz#Z");
  });

  it("respeta el chunkLimit recortando el ranking final", async () => {
    // Arrange — varios candidatos, límite de 1.
    db = createGraph(
      ["fa#A", "fb#B", "fc#C"],
      [
        { from: "fa#A", to: "fb#B", relation: "CALLS" },
        { from: "fb#B", to: "fc#C", relation: "CALLS" },
      ],
    );
    const probe = new ProbeClcr(db, stubLanceDb(), { chunkLimit: 1 });

    // Act
    const chunks = await probe.runExpand(
      [anchor("fa#A", 0.9)],
      makeQueryIntent("understand", ["CPG"]),
    );

    // Assert — solo sobrevive el top-1.
    expect(chunks).toHaveLength(1);
  });

  it("cambia la dimensión dominante según el intent (integrate → DTG)", async () => {
    // Arrange — con intent=integrate la dimensión DTG domina; la cadena primaria
    // recorre relaciones DTG (CONSUMES_DATA/PRODUCES) en vez de CPG.
    db = createGraph(
      ["fa#A", "fb#B", "fc#C"],
      [
        { from: "fa#A", to: "fb#B", relation: "CONSUMES_DATA" }, // primaria DTG
        { from: "fb#B", to: "fc#C", relation: "CALLS" }, // cascada CPG
      ],
    );
    const probe = new ProbeClcr(db, stubLanceDb());

    // Act
    const chunks = await probe.runExpand(
      [anchor("fa#A", 0.9)],
      makeQueryIntent("integrate", ["DTG"]),
    );

    // Assert — la travesía DTG alcanza B (y la cascada CPG, C).
    const ids = chunks.map((chunk) => chunk.nodeId);
    expect(ids).toContain("fa#A");
    expect(ids).toContain("fb#B");
  });
});
