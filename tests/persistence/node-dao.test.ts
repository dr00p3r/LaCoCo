import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationDao } from "../../src/persistence/lacoco-graph-manager/dao/migration-dao.js";
import { NodeDao } from "../../src/persistence/lacoco-graph-manager/dao/node-dao.js";
import type { GraphNode } from "../../src/persistence/lacoco-graph-manager/model/types.js";

/**
 * Batería de pruebas de NodeDao contra una SQLite REAL en memoria: el esquema
 * se construye con el mismo MigrationDao de producción (tablas nodes/edges +
 * migraciones node_metadata, startLine/endLine…), así los tests ejercitan las
 * mismas columnas y constraints que el índice real.
 */

let db: Database.Database;
let dao: NodeDao;

/** Levanta una BDD en memoria con el esquema real aplicado. */
function crearBaseReal(): Database.Database {
  const conn = new Database(":memory:");
  conn.pragma("foreign_keys = ON");
  const migraciones = new MigrationDao(conn);
  migraciones.initSchema();
  migraciones.runMigrations();
  return conn;
}

/** Construye un GraphNode válido, sobreescribiendo lo que el test necesite. */
function nodo(overrides: Partial<GraphNode> = {}): GraphNode {
  return {
    id: "src/a.ts#foo",
    kind: "FUNCTION",
    name: "foo",
    filepath: "src/a.ts",
    signature: "function foo(): void",
    isDeprecated: 0,
    startLine: 10,
    endLine: 20,
    ...overrides,
  };
}

/** Inserta una fila cruda en node_metadata (dimension edge-derived). */
function insertarMetadata(nodeId: string, dimension: string | null, subType: string | null = null): void {
  db.prepare(
    `INSERT INTO node_metadata (node_id, dimension, sub_type) VALUES (?, ?, ?)`,
  ).run(nodeId, dimension, subType);
}

beforeEach(() => {
  db = crearBaseReal();
  dao = new NodeDao(db);
});

afterEach(() => {
  db.close();
});

describe("NodeDao.insertNode / getNodesByFile", () => {
  it("inserta un nodo y lo recupera fielmente por archivo", () => {
    // Arrange
    const n = nodo();

    // Act
    dao.insertNode(n);
    const filas = dao.getNodesByFile("src/a.ts");

    // Assert
    expect(filas).toHaveLength(1);
    expect(filas[0]).toEqual(n);
  });

  it("persiste startLine/endLine como null cuando el nodo no tiene span", () => {
    // Arrange: nodo sin líneas (rama startLine ?? null / endLine ?? null)
    dao.insertNode(nodo({ id: "src/a.ts#bar", name: "bar", startLine: undefined, endLine: undefined }));

    // Act
    const [fila] = dao.getNodesByFile("src/a.ts");

    // Assert
    expect(fila.startLine).toBeNull();
    expect(fila.endLine).toBeNull();
  });

  it("hace upsert por id (ON CONFLICT) sin duplicar la fila", () => {
    // Arrange
    dao.insertNode(nodo({ signature: "vieja", isDeprecated: 0 }));

    // Act: mismo id, campos distintos → debe sobreescribir
    dao.insertNode(nodo({ signature: "nueva", isDeprecated: 1, name: "fooRenombrado" }));
    const filas = dao.getNodesByFile("src/a.ts");

    // Assert
    expect(filas).toHaveLength(1);
    expect(filas[0].signature).toBe("nueva");
    expect(filas[0].isDeprecated).toBe(1);
    expect(filas[0].name).toBe("fooRenombrado");
  });

  it("devuelve lista vacía para un archivo sin nodos", () => {
    // Act / Assert
    expect(dao.getNodesByFile("src/inexistente.ts")).toEqual([]);
  });
});

describe("NodeDao.getNodeIdsBySymbol", () => {
  beforeEach(() => {
    dao.insertNode(nodo({ id: "src/a.ts#foo", name: "foo" }));
    dao.insertNode(nodo({ id: "src/b.ts#foo", name: "foo", filepath: "src/b.ts" }));
    dao.insertNode(nodo({ id: "src/c.ts#bar", name: "bar", filepath: "src/c.ts" }));
  });

  it("recupera todos los ids que comparten nombre de símbolo", () => {
    // Act
    const ids = dao.getNodeIdsBySymbol("foo");

    // Assert
    expect(ids.sort()).toEqual(["src/a.ts#foo", "src/b.ts#foo"]);
  });

  it("respeta el límite indicado", () => {
    // Act: dos nodos "foo" pero limit=1 (rama del parámetro limit)
    const ids = dao.getNodeIdsBySymbol("foo", 1);

    // Assert
    expect(ids).toHaveLength(1);
  });

  it("devuelve lista vacía para un símbolo inexistente", () => {
    expect(dao.getNodeIdsBySymbol("noExiste")).toEqual([]);
  });
});

describe("NodeDao.getExternalLibraryIds", () => {
  beforeEach(() => {
    // Nodos EXTERNAL_LIB con nombre que incluye paquete@versión.
    dao.insertNode(nodo({ id: "ext#react@18.2.0", kind: "EXTERNAL_LIB", name: "react@18.2.0", filepath: "node_modules/react" }));
    dao.insertNode(nodo({ id: "ext#react@17.0.1", kind: "EXTERNAL_LIB", name: "react@17.0.1", filepath: "node_modules/react" }));
    dao.insertNode(nodo({ id: "ext#lodash@4.17.21", kind: "EXTERNAL_LIB", name: "lodash@4.17.21", filepath: "node_modules/lodash" }));
    // Nodo normal con "react" en el nombre: NO debe salir (kind != EXTERNAL_LIB).
    dao.insertNode(nodo({ id: "src/x.ts#reactHelper", name: "reactHelper", filepath: "src/x.ts" }));
  });

  it("filtra por paquete sin versión (rama sin version)", () => {
    // Act
    const ids = dao.getExternalLibraryIds("react");

    // Assert
    expect(ids.sort()).toEqual(["ext#react@17.0.1", "ext#react@18.2.0"]);
  });

  it("filtra por paquete Y versión (rama con version)", () => {
    // Act
    const ids = dao.getExternalLibraryIds("react", "18.2.0");

    // Assert
    expect(ids).toEqual(["ext#react@18.2.0"]);
  });

  it("respeta el límite (rama con version + limit)", () => {
    // Act: ambos "react" pero limit=1
    const ids = dao.getExternalLibraryIds("react", undefined, 1);

    // Assert
    expect(ids).toHaveLength(1);
  });

  it("devuelve vacío cuando el paquete no está indexado", () => {
    expect(dao.getExternalLibraryIds("paquete-fantasma")).toEqual([]);
  });
});

describe("NodeDao.getNodeSignatures", () => {
  it("mapea id → firma para los ids existentes", () => {
    // Arrange
    dao.insertNode(nodo({ id: "src/a.ts#foo", signature: "function foo(): void" }));
    dao.insertNode(nodo({ id: "src/b.ts#bar", name: "bar", filepath: "src/b.ts", signature: "function bar(): number" }));

    // Act
    const mapa = dao.getNodeSignatures(["src/a.ts#foo", "src/b.ts#bar"]);

    // Assert
    expect(mapa.get("src/a.ts#foo")).toBe("function foo(): void");
    expect(mapa.get("src/b.ts#bar")).toBe("function bar(): number");
  });

  it("cae a name cuando signature es null (COALESCE)", () => {
    // Arrange: inserción cruda con signature NULL para forzar el COALESCE.
    db.prepare(
      `INSERT INTO nodes (id, kind, name, filepath, signature, isDeprecated) VALUES (?, ?, ?, ?, NULL, 0)`,
    ).run("src/a.ts#sinFirma", "FUNCTION", "sinFirma", "src/a.ts");

    // Act
    const mapa = dao.getNodeSignatures(["src/a.ts#sinFirma"]);

    // Assert
    expect(mapa.get("src/a.ts#sinFirma")).toBe("sinFirma");
  });

  it("omite ids inexistentes y devuelve Map vacío para lista vacía", () => {
    // Arrange
    dao.insertNode(nodo());

    // Act
    const parcial = dao.getNodeSignatures(["src/a.ts#foo", "id#fantasma"]);
    const vacio = dao.getNodeSignatures([]);

    // Assert
    expect(parcial.size).toBe(1);
    expect(parcial.has("id#fantasma")).toBe(false);
    expect(vacio.size).toBe(0);
  });
});

describe("NodeDao.getNodeSpans", () => {
  it("devuelve localización + firma de los nodos existentes", () => {
    // Arrange
    dao.insertNode(nodo({ id: "src/a.ts#foo", name: "foo", filepath: "src/a.ts", signature: "sig-foo", startLine: 5, endLine: 9 }));

    // Act
    const spans = dao.getNodeSpans(["src/a.ts#foo"]);

    // Assert
    expect(spans.get("src/a.ts#foo")).toEqual({
      nodeId: "src/a.ts#foo",
      name: "foo",
      filepath: "src/a.ts",
      signature: "sig-foo",
      startLine: 5,
      endLine: 9,
    });
  });

  it("cae a name en signature y deja startLine/endLine null cuando faltan", () => {
    // Arrange: signature NULL y sin líneas → COALESCE + optionalNumber(null).
    db.prepare(
      `INSERT INTO nodes (id, kind, name, filepath, signature, isDeprecated, startLine, endLine)
       VALUES (?, ?, ?, ?, NULL, 0, NULL, NULL)`,
    ).run("src/a.ts#nudo", "FUNCTION", "nudo", "src/a.ts");

    // Act
    const span = dao.getNodeSpans(["src/a.ts#nudo"]).get("src/a.ts#nudo");

    // Assert
    expect(span?.signature).toBe("nudo");
    expect(span?.startLine).toBeNull();
    expect(span?.endLine).toBeNull();
  });

  it("omite ausentes y devuelve Map vacío para lista vacía", () => {
    dao.insertNode(nodo());

    const parcial = dao.getNodeSpans(["src/a.ts#foo", "id#fantasma"]);
    expect(parcial.size).toBe(1);
    expect(dao.getNodeSpans([]).size).toBe(0);
  });
});

describe("NodeDao.getNodeDimensions", () => {
  beforeEach(() => {
    dao.insertNode(nodo({ id: "src/a.ts#foo" }));
    dao.insertNode(nodo({ id: "src/b.ts#bar", name: "bar", filepath: "src/b.ts" }));
    dao.insertNode(nodo({ id: "src/c.ts#baz", name: "baz", filepath: "src/c.ts" }));
  });

  it("mapea id → dimension edge-derived para nodos con metadata válida", () => {
    // Arrange
    insertarMetadata("src/a.ts#foo", "CPG", "function");
    insertarMetadata("src/b.ts#bar", "SYS", "class");

    // Act
    const dims = dao.getNodeDimensions(["src/a.ts#foo", "src/b.ts#bar"]);

    // Assert
    expect(dims.get("src/a.ts#foo")).toBe("CPG");
    expect(dims.get("src/b.ts#bar")).toBe("SYS");
  });

  it("mapea las tres dimensiones canónicas (SYS/CPG/DTG pasan el filtro valid)", () => {
    // Arrange: una fila por cada dimension válida.
    insertarMetadata("src/a.ts#foo", "SYS");
    insertarMetadata("src/b.ts#bar", "CPG");
    insertarMetadata("src/c.ts#baz", "DTG");

    // Act
    const dims = dao.getNodeDimensions(["src/a.ts#foo", "src/b.ts#bar", "src/c.ts#baz"]);

    // Assert: las tres superan valid.has(dimension).
    expect(dims.get("src/a.ts#foo")).toBe("SYS");
    expect(dims.get("src/b.ts#bar")).toBe("CPG");
    expect(dims.get("src/c.ts#baz")).toBe("DTG");
  });

  it("omite nodos sin fila en node_metadata y devuelve Map vacío para lista vacía", () => {
    // Arrange: foo con metadata, bar sin metadata.
    insertarMetadata("src/a.ts#foo", "DTG");

    // Act
    const dims = dao.getNodeDimensions(["src/a.ts#foo", "src/b.ts#bar"]);

    // Assert
    expect(dims.get("src/a.ts#foo")).toBe("DTG");
    expect(dims.has("src/b.ts#bar")).toBe(false);
    expect(dao.getNodeDimensions([]).size).toBe(0);
  });
});

describe("NodeDao.loadNodesByIds", () => {
  it("carga nodos con su metadata (dim y sub_type) vía LEFT JOIN", () => {
    // Arrange
    dao.insertNode(nodo({ id: "src/a.ts#foo" }));
    insertarMetadata("src/a.ts#foo", "CPG", "function");

    // Act
    const [n] = dao.loadNodesByIds(["src/a.ts#foo"]);

    // Assert
    expect(n.id).toBe("src/a.ts#foo");
    expect(n.dim).toBe("CPG");
    expect(n.sub_type).toBe("function");
  });

  it("devuelve dim/sub_type null cuando no hay metadata (rama del LEFT JOIN)", () => {
    // Arrange
    dao.insertNode(nodo({ id: "src/b.ts#bar", name: "bar", filepath: "src/b.ts" }));

    // Act
    const [n] = dao.loadNodesByIds(["src/b.ts#bar"]);

    // Assert
    expect(n.dim).toBeNull();
    expect(n.sub_type).toBeNull();
  });

  it("normaliza signature ausente a cadena vacía (COALESCE '')", () => {
    // Arrange: signature NULL.
    db.prepare(
      `INSERT INTO nodes (id, kind, name, filepath, signature, isDeprecated) VALUES (?, ?, ?, ?, NULL, 0)`,
    ).run("src/a.ts#sinFirma", "FUNCTION", "sinFirma", "src/a.ts");

    // Act
    const [n] = dao.loadNodesByIds(["src/a.ts#sinFirma"]);

    // Assert
    expect(n.signature).toBe("");
  });

  it("devuelve lista vacía para ids vacíos", () => {
    expect(dao.loadNodesByIds([])).toEqual([]);
  });
});

describe("NodeDao.deleteNodesByFile", () => {
  it("borra los nodos del archivo, sus aristas entrantes y devuelve sus ids", () => {
    // Arrange: dos nodos en a.ts + una arista que apunta a uno de ellos.
    dao.insertNode(nodo({ id: "src/a.ts#foo", name: "foo", filepath: "src/a.ts" }));
    dao.insertNode(nodo({ id: "src/a.ts#bar", name: "bar", filepath: "src/a.ts" }));
    dao.insertNode(nodo({ id: "src/b.ts#keep", name: "keep", filepath: "src/b.ts" }));
    // Arista externa que apunta a un nodo a borrar (rama deleteEdgesByTarget).
    db.prepare(`INSERT INTO edges (sourceId, targetId, relation) VALUES (?, ?, ?)`)
      .run("src/b.ts#keep", "src/a.ts#foo", "CALLS");

    // Act
    const borrados = dao.deleteNodesByFile("src/a.ts");

    // Assert
    expect(borrados.sort()).toEqual(["src/a.ts#bar", "src/a.ts#foo"]);
    expect(dao.getNodesByFile("src/a.ts")).toEqual([]);
    expect(dao.getNodesByFile("src/b.ts")).toHaveLength(1);
    const aristas = db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE targetId = ?`).get("src/a.ts#foo") as { c: number };
    expect(aristas.c).toBe(0);
  });

  it("devuelve lista vacía y no lanza cuando el archivo no tiene nodos", () => {
    // Act: rama nodeIds.length === 0 → early return sin transacción.
    const borrados = dao.deleteNodesByFile("src/inexistente.ts");

    // Assert
    expect(borrados).toEqual([]);
  });
});

describe("NodeDao.clearAll", () => {
  it("elimina todos los nodos de la tabla", () => {
    // Arrange
    dao.insertNode(nodo({ id: "src/a.ts#foo", filepath: "src/a.ts" }));
    dao.insertNode(nodo({ id: "src/b.ts#bar", name: "bar", filepath: "src/b.ts" }));

    // Act
    dao.clearAll();

    // Assert
    const total = db.prepare(`SELECT COUNT(*) AS c FROM nodes`).get() as { c: number };
    expect(total.c).toBe(0);
    expect(dao.getNodesByFile("src/a.ts")).toEqual([]);
  });
});
