import { describe, it, expect, afterEach, vi } from "vitest";
import {
  IctdStrategy,
  ICTD_DEFAULT_CONFIG,
} from "../../src/retriever/strategies/ictd-strategy.js";
import type { IctdConfig } from "../../src/retriever/strategies/ictd-strategy.js";
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
 * Sonda determinista: expone `expand` (protected) para fijar el calor inicial de
 * las anclas y ejercitar las ramas de la difusión (fuente sin calor, objetivo
 * frío, dimensiones vacías, convergencia, filtro de temperatura mínima).
 */
class ProbeIctd extends IctdStrategy {
  runExpand(anchors: HybridAnchor[], query: SanitizerOutput): Promise<ContextChunk[]> {
    return this.expand(anchors, query);
  }
}

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

describe("IctdStrategy — configuración", () => {
  it("expone la config por defecto congelada con los valores del contrato", () => {
    // Arrange / Act
    // Assert
    expect(Object.isFrozen(ICTD_DEFAULT_CONFIG)).toBe(true);
    expect(ICTD_DEFAULT_CONFIG).toMatchObject({
      anchorLimit: 30,
      maxIterations: 10,
      restartProb: 0.2,
      epsilon: 1e-6,
      chunkLimit: 50,
      bfsMaxNodes: 5000,
      maxHops: 2,
    } satisfies IctdConfig);
  });

  it("propaga el anchorLimit por defecto (30) al buscador vectorial", async () => {
    // Arrange
    const db = createGraph(["fa#A"], []);
    const lanceDb = stubLanceDb([{ node_id: "fa#A", score: 0.9 }]);
    // Act
    await new IctdStrategy(db, lanceDb).retrieve(makeQueryIntent("understand", ["CPG"]));
    // Assert
    expect(lanceDb.search).toHaveBeenCalledWith(expect.any(Float32Array), undefined, 30);
    db.close();
  });
});

describe("IctdStrategy — difusión determinista (ramas)", () => {
  let db: LaCoCoDatabase;

  afterEach(() => {
    db.close();
  });

  it("degrada a vacío cuando no hay anclas (subgrafo vacío)", async () => {
    // Arrange — sin anclas el subgrafo BFS no tiene raíces → outAdj vacío.
    db = createGraph(["fa#A"], []);
    const probe = new ProbeIctd(db, stubLanceDb());
    // Act
    const chunks = await probe.runExpand([], makeQueryIntent("understand", ["CPG"]));
    // Assert
    expect(chunks).toEqual([]);
  });

  it("difunde calor por la cadena, ignora relaciones sin dimensión y descarta nodos fríos", async () => {
    // Arrange — cadena A→B→C (CPG); A tiene un segundo hijo mapeado (E, DTG) para
    // reusar su entrada en outAdj; C recibe dos aristas entrantes (grado in>1);
    // A→D con relación MYSTERY (sin dimensión) → D queda aislado y frío.
    db = createGraph(
      ["fa#A", "fb#B", "fc#C", "fd#D", "fe#E"],
      [
        { from: "fa#A", to: "fb#B", relation: "CALLS" }, // CPG
        { from: "fa#A", to: "fe#E", relation: "CONSUMES_DATA" }, // 2º hijo de A (DTG)
        { from: "fb#B", to: "fc#C", relation: "CALLS" }, // CPG (hop2)
        { from: "fe#E", to: "fc#C", relation: "CALLS" }, // 2ª entrante a C → inDeg>1
        { from: "fa#A", to: "fd#D", relation: "MYSTERY" }, // sin dimensión → D aislado y frío
      ],
    );
    const probe = new ProbeIctd(db, stubLanceDb());

    // Act — una sola ancla caliente propaga a sus vecinos por iteración.
    const chunks = await probe.runExpand(
      [anchor("fa#A", 0.9)],
      makeQueryIntent("understand", ["CPG"]),
    );

    // Assert
    const ids = chunks.map((chunk) => chunk.nodeId);
    // El ancla caliente y los nodos alcanzados por difusión sobreviven al filtro.
    expect(ids).toContain("fa#A");
    // D nunca recibe calor (relación no mapeada) → filtrado por temperatura mínima.
    expect(ids).not.toContain("fd#D");
    expect(chunks.every((chunk) => chunk.source === "ICTD")).toBe(true);
    expect(chunks.every((chunk) => chunk.score > 0.001)).toBe(true);
  });

  it("usa el id como texto cuando el nodo difundido carece de firma", async () => {
    // Arrange — 'gh#ghost' es referenciado por una arista pero NO existe como nodo,
    // así que no tiene firma; recibe calor del ancla y entra en el ranking.
    db = createGraph(
      ["fa#A"],
      [{ from: "fa#A", to: "gh#ghost", relation: "CALLS" }],
    );
    const probe = new ProbeIctd(db, stubLanceDb());

    // Act
    const chunks = await probe.runExpand(
      [anchor("fa#A", 0.9)],
      makeQueryIntent("understand", ["CPG"]),
    );

    // Assert — el ghost aparece con el id como texto (fallback de firma).
    const ghost = chunks.find((chunk) => chunk.nodeId === "gh#ghost");
    expect(ghost).toBeDefined();
    expect(ghost!.text).toBe("gh#ghost");
  });

  it("converge y corta antes de agotar las iteraciones (epsilon holgado)", async () => {
    // Arrange — con un epsilon grande el bucle de difusión rompe en la 1ª pasada.
    db = createGraph(
      ["fa#A", "fb#B"],
      [{ from: "fa#A", to: "fb#B", relation: "CALLS" }],
    );
    const probe = new ProbeIctd(db, stubLanceDb(), { epsilon: 1e3, maxIterations: 10 });

    // Act
    const chunks = await probe.runExpand(
      [anchor("fa#A", 0.9)],
      makeQueryIntent("understand", ["CPG"]),
    );

    // Assert — devuelve resultados sin colgarse (convergencia temprana).
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]!.source).toBe("ICTD");
  });

  it("agota las iteraciones sin converger cuando maxIterations es 1", async () => {
    // Arrange — una sola iteración: el bucle termina por cuenta, no por epsilon.
    db = createGraph(
      ["fa#A", "fb#B", "fc#C"],
      [
        { from: "fa#A", to: "fb#B", relation: "CALLS" },
        { from: "fb#B", to: "fc#C", relation: "CALLS" },
      ],
    );
    const probe = new ProbeIctd(db, stubLanceDb(), { maxIterations: 1, epsilon: 1e-9 });

    // Act
    const chunks = await probe.runExpand(
      [anchor("fa#A", 0.9)],
      makeQueryIntent("debug", ["CPG"]),
    );

    // Assert — tras una única pasada el ancla sigue presente en el ranking.
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.map((chunk) => chunk.nodeId)).toContain("fa#A");
  });
});
