import { describe, expect, it } from "vitest";
import type { GraphEdge } from "../../src/persistence/lacoco-graph-manager/model/types.js";
import {
  breadthFirstTraversal,
  prioritizedBreadthFirstTraversal,
} from "../../src/retriever/strategies/helpers/graph-traversal.js";
import {
  getDominantDimension,
  getIntentWeights,
} from "../../src/retriever/strategies/helpers/intent-weights.js";

describe("strategy intent helpers", () => {
  it("normaliza pesos y refuerza dimensiones indicadas por el intermediario", () => {
    const weights = getIntentWeights("debug", ["DTG"]);

    expect(weights.SYS + weights.CPG + weights.DTG).toBeCloseTo(1);
    expect(weights.DTG).toBeGreaterThan(weights.SYS);
    expect(getDominantDimension("integrate", ["DTG"])).toBe("DTG");
  });
});

describe("strategy graph traversal helpers", () => {
  it("respeta presupuesto y excluye aristas hacia nodos fuera del recorrido", () => {
    const edges: GraphEdge[] = [
      edge("A", "B"),
      edge("A", "C"),
      edge("B", "D"),
    ];
    const result = breadthFirstTraversal(
      {
        getNeighborhood: (ids) => edges.filter(
          (candidate) => ids.includes(candidate.sourceId) || ids.includes(candidate.targetId),
        ),
      },
      ["A"],
      { maxHops: 2, maxNodes: 2 },
    );

    expect([...result.visited]).toEqual(["A", "B"]);
    expect(result.edges).toEqual([edge("A", "B")]);
  });

  it("selecciona primero el candidato de mayor prioridad", () => {
    const adjacency = new Map([
      ["A", ["B", "C"]],
      ["B", []],
      ["C", []],
    ]);
    const visited = prioritizedBreadthFirstTraversal(
      ["A"],
      (nodeId) => adjacency.get(nodeId) ?? [],
      { budget: 2, priority: (nodeId) => nodeId === "C" ? 10 : 1 },
    );

    expect([...visited]).toEqual(["A", "C"]);
  });
});

function edge(sourceId: string, targetId: string): GraphEdge {
  return { sourceId, targetId, relation: "CALLS" };
}
