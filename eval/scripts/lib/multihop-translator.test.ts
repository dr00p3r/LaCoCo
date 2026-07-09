import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import {
  DEFAULT_MULTIHOP_EDGE_KINDS,
  extractMultihopFromGraph,
} from "./multihop-translator.js";

/**
 * Crea un grafo de juguete en tmpdir con la tabla edges que usa
 * extractMultihopFromGraph. Devuelve { dbPath, repoPath, cleanup }.
 */
function makeToyGraph(opts: { nodes: string[]; edges: Array<[string, string, string]> }): {
  dbPath: string;
  repoPath: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "multihop-test-"));
  const repoPath = join(dir, "toy-repo");
  const dbPath = join(dir, "toy.sqlite");
  // helper para producir id absoluto consistente
  const abs = (relOrAbs: string): string => {
    if (relOrAbs.startsWith("/")) return relOrAbs;
    return join(repoPath, relOrAbs);
  };
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT, name TEXT, filepath TEXT, signature TEXT, isDeprecated INTEGER DEFAULT 0);
    CREATE TABLE edges (sourceId TEXT, targetId TEXT, relation TEXT, UNIQUE(sourceId, targetId, relation));
  `);
  const insertNode = db.prepare("INSERT INTO nodes (id, filepath) VALUES (?, ?)");
  for (const id of opts.nodes) {
    const absId = abs(id);
    const filepath = absId.split("#")[0]!;
    insertNode.run(absId, filepath);
  }
  const insertEdge = db.prepare("INSERT INTO edges (sourceId, targetId, relation) VALUES (?, ?, ?)");
  for (const [source, target, relation] of opts.edges) {
    insertEdge.run(abs(source), abs(target), relation);
  }
  db.close();
  return {
    dbPath,
    repoPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("extractMultihopFromGraph", () => {
  it("encuentra nodos a distancia >= 2 siguiendo CALLS+REFERENCES+DECLARES", () => {
    // Anchor A. CALLS A->B. CALLS B->C. DECLARES B->D. REFERENCES A->E.
    // Anchor A es distancia 0. B, E son distancia 1 (excluidos). C, D son distancia 2 (multihop).
    const graph = makeToyGraph({
      nodes: [
        "src/a.ts#A",
        "src/b.ts#B",
        "src/c.ts#C",
        "src/d.ts#D",
        "src/e.ts#E",
      ],
      edges: [
        ["src/a.ts#A", "src/b.ts#B", "CALLS"],
        ["src/b.ts#B", "src/c.ts#C", "CALLS"],
        ["src/b.ts#B", "src/d.ts#D", "DECLARES"],
        ["src/a.ts#A", "src/e.ts#E", "REFERENCES"],
      ],
    });
    try {
      const result = extractMultihopFromGraph({
        dbPath: graph.dbPath,
        primaryAnchor: "src/a.ts#A",
        repoPath: graph.repoPath,
        edgeKinds: ["CALLS", "REFERENCES", "DECLARES"],
        depthMin: 2,
        depthMax: 3,
        topK: 5,
      });
      const ids = result.multihopNodes;
      expect(ids).toContain("src/c.ts#C");
      expect(ids).toContain("src/d.ts#D");
      // B y E son distancia 1, NO deben aparecer.
      expect(ids).not.toContain("src/b.ts#B");
      expect(ids).not.toContain("src/e.ts#E");
      // A es el anchor, NO debe aparecer.
      expect(ids).not.toContain("src/a.ts#A");
    } finally {
      graph.cleanup();
    }
  });

  it("devuelve [] si no hay alcanzables a distancia >= 2", () => {
    // Anchor X. CALLS X->Y. Y es distancia 1. Nada mas.
    const graph = makeToyGraph({
      nodes: ["src/x.ts#X", "src/y.ts#Y"],
      edges: [["src/x.ts#X", "src/y.ts#Y", "CALLS"]],
    });
    try {
      const result = extractMultihopFromGraph({
        dbPath: graph.dbPath,
        primaryAnchor: "src/x.ts#X",
        repoPath: graph.repoPath,
        edgeKinds: ["CALLS"],
        depthMin: 2,
        depthMax: 3,
        topK: 5,
      });
      expect(result.multihopNodes).toEqual([]);
      expect(result.candidates).toEqual([]);
    } finally {
      graph.cleanup();
    }
  });

  it("respeta topK y todos los candidatos a distancia 2 aparecen", () => {
    // Anchor A. CALLS A->B,C,D. B,C,D CALLS a E,F,G,H,I,X (6 nodos a distancia 2).
    const graph = makeToyGraph({
      nodes: [
        "src/a.ts#A", "src/b.ts#B", "src/c.ts#C", "src/d.ts#D",
        "src/e.ts#E", "src/f.ts#F", "src/g.ts#G", "src/h.ts#H",
        "src/i.ts#I", "src/x.ts#X",
      ],
      edges: [
        ["src/a.ts#A", "src/b.ts#B", "CALLS"],
        ["src/a.ts#A", "src/c.ts#C", "CALLS"],
        ["src/a.ts#A", "src/d.ts#D", "CALLS"],
        ["src/b.ts#B", "src/e.ts#E", "CALLS"],
        ["src/b.ts#B", "src/f.ts#F", "CALLS"],
        ["src/b.ts#B", "src/g.ts#G", "CALLS"],
        ["src/c.ts#C", "src/h.ts#H", "CALLS"],
        ["src/d.ts#D", "src/i.ts#I", "CALLS"],
        ["src/d.ts#D", "src/x.ts#X", "CALLS"],
      ],
    });
    try {
      const result = extractMultihopFromGraph({
        dbPath: graph.dbPath,
        primaryAnchor: "src/a.ts#A",
        repoPath: graph.repoPath,
        edgeKinds: ["CALLS"],
        depthMin: 2,
        depthMax: 2,
        topK: 3,
      });
      // 6 alcanzables a distancia 2, topK=3 -> 3 elegidos.
      expect(result.multihopNodes).toHaveLength(3);
      expect(result.candidates).toHaveLength(6);
      for (const candidate of result.candidates) {
        expect(candidate.distance).toBe(2);
      }
    } finally {
      graph.cleanup();
    }
  });

  it("excluye nodos provistos en excludeNodes", () => {
    const graph = makeToyGraph({
      nodes: ["src/a.ts#A", "src/b.ts#B", "src/c.ts#C"],
      edges: [
        ["src/a.ts#A", "src/b.ts#B", "CALLS"],
        ["src/b.ts#B", "src/c.ts#C", "CALLS"],
      ],
    });
    try {
      const result = extractMultihopFromGraph({
        dbPath: graph.dbPath,
        primaryAnchor: "src/a.ts#A",
        repoPath: graph.repoPath,
        edgeKinds: ["CALLS"],
        depthMin: 2,
        depthMax: 3,
        topK: 5,
        excludeNodes: ["src/c.ts#C"],
      });
      expect(result.multihopNodes).toEqual([]);
    } finally {
      graph.cleanup();
    }
  });

  it("acepta anchor absoluto sin transformar", () => {
    const repoPath = "/toy/repo";
    const absAnchor = `${repoPath}/src/a.ts#A`;
    const graph = makeToyGraph({
      // Usamos ids absolutos para hacer el grafo directamente absoluto.
      nodes: [absAnchor, `${repoPath}/src/b.ts#B`, `${repoPath}/src/c.ts#C`],
      edges: [
        [`${repoPath}/src/a.ts#A`, `${repoPath}/src/b.ts#B`, "CALLS"],
        [`${repoPath}/src/b.ts#B`, `${repoPath}/src/c.ts#C`, "CALLS"],
      ],
    });
    try {
      const result = extractMultihopFromGraph({
        dbPath: graph.dbPath,
        primaryAnchor: absAnchor,
        repoPath,
        edgeKinds: ["CALLS"],
        depthMin: 2,
        depthMax: 3,
        topK: 5,
      });
      expect(result.multihopNodes).toEqual(["src/c.ts#C"]);
    } finally {
      graph.cleanup();
    }
  });

  it("lanza error si la DB no existe", () => {
    expect(() => extractMultihopFromGraph({
      dbPath: "/nonexistent/path/tensor.sqlite",
      primaryAnchor: "src/a.ts#A",
      repoPath: "/tmp",
      edgeKinds: ["CALLS"],
    })).toThrow();
  });

  it("lanza error si depthMin < 1", () => {
    expect(() => extractMultihopFromGraph({
      dbPath: "/dev/null",
      primaryAnchor: "src/a.ts#A",
      repoPath: "/tmp",
      edgeKinds: ["CALLS"],
      depthMin: 0,
    })).toThrow(/depthMin/);
  });

  it("lanza error si depthMax < depthMin", () => {
    expect(() => extractMultihopFromGraph({
      dbPath: "/dev/null",
      primaryAnchor: "src/a.ts#A",
      repoPath: "/tmp",
      edgeKinds: ["CALLS"],
      depthMin: 3,
      depthMax: 2,
    })).toThrow(/depthMax/);
  });

  it("DEFAULT_MULTIHOP_EDGE_KINDS incluye CALLS, REFERENCES, DECLARES", () => {
    expect(DEFAULT_MULTIHOP_EDGE_KINDS).toContain("CALLS");
    expect(DEFAULT_MULTIHOP_EDGE_KINDS).toContain("REFERENCES");
    expect(DEFAULT_MULTIHOP_EDGE_KINDS).toContain("DECLARES");
  });
});
