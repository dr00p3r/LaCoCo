import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ConsensusStrategy,
  CONSENSUS_DEFAULT_CONFIG,
} from "../../src/retriever/strategies/consensus-strategy.js";
import type { ConsensusConfig } from "../../src/retriever/strategies/consensus-strategy.js";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { HybridAnchor } from "../../src/retriever/utilities/search/hybrid-anchor-service.js";
import type { ContextChunk } from "../../src/retriever/models/strategies/types.js";
import type { SanitizerOutput } from "../../src/retriever/models/utilities/types.js";
import { makeQuery } from "./test-helpers.js";

vi.mock("../../src/embeddings/embedding-generator.js", () => {
  class MockEmbeddingGenerator {
    generate = vi.fn().mockResolvedValue(new Float32Array(384));
  }
  return { EmbeddingGenerator: MockEmbeddingGenerator };
});

/**
 * Subclase de sondeo: `expand` es el corazón de ConsensusStrategy pero está
 * `protected`. La exponemos para ejercitar el scoring de consenso de forma
 * DETERMINISTA (anclas con scores fijos), sin pasar por el anclaje híbrido
 * BM25+ANN+RRF cuyos scores son ruidosos y difíciles de fijar en un test.
 */
class ProbeConsensus extends ConsensusStrategy {
  runExpand(anchors: HybridAnchor[], query: SanitizerOutput): Promise<ContextChunk[]> {
    return this.expand(anchors, query);
  }
}

/** Peso normalizado de la dimensión CPG para `intent=understand`, `dimensions=["CPG"]`. */
const CPG_WEIGHT = 0.525 / 1.175; // ≈ 0.446808 (ver getIntentWeights)

/** LanceDB de doble: `expand` no lo toca, pero el ctor de la base lo referencia. */
function stubLanceDb(anchors: { node_id: string; score: number }[] = []): LaCoCoLanceDb {
  return { search: vi.fn().mockResolvedValue(anchors) } as unknown as LaCoCoLanceDb;
}

function anchor(nodeId: string, score: number, text = `sig ${nodeId}`): HybridAnchor {
  return { nodeId, score, text };
}

/** Construye un grafo en memoria a partir de listas de nodos y aristas. */
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

describe("ConsensusStrategy — configuración", () => {
  it("expone la config por defecto congelada con los valores del contrato", () => {
    // Arrange / Act — la constante es el contrato público de tuning.
    // Assert
    expect(Object.isFrozen(CONSENSUS_DEFAULT_CONFIG)).toBe(true);
    expect(CONSENSUS_DEFAULT_CONFIG).toMatchObject({
      anchorLimit: 30,
      chunkLimit: 50,
      neighborhoodLimit: 5000,
      incomingWeight: 1.0,
      outgoingWeight: 0.4,
      consensusWeight: 1.0,
      multiAnchorBonus: 0.5,
      hubDampening: 0.5,
      interleaveMinAnchors: 2,
      topAnchorsProtected: 1,
    } satisfies ConsensusConfig);
  });
});

describe("ConsensusStrategy — integración vía retrieve", () => {
  let db: LaCoCoDatabase;

  beforeEach(() => {
    db = createGraph(
      ["fa#alpha", "fb#beta", "fn#nexus"],
      [
        { from: "fn#nexus", to: "fa#alpha", relation: "CALLS" },
        { from: "fn#nexus", to: "fb#beta", relation: "CALLS" },
      ],
    );
  });

  afterEach(() => {
    db.close();
  });

  it("usa el anchorLimit por defecto (30) para consultar el anclaje", async () => {
    // Arrange
    const lanceDb = stubLanceDb([{ node_id: "fa#alpha", score: 0.9 }]);
    // Act
    await new ConsensusStrategy(db, lanceDb).retrieve(makeQuery("alpha", ["CPG"]));
    // Assert — getAnchorLimit() propaga el default al buscador vectorial.
    expect(lanceDb.search).toHaveBeenCalledWith(expect.any(Float32Array), undefined, 30);
  });

  it("respeta un anchorLimit personalizado y surfacea el vecino de consenso", async () => {
    // Arrange — dos anclas que comparten un caller común (fn#nexus) que NO es ancla.
    const lanceDb = stubLanceDb([
      { node_id: "fa#alpha", score: 0.9 },
      { node_id: "fb#beta", score: 0.85 },
    ]);
    // Act
    const chunks = await new ConsensusStrategy(db, lanceDb, { anchorLimit: 7 })
      .retrieve(makeQuery("alpha beta", ["CPG"]));
    // Assert
    expect(lanceDb.search).toHaveBeenCalledWith(expect.any(Float32Array), undefined, 7);
    const ids = chunks.map((chunk) => chunk.nodeId);
    expect(ids).toContain("fn#nexus"); // el caller compartido se rescata por consenso
    const nexus = chunks.find((chunk) => chunk.nodeId === "fn#nexus")!;
    expect(nexus.source).toBe("CONSENSUS");
  });
});

describe("ConsensusStrategy — scoring de consenso (expand determinista)", () => {
  it("devuelve vacío cuando no hay anclas", async () => {
    // Arrange
    const db = createGraph(["fa#alpha"], []);
    const probe = new ProbeConsensus(db, stubLanceDb());
    // Act
    const chunks = await probe.runExpand([], makeQuery("x", ["CPG"]));
    // Assert
    expect(chunks).toEqual([]);
    db.close();
  });

  it("rescata el vecino ENTRANTE multi-ancla por encima del vecino SALIENTE débil", async () => {
    // Arrange — N es caller de A y B (entrante, 2 anclas); C es callee de A (saliente, 1 ancla).
    const db = createGraph(
      ["fa#A", "fb#B", "fn#N", "fc#C"],
      [
        { from: "fn#N", to: "fa#A", relation: "CALLS" }, // entrante a A
        { from: "fn#N", to: "fb#B", relation: "CALLS" }, // entrante a B  → N señalado por 2 anclas
        { from: "fa#A", to: "fc#C", relation: "CALLS" }, // saliente de A → C señalado por 1 ancla
      ],
    );
    const probe = new ProbeConsensus(db, stubLanceDb());

    // Act
    const chunks = await probe.runExpand(
      [anchor("fa#A", 0.9), anchor("fb#B", 0.85)],
      makeQuery("a b", ["CPG"]),
    );

    // Assert
    const ids = chunks.map((chunk) => chunk.nodeId);
    expect(ids).toEqual(["fa#A", "fb#B", "fn#N", "fc#C"]); // orden por score desc
    const byId = new Map(chunks.map((chunk) => [chunk.nodeId, chunk]));
    // Las anclas conservan su fuente RRF; los nodos de consenso se marcan CONSENSUS.
    expect(byId.get("fa#A")!.source).toBe("RRF");
    expect(byId.get("fn#N")!.source).toBe("CONSENSUS");
    expect(byId.get("fc#C")!.source).toBe("CONSENSUS");
    // El entrante multi-ancla puntúa por encima del saliente de una sola ancla.
    expect(byId.get("fn#N")!.score).toBeGreaterThan(byId.get("fc#C")!.score);
    // El saliente débil queda en la COLA: por debajo de la peor ancla (weakCap).
    const weakCap = 0.85 * 0.99;
    expect(byId.get("fc#C")!.score).toBeLessThan(weakCap);
    expect(byId.get("fc#C")!.score).toBeLessThan(byId.get("fb#B")!.score);
    // El texto del nodo de consenso viene de su firma (no de las anclas).
    expect(byId.get("fn#N")!.text).toBe("function N()");
    db.close();
  });

  it("degrada a las anclas (equivalente a hybrid) cuando la vecindad no aporta consenso", async () => {
    // Arrange — la única arista une DOS anclas → ni entrante ni saliente a un vecino.
    const db = createGraph(
      ["fa#A", "fb#B"],
      [{ from: "fa#A", to: "fb#B", relation: "CALLS" }],
    );
    const probe = new ProbeConsensus(db, stubLanceDb());

    // Act
    const chunks = await probe.runExpand(
      [anchor("fa#A", 0.9, "texto A"), anchor("fb#B", 0.85, "texto B")],
      makeQuery("a b", ["CPG"]),
    );

    // Assert — se devuelven las anclas tal cual, marcadas CONSENSUS.
    expect(chunks).toHaveLength(2);
    expect(chunks.map((chunk) => chunk.nodeId)).toEqual(["fa#A", "fb#B"]);
    expect(chunks.every((chunk) => chunk.source === "CONSENSUS")).toBe(true);
    // toChunk preserva score y texto del ancla original.
    expect(chunks[0]).toMatchObject({ nodeId: "fa#A", score: 0.9, text: "texto A" });
    db.close();
  });

  it("aplica peso relacional 1/3 a relaciones desconocidas (fuera de RELATION_TO_DIM)", async () => {
    // Arrange — relación no mapeada a ninguna dimensión.
    const db = createGraph(
      ["fa#A", "fu#U"],
      [{ from: "fu#U", to: "fa#A", relation: "MYSTERY" }],
    );
    const probe = new ProbeConsensus(db, stubLanceDb());

    // Act
    const chunks = await probe.runExpand([anchor("fa#A", 1.0)], makeQuery("a", ["CPG"]));

    // Assert — contribución = score(1) · incoming(1) · (1/3), amortiguada por grado(1).
    const u = chunks.find((chunk) => chunk.nodeId === "fu#U")!;
    expect(u.source).toBe("CONSENSUS");
    const expected = (1.0 * 1.0 * (1 / 3)) / (1 + 0.5 * Math.log2(2));
    expect(u.score).toBeCloseTo(expected, 5);
    db.close();
  });

  it("usa la firma como texto y cae al id cuando el nodo de consenso no tiene firma", async () => {
    // Arrange — el target 'gh#ghost' es referenciado por una arista pero NO existe como nodo.
    const db = createGraph(
      ["fa#A"],
      [{ from: "fa#A", to: "gh#ghost", relation: "CALLS" }],
    );
    const probe = new ProbeConsensus(db, stubLanceDb());

    // Act
    const chunks = await probe.runExpand([anchor("fa#A", 1.0, "sig A")], makeQuery("a", ["CPG"]));

    // Assert
    const ghost = chunks.find((chunk) => chunk.nodeId === "gh#ghost")!;
    expect(ghost).toBeDefined();
    expect(ghost.source).toBe("CONSENSUS");
    expect(ghost.text).toBe("gh#ghost"); // sin firma → fallback al id
    // El ancla mantiene su texto propio.
    expect(chunks.find((chunk) => chunk.nodeId === "fa#A")!.text).toBe("sig A");
    db.close();
  });

  it("descarta anclas con score 0 y consenso que colapsa a 0 (filtro score>0 + weakCap=0)", async () => {
    // Arrange — Z es ancla con score 0; N es vecino débil de A.
    const db = createGraph(
      ["fa#A", "fz#Z", "fn#N"],
      [{ from: "fn#N", to: "fa#A", relation: "CALLS" }],
    );
    const probe = new ProbeConsensus(db, stubLanceDb());

    // Act — con la peor ancla en 0, weakCap = 0·0.99 = 0 capa el consenso débil a 0.
    const chunks = await probe.runExpand(
      [anchor("fa#A", 0.9), anchor("fz#Z", 0)],
      makeQuery("a", ["CPG"]),
    );

    // Assert — solo sobrevive A; Z (score 0) y N (capado a 0) se filtran.
    expect(chunks.map((chunk) => chunk.nodeId)).toEqual(["fa#A"]);
    db.close();
  });

  it("la penalización de hubs baja el score; con hubDampening=0 se clampa al strongCap", async () => {
    // Arrange — N es caller de A y B (2 anclas de score alto). Reutilizamos el grafo.
    const build = () =>
      createGraph(
        ["fa#A", "fb#B", "fn#N"],
        [
          { from: "fn#N", to: "fa#A", relation: "CALLS" },
          { from: "fn#N", to: "fb#B", relation: "CALLS" },
        ],
      );
    const query = makeQuery("a b", ["CPG"]);
    const anchors = () => [anchor("fa#A", 10), anchor("fb#B", 9)];

    // Act — con dampening (default 0.5) vs sin dampening (0).
    const dampedDb = build();
    const damped = await new ProbeConsensus(dampedDb, stubLanceDb()).runExpand(anchors(), query);
    const rawDb = build();
    const raw = await new ProbeConsensus(rawDb, stubLanceDb(), { hubDampening: 0 }).runExpand(
      anchors(),
      query,
    );

    // Assert
    const nDamped = damped.find((chunk) => chunk.nodeId === "fn#N")!.score;
    const nRaw = raw.find((chunk) => chunk.nodeId === "fn#N")!.score;
    // Penalizar el hub reduce estrictamente el score de consenso.
    expect(nDamped).toBeLessThan(nRaw);
    // Sin dampening el consenso crece hasta topar el strongCap = 2ª ancla protegida (9).
    expect(nRaw).toBe(9);
    // La ancla top (10) nunca es desplazada por el consenso.
    expect(raw[0]!.nodeId).toBe("fa#A");
    expect(raw[0]!.score).toBe(10);
    dampedDb.close();
    rawDb.close();
  });

  it("interleaveMinAnchors decide si un vecino sube (strongCap) o se capa a la cola (weakCap)", async () => {
    // Arrange — 3 anclas con gap grande entre la 2ª (0.8) y la 3ª (0.1) para que
    // weakCap (0.1·0.99≈0.099) y strongCap (0.8) sean bien distintos. N es señalado
    // por 2 anclas (A y B).
    const build = () =>
      createGraph(
        ["fa#A", "fb#B", "fd#D", "fn#N"],
        [
          { from: "fn#N", to: "fa#A", relation: "CALLS" },
          { from: "fn#N", to: "fb#B", relation: "CALLS" },
        ],
      );
    const query = makeQuery("a b", ["CPG"]);
    const anchors = () => [anchor("fa#A", 0.9), anchor("fb#B", 0.8), anchor("fd#D", 0.1)];

    // Act — default (min=2, N con 2 hits INTERLEAVE) vs min=3 (N con 2 hits es DÉBIL).
    const interDb = build();
    const interleaved = await new ProbeConsensus(interDb, stubLanceDb()).runExpand(anchors(), query);
    const weakDb = build();
    const weak = await new ProbeConsensus(weakDb, stubLanceDb(), {
      interleaveMinAnchors: 3,
    }).runExpand(anchors(), query);

    // Assert
    const nInter = interleaved.find((chunk) => chunk.nodeId === "fn#N")!.score;
    const nWeak = weak.find((chunk) => chunk.nodeId === "fn#N")!.score;
    // Con el umbral por defecto N interleava (score de consenso pleno).
    expect(nInter).toBeGreaterThan(0.5);
    // Al exigir 3 anclas, N cae por debajo del strongCap y se capa a la cola (weakCap).
    expect(nWeak).toBeCloseTo(0.1 * 0.99, 5);
    expect(nWeak).toBeLessThan(nInter);
    interDb.close();
    weakDb.close();
  });
});
