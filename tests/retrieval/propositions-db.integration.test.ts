import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LaCoCoPropositionsDb } from "../../src/persistence/lacoco-propositions-manager/lacoco-propositions-db.js";
import type { NodePropositionRecord } from "../../src/persistence/lacoco-propositions-manager/model/types.js";
import { EMBEDDING_DIM } from "../../src/embeddings/embedding-config.js";

/** Vector one-hot en `slot` (para controlar la cercanía coseno de forma exacta). */
function oneHot(slot: number): Float32Array {
  const v = new Float32Array(EMBEDDING_DIM);
  v[slot % EMBEDDING_DIM] = 1;
  return v;
}

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "lacoco-prop-"));
  dirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("LaCoCoPropositionsDb (LanceDB real)", () => {
  it("escribe, busca y COLAPSA varias proposiciones al mismo real_node_id", async () => {
    const store = new LaCoCoPropositionsDb(tempDir());
    await store.reset();

    const records: NodePropositionRecord[] = [
      { prop_id: "A#prop0", real_node_id: "A", embedding: oneHot(0), text: "a-cero", dimension: "CPG", file_path: "/a" },
      { prop_id: "A#prop1", real_node_id: "A", embedding: oneHot(0), text: "a-uno", dimension: "CPG", file_path: "/a" },
      { prop_id: "B#prop0", real_node_id: "B", embedding: oneHot(5), text: "b-cero", dimension: "CPG", file_path: "/b" },
    ];
    await store.add(records);
    await store.buildIndex();

    // Query pegada a las proposiciones de A: A debe salir primero y UNA sola vez.
    const hits = await store.search(oneHot(0), 5);
    await store.close();

    const aOccurrences = hits.filter((h) => h.realNodeId === "A");
    expect(aOccurrences).toHaveLength(1); // colapsado
    expect(hits[0]!.realNodeId).toBe("A"); // el más cercano
    expect(hits.map((h) => h.realNodeId)).toContain("B");
    expect(aOccurrences[0]!.score).toBeGreaterThan(0.99); // coseno ~1 con el one-hot idéntico
  });

  it("devuelve [] cuando el directorio no tiene la tabla (índice sin C2)", async () => {
    const store = new LaCoCoPropositionsDb(tempDir());
    const hits = await store.search(oneHot(0), 5);
    await store.close();
    expect(hits).toEqual([]);
  });
});
