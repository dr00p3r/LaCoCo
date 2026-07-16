/**
 * Ramas poco cubiertas de semantic-profile-store.ts: casteo de términos sin
 * nodeId/path, fallos de build, transición ready→stale por revisión de grafo,
 * reutilización con hashes ausentes, consultas con y sin match FTS, y las
 * funciones puras normalizeSemanticText / createLexicalFtsQuery.
 *
 * Se construye un build "a mano" (beginBuild + completeBuild) con términos
 * controlados sobre una base LaCoCoDatabase real (esquema completo, sin red).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import {
  SemanticProfileStore,
  createLexicalFtsQuery,
  normalizeSemanticText,
} from "../../src/semantic-profile/semantic-profile-store.js";
import type { EnrichedTerm } from "../../src/semantic-profile/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createDb(): LaCoCoDatabase {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lacoco-store-"));
  temporaryDirectories.push(root);
  const db = new LaCoCoDatabase(path.join(root, "tensor.sqlite"));
  // Un nodo cualquiera asegura que graph_state (id=1) exista para getGraphRevision.
  db.insertNode({
    id: `${root}/src/index.ts#main`,
    kind: "FUNCTION",
    name: "main",
    filepath: path.join(root, "src/index.ts"),
    signature: "function main(): void",
    isDeprecated: 0,
  });
  db.populateMetadata();
  return db;
}

/** Construye un EnrichedTerm mínimo con overrides; por defecto SIN nodeId ni path. */
function enrichedTerm(overrides: Partial<EnrichedTerm> = {}): EnrichedTerm {
  return {
    id: "t1",
    canonicalTerm: "Widget",
    normalizedTerm: "widget",
    kind: "symbol",
    dimensions: ["CPG"],
    evidence: ["evidencia"],
    sourceHash: "hash-t1",
    aliases: [{ value: "widget", language: "en", confidence: 0.9 }],
    domains: [{ name: "ui-components", score: 0.5 }],
    description: "un componente widget",
    confidence: 0.5,
    ...overrides,
  };
}

/** Persiste un build listo con los términos dados y devuelve el store. */
function seedBuild(db: LaCoCoDatabase, terms: EnrichedTerm[]): SemanticProfileStore {
  const store = new SemanticProfileStore(db.getRawDb());
  const buildId = store.beginBuild("test-model", 2, "evidence-rev");
  store.completeBuild(buildId, terms);
  return store;
}

describe("SemanticProfileStore — ramas de casteo y consulta", () => {
  it("persiste y reutiliza un término sin nodeId ni path", () => {
    // Arrange — término con nodeId/path ausentes ejercita `?? null` y `?? ""`.
    const db = createDb();
    const term = enrichedTerm();
    const store = seedBuild(db, [term]);
    // Act — reutilización por hash: debe recuperar el término guardado.
    const reused = store.loadReusableTerms([
      {
        id: term.id,
        canonicalTerm: term.canonicalTerm,
        normalizedTerm: term.normalizedTerm,
        kind: term.kind,
        dimensions: term.dimensions,
        evidence: term.evidence,
        sourceHash: term.sourceHash,
      },
    ]);
    // Assert
    const recovered = reused.get(term.sourceHash);
    expect(recovered).toBeDefined();
    expect(recovered?.nodeId).toBeUndefined();
    expect(recovered?.path).toBeUndefined();
    expect(recovered?.aliases[0]?.value).toBe("widget");
    db.close();
  });

  it("devuelve un mapa vacío cuando ningún hash coincide", () => {
    // Arrange
    const db = createDb();
    const store = seedBuild(db, [enrichedTerm()]);
    // Act — hash inexistente → la consulta por lote no devuelve filas.
    const reused = store.loadReusableTerms([
      {
        id: "otro",
        canonicalTerm: "Otro",
        normalizedTerm: "otro",
        kind: "symbol",
        dimensions: ["CPG"],
        evidence: [],
        sourceHash: "hash-inexistente",
      },
    ]);
    // Assert
    expect(reused.size).toBe(0);
    db.close();
  });

  it("resuelve un candidato solo por FTS (match en la descripción, no exacto)", () => {
    // Arrange — la palabra 'authentication' vive en la descripción; no es alias
    // ni término canónico, así que solo la encuentra el canal FTS.
    const db = createDb();
    const store = seedBuild(db, [
      enrichedTerm({
        aliases: [{ value: "widget", language: "en", confidence: 0.9 }],
        description: "handles authentication flow",
      }),
    ]);
    // Act
    const grounding = store.groundQuery("authentication", 10);
    // Assert — hay candidato y su razón incluye fts5 pero no exact.
    const candidate = grounding.candidates.find(({ termId }) => termId === "t1");
    expect(candidate).toBeDefined();
    expect(candidate?.matchReasons).toContain("fts5");
    expect(candidate?.matchReasons).not.toContain("exact");
    db.close();
  });

  it("resuelve un candidato solo por coincidencia exacta (sin FTS) y sin path", () => {
    // Arrange — alias "meout" es subcadena de la query "timeout" (match exacto),
    // pero el token FTS "timeout" no aparece en ningún campo indexado del término.
    const db = createDb();
    const store = seedBuild(db, [
      enrichedTerm({
        canonicalTerm: "Timer",
        normalizedTerm: "timer",
        aliases: [{ value: "meout", language: "en", confidence: 0.9 }],
        description: "reloj",
        domains: [
          { name: "api", score: 0.5 },
          { name: "auth", score: 0.5 },
        ],
      }),
    ]);
    // Act
    const grounding = store.groundQuery("timeout", 10);
    // Assert — candidato presente por exact, sin fts5 y sin path (nunca se guardó).
    const candidate = grounding.candidates.find(({ termId }) => termId === "t1");
    expect(candidate).toBeDefined();
    expect(candidate?.matchReasons).toContain("exact");
    expect(candidate?.matchReasons).not.toContain("fts5");
    expect(candidate?.path).toBeUndefined();
    // Dos dominios con score agregado idéntico → desempate por nombre (localeCompare).
    expect(grounding.domains.map(({ name }) => name)).toEqual(["api", "auth"]);
    db.close();
  });

  it("devuelve candidatos vacíos cuando la query no produce tokens FTS ni exactos", () => {
    // Arrange
    const db = createDb();
    const store = seedBuild(db, [enrichedTerm()]);
    // Act — 'a' es demasiado corto: sin query FTS válida ni match exacto.
    const grounding = store.groundQuery("a", 10);
    // Assert
    expect(grounding.candidates).toEqual([]);
    expect(grounding.domains).toEqual([]);
    db.close();
  });
});

describe("SemanticProfileStore — estados de fallo y obsolescencia", () => {
  it("registra el error de un build con Error y con valor no-Error", () => {
    // Arrange
    const db = createDb();
    const store = new SemanticProfileStore(db.getRawDb());
    const buildId = store.beginBuild("test-model", 2, "evidence-rev");
    // Act — rama error instanceof Error.
    store.failBuild(buildId, new Error("explota"));
    // Assert
    expect(store.getState().status).toBe("error");
    expect(store.getState().lastError).toBe("explota");
    // Act — rama no-Error (String(error)).
    const otherBuild = store.beginBuild("test-model", 2, "evidence-rev");
    store.failBuild(otherBuild, "fallo crudo");
    // Assert
    expect(store.getState().lastError).toBe("fallo crudo");
    db.close();
  });

  it("marca stale un perfil ready cuando la revisión del grafo cambia", () => {
    // Arrange — build listo; luego se altera graph_state SIN tocar el estado del
    // perfil, dejándolo 'ready' con una graphRevision desactualizada.
    const db = createDb();
    const store = seedBuild(db, [enrichedTerm()]);
    expect(store.getState().status).toBe("ready");
    db.getRawDb().prepare("UPDATE graph_state SET revision = ? WHERE id = 1").run("otra-rev");
    // Act / Assert — assertReady detecta el desfase, marca stale y lanza.
    expect(() => store.groundQuery("widget")).toThrow("obsoleto");
    expect(store.getState().status).toBe("stale");
    db.close();
  });
});

describe("normalizeSemanticText / createLexicalFtsQuery", () => {
  it("normaliza acentos de forma NFKC, minúsculas y colapsa espacios", () => {
    expect(normalizeSemanticText("  Hola   MUNDO  ")).toBe("hola mundo");
  });

  it("devuelve cadena vacía cuando no hay tokens de longitud suficiente", () => {
    // Solo espacios → el match del regex es null (rama `?? []`).
    expect(createLexicalFtsQuery("   ")).toBe("");
    // Tokens de un solo carácter → filtrados (>= 2).
    expect(createLexicalFtsQuery("a b c")).toBe("");
  });

  it("construye una query OR entrecomillando y deduplicando tokens", () => {
    const query = createLexicalFtsQuery("color color palette");
    expect(query).toBe('"color" OR "palette"');
  });
});
