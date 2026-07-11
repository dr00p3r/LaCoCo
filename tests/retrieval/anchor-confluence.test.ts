import { describe, it, expect } from "vitest";
import {
  dijkstra,
  buildUndirectedAdjacency,
  anchorConfluence,
  reciprocalRankFusion,
  type WeightedEdge,
} from "../../src/retriever/strategies/helpers/anchor-confluence.js";

const OPTS = { pathDecay: 0.6, hubDampening: 0 };
const NO_DEGREE = new Map<string, number>();

describe("dijkstra", () => {
  it("calcula distancias más cortas sobre grafo no dirigido ponderado", () => {
    const adj = buildUndirectedAdjacency([
      { a: "A", b: "H", weight: 1 },
      { a: "H", b: "B", weight: 1 },
      { a: "A", b: "B", weight: 5 },
    ]);
    const { dist, prev } = dijkstra(adj, "A");
    expect(dist.get("A")).toBe(0);
    expect(dist.get("H")).toBe(1);
    expect(dist.get("B")).toBe(2); // A-H-B (2) < A-B directo (5)
    expect(prev.get("B")).toBe("H"); // el camino corto pasa por H
  });

  it("nodos inalcanzables quedan sin distancia", () => {
    const adj = buildUndirectedAdjacency([{ a: "A", b: "B", weight: 1 }]);
    const { dist } = dijkstra(adj, "A");
    expect(dist.has("Z")).toBe(false);
  });
});

describe("anchorConfluence", () => {
  it("acredita el nodo INTERNO que conecta dos anclas", () => {
    const edges: WeightedEdge[] = [
      { a: "A", b: "H", weight: 1 },
      { a: "H", b: "B", weight: 1 },
      { a: "A", b: "X", weight: 1 }, // hoja colgante de A (no conecta a B)
    ];
    const conf = anchorConfluence(edges, [{ id: "A", score: 1 }, { id: "B", score: 1 }], NO_DEGREE, OPTS);
    expect(conf.get("H")).toBeGreaterThan(0);
    expect(conf.has("X")).toBe(false); // X no está en ningún camino entre anclas
    expect(conf.has("A")).toBe(false); // los extremos no reciben crédito
    expect(conf.has("B")).toBe(false);
  });

  it("el costo tipado hace que el conector barato gane al caro", () => {
    const edges: WeightedEdge[] = [
      { a: "A", b: "Hcheap", weight: 1 },
      { a: "Hcheap", b: "B", weight: 1 }, // camino barato (costo 2)
      { a: "A", b: "Hpricey", weight: 5 },
      { a: "Hpricey", b: "B", weight: 5 }, // camino caro (costo 10)
    ];
    const conf = anchorConfluence(edges, [{ id: "A", score: 1 }, { id: "B", score: 1 }], NO_DEGREE, OPTS);
    expect(conf.get("Hcheap")).toBeGreaterThan(0);
    expect(conf.has("Hpricey")).toBe(false); // no está en el camino más corto
  });

  it("anclas adyacentes (sin nodo interno) no generan confluencia", () => {
    const conf = anchorConfluence(
      [{ a: "A", b: "B", weight: 1 }],
      [{ id: "A", score: 1 }, { id: "B", score: 1 }],
      NO_DEGREE,
      OPTS,
    );
    expect(conf.size).toBe(0);
  });

  it("<2 anclas → sin confluencia", () => {
    expect(anchorConfluence([{ a: "A", b: "H", weight: 1 }], [{ id: "A", score: 1 }], NO_DEGREE, OPTS).size).toBe(0);
  });

  it("anclas desconectadas no contribuyen", () => {
    const conf = anchorConfluence(
      [{ a: "A", b: "H", weight: 1 }, { a: "B", b: "K", weight: 1 }], // dos componentes
      [{ id: "A", score: 1 }, { id: "B", score: 1 }],
      NO_DEGREE,
      OPTS,
    );
    expect(conf.size).toBe(0);
  });

  it("la amortiguación de hubs reduce el score de un conector de alto grado", () => {
    const edges: WeightedEdge[] = [{ a: "A", b: "H", weight: 1 }, { a: "H", b: "B", weight: 1 }];
    const anchors = [{ id: "A", score: 1 }, { id: "B", score: 1 }];
    const plain = anchorConfluence(edges, anchors, NO_DEGREE, { pathDecay: 0.6, hubDampening: 0 });
    const damped = anchorConfluence(edges, anchors, new Map([["H", 50]]), { pathDecay: 0.6, hubDampening: 1 });
    expect(damped.get("H")!).toBeLessThan(plain.get("H")!);
  });

  it("es determinista", () => {
    const edges: WeightedEdge[] = [{ a: "A", b: "H", weight: 1 }, { a: "H", b: "B", weight: 1 }];
    const anchors = [{ id: "A", score: 0.9 }, { id: "B", score: 0.7 }];
    const first = anchorConfluence(edges, anchors, NO_DEGREE, OPTS);
    const second = anchorConfluence(edges, anchors, NO_DEGREE, OPTS);
    expect(first.get("H")).toBe(second.get("H"));
  });
});

describe("reciprocalRankFusion", () => {
  it("un id top en AMBAS listas supera a uno top en una sola", () => {
    const fused = reciprocalRankFusion([["A", "B", "C"], ["A", "D", "E"]], 60);
    expect(fused.get("A")!).toBeGreaterThan(fused.get("B")!);
    expect(fused.get("A")!).toBeGreaterThan(fused.get("D")!);
  });

  it("respeta el rango dentro de una lista", () => {
    const fused = reciprocalRankFusion([["A", "B"]], 60);
    expect(fused.get("A")!).toBeGreaterThan(fused.get("B")!);
  });
});
