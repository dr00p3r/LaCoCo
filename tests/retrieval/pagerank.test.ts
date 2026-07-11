import { describe, it, expect } from "vitest";
import { personalizedPageRank } from "../../src/retriever/strategies/helpers/pagerank.js";
import type { GraphEdge } from "../../src/persistence/lacoco-graph-manager/model/types.js";

const OPTS = { damping: 0.85, iterations: 100, tolerance: 1e-9 };

function edge(sourceId: string, targetId: string): GraphEdge {
  return { sourceId, targetId, relation: "CALLS" };
}

function sum(ranks: Map<string, number>): number {
  return [...ranks.values()].reduce((total, value) => total + value, 0);
}

describe("personalizedPageRank", () => {
  it("devuelve mapa vacío sin nodos", () => {
    expect(personalizedPageRank([], [], new Map(), OPTS).size).toBe(0);
  });

  it("los scores suman ≈ 1 (distribución de probabilidad)", () => {
    const nodes = ["a", "b", "c"];
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a")];
    const ranks = personalizedPageRank(nodes, edges, new Map(), OPTS);
    expect(sum(ranks)).toBeCloseTo(1, 6);
  });

  it("sin aristas, todos los nodos son colgantes → converge al vector de personalización", () => {
    const nodes = ["a", "b", "c"];
    const personalization = new Map([["a", 3], ["b", 1]]); // 0 en c
    const ranks = personalizedPageRank(nodes, [], personalization, OPTS);
    // Normalizado: a=0.75, b=0.25, c=0.
    expect(ranks.get("a")!).toBeCloseTo(0.75, 6);
    expect(ranks.get("b")!).toBeCloseTo(0.25, 6);
    expect(ranks.get("c")!).toBeCloseTo(0, 6);
  });

  it("la personalización sesga la masa hacia la semilla", () => {
    const nodes = ["a", "b", "c"];
    const edges = [edge("a", "b"), edge("b", "c")]; // c colgante
    const ranks = personalizedPageRank(nodes, edges, new Map([["a", 1]]), OPTS);
    // a es semilla de reinicio y receptor de la masa colgante de c → el más alto.
    expect(ranks.get("a")!).toBeGreaterThan(ranks.get("b")!);
    expect(ranks.get("a")!).toBeGreaterThan(ranks.get("c")!);
    expect(sum(ranks)).toBeCloseTo(1, 6);
  });

  it("con personalización uniforme, un nodo con más aristas entrantes rankea más alto", () => {
    const nodes = ["hub", "x", "y", "leaf"];
    const edges = [edge("x", "hub"), edge("y", "hub")]; // hub tiene 2 entrantes; leaf ninguna
    const ranks = personalizedPageRank(nodes, edges, new Map(), OPTS); // uniforme
    expect(ranks.get("hub")!).toBeGreaterThan(ranks.get("x")!);
    expect(ranks.get("hub")!).toBeGreaterThan(ranks.get("leaf")!);
  });

  it("es determinista: misma entrada → misma salida", () => {
    const nodes = ["a", "b", "c"];
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "a")];
    const first = personalizedPageRank(nodes, edges, new Map([["a", 1]]), OPTS);
    const second = personalizedPageRank(nodes, edges, new Map([["a", 1]]), OPTS);
    for (const id of nodes) expect(first.get(id)).toBe(second.get(id));
  });

  it("ignora aristas que apuntan fuera del subgrafo y los auto-lazos", () => {
    const nodes = ["a", "b"];
    const edges = [edge("a", "b"), edge("b", "outside"), edge("a", "a")];
    const ranks = personalizedPageRank(nodes, edges, new Map(), OPTS);
    expect(ranks.has("outside")).toBe(false);
    expect(sum(ranks)).toBeCloseTo(1, 6);
  });
});
