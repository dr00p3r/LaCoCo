import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GraphIndexer } from "../../src/indexer/graph-indexer.js";
import { CodeExtractor } from "../../src/extractor/code-extractor.js";

// Sentinela para forzar que el constructor de Project lance un valor NO-Error
// (rama `: err` en la carga de proyecto). Las rutas normales siguen usando el
// Project real, así que la extracción ts-morph del resto de tests no cambia.
const SENTINELA_LANZA_STRING = "THROW_STRING";
vi.mock("ts-morph", async (importActual) => {
  const actual = await importActual<typeof import("ts-morph")>();
  class ProjectEnvoltorio extends actual.Project {
    constructor(opciones?: ConstructorParameters<typeof actual.Project>[0]) {
      const ruta = opciones?.tsConfigFilePath;
      if (typeof ruta === "string" && ruta.includes(SENTINELA_LANZA_STRING)) {
        throw "fallo string de proyecto"; // valor no-Error a propósito
      }
      super(opciones);
    }
  }
  return { ...actual, Project: ProjectEnvoltorio };
});

/**
 * Batería de GraphIndexer contra dependencias REALES: SQLite en disco temporal
 * (mismo esquema de producción vía LaCoCoDatabase) + extracción real ts-morph
 * sobre fixtures .ts efímeros. Se ejercita el ciclo completo de indexado del
 * grafo y sus ramas: proyecto único / múltiples tsconfig, deduplicación de
 * archivos, proyecto que falla al cargar, ningún archivo indexable y errores
 * por-archivo del extractor (capturados sin abortar).
 *
 * Los console.* del indexador se silencian pero se espían para poder afirmar
 * sobre el resumen final y los avisos de error.
 */

const proyectosTemporales: string[] = [];
let logs: string[] = [];
let errores: string[] = [];

/** Crea un proyecto TS temporal con los archivos indicados y su tsconfig. */
function crearProyecto(
  archivos: Record<string, string>,
  incluir: string[] = ["*.ts"],
): { dir: string; tsconfig: string; dbPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "lacoco-graph-indexer-"));
  proyectosTemporales.push(dir);
  for (const [nombre, contenido] of Object.entries(archivos)) {
    writeFileSync(path.join(dir, nombre), contenido, "utf8");
  }
  const tsconfig = path.join(dir, "tsconfig.json");
  writeFileSync(
    tsconfig,
    JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
        },
        include: incluir,
      },
      null,
      2,
    ),
    "utf8",
  );
  return { dir, tsconfig, dbPath: path.join(dir, "tensor.sqlite") };
}

/** Abre la SQLite resultante en solo-lectura para inspeccionar el grafo. */
function conGrafo<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function contarNodos(db: Database.Database): number {
  return (db.prepare("SELECT COUNT(*) AS c FROM nodes").get() as { c: number }).c;
}

function existeNodo(db: Database.Database, name: string): boolean {
  return db.prepare("SELECT 1 FROM nodes WHERE name = ? LIMIT 1").get(name) !== undefined;
}

const FUENTE_ALPHA = 'export class Alpha {\n  greet(): string {\n    return "hi";\n  }\n}\n';
const FUENTE_BETA = "export function beta(): number {\n  return 1;\n}\n";

beforeEach(() => {
  logs = [];
  errores = [];
  // Silenciar el ruido del indexador pero capturarlo para las aserciones.
  vi.spyOn(console, "log").mockImplementation((msg?: unknown) => {
    logs.push(String(msg));
  });
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    errores.push(args.map((a) => String(a)).join(" "));
  });
  vi.spyOn(console, "time").mockImplementation(() => undefined);
  vi.spyOn(console, "timeEnd").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  while (proyectosTemporales.length > 0) {
    rmSync(proyectosTemporales.pop()!, { recursive: true, force: true });
  }
});

describe("GraphIndexer.index — camino feliz", () => {
  it("indexa un proyecto real (tsconfig string) y persiste nodos + metadatos", () => {
    // Arrange
    const { tsconfig, dbPath } = crearProyecto({ "a.ts": FUENTE_ALPHA, "b.ts": FUENTE_BETA });

    // Act
    new GraphIndexer(dbPath, tsconfig).index();

    // Assert: los símbolos reales del extractor están en el grafo.
    conGrafo(dbPath, (db) => {
      expect(existeNodo(db, "Alpha")).toBe(true);
      expect(existeNodo(db, "greet")).toBe(true);
      expect(existeNodo(db, "beta")).toBe(true);
      // populateMetadata() pobló node_metadata para al menos un nodo.
      const meta = (db.prepare("SELECT COUNT(*) AS c FROM node_metadata").get() as { c: number }).c;
      expect(meta).toBeGreaterThan(0);
    });
    // El resumen final reporta los 2 archivos procesados y 0 proyectos omitidos.
    expect(logs.some((l) => l.includes("2 archivos procesados, 0 proyectos omitidos"))).toBe(true);
  });
});

describe("GraphIndexer.index — múltiples tsconfig y deduplicación", () => {
  it("acepta un array de tsconfig y deduplica archivos ya vistos (seenFiles)", () => {
    // Arrange: el MISMO tsconfig dos veces → la 2ª pasada ve archivos repetidos.
    const { tsconfig, dbPath } = crearProyecto({ "a.ts": FUENTE_ALPHA, "b.ts": FUENTE_BETA });

    // Act: rama Array.isArray(tsConfigPath) === true.
    new GraphIndexer(dbPath, [tsconfig, tsconfig]).index();

    // Assert: solo 2 archivos únicos procesados pese a los dos tsconfig.
    expect(logs.some((l) => l.includes("2 archivos procesados"))).toBe(true);
    conGrafo(dbPath, (db) => {
      expect(existeNodo(db, "Alpha")).toBe(true);
      // El upsert + dedup evita duplicar: Alpha aparece una sola vez.
      const alphas = (db.prepare("SELECT COUNT(*) AS c FROM nodes WHERE name = 'Alpha'").get() as { c: number }).c;
      expect(alphas).toBe(1);
    });
  });
});

describe("GraphIndexer.index — proyecto que falla al cargar", () => {
  it("omite el tsconfig inválido (failedProjects) e indexa el válido", () => {
    // Arrange: proyecto válido + ruta a tsconfig inexistente.
    const { tsconfig, dbPath, dir } = crearProyecto({ "a.ts": FUENTE_ALPHA });
    const inexistente = path.join(dir, "no-existe", "tsconfig.json");

    // Act: el Project del tsconfig inexistente lanza → failedProjects++.
    new GraphIndexer(dbPath, [tsconfig, inexistente]).index();

    // Assert: no aborta, indexa el válido y reporta 1 proyecto omitido.
    conGrafo(dbPath, (db) => {
      expect(existeNodo(db, "Alpha")).toBe(true);
    });
    expect(errores.some((e) => e.includes("Error cargando"))).toBe(true);
    expect(logs.some((l) => l.includes("1 proyectos omitidos"))).toBe(true);
  });

  it("registra el fallo cuando el proyecto lanza un valor no-Error (rama : err)", () => {
    // Arrange: proyecto válido + ruta sentinela que hace lanzar un string.
    const { tsconfig, dbPath, dir } = crearProyecto({ "a.ts": FUENTE_ALPHA });
    const sentinela = path.join(dir, SENTINELA_LANZA_STRING, "tsconfig.json");

    // Act: el segundo Project lanza un string → err instanceof Error === false.
    new GraphIndexer(dbPath, [tsconfig, sentinela]).index();

    // Assert: se indexa el válido y el aviso incluye el valor crudo no-Error.
    conGrafo(dbPath, (db) => {
      expect(existeNodo(db, "Alpha")).toBe(true);
    });
    expect(errores.some((e) => e.includes("Error cargando") && e.includes("fallo string de proyecto"))).toBe(true);
  });
});

describe("GraphIndexer.index — sin archivos indexables", () => {
  it("lanza cuando ningún archivo es procesable y cierra la DB en finally", () => {
    // Arrange: include que no casa con ningún .ts → 0 source files.
    const { tsconfig, dbPath } = crearProyecto({ "a.ts": FUENTE_ALPHA }, ["inexistentes/**/*.ts"]);
    const indexer = new GraphIndexer(dbPath, tsconfig);

    // Act / Assert: processedFiles === 0 → error explícito.
    expect(() => indexer.index()).toThrow(/No se pudo procesar ningun archivo/);

    // La DB quedó cerrada por el finally: se puede reabrir sin lock exclusivo.
    conGrafo(dbPath, (db) => {
      expect(contarNodos(db)).toBe(0);
    });
  });
});

describe("GraphIndexer.index — errores por-archivo del extractor", () => {
  it("captura fallos de processFile por archivo (Error y no-Error) sin abortar", () => {
    // Arrange: tres archivos; el extractor romperá en dos de ellos.
    const { tsconfig, dbPath } = crearProyecto({
      "ok.ts": FUENTE_BETA,
      "roto-error.ts": "export const x = 1;\n",
      "roto-string.ts": "export const y = 2;\n",
    });
    const original = CodeExtractor.prototype.processFile;
    vi.spyOn(CodeExtractor.prototype, "processFile").mockImplementation(function (
      this: CodeExtractor,
      file,
    ) {
      const base = file.getBaseName();
      if (base === "roto-error.ts") throw new Error("fallo simulado");
      if (base === "roto-string.ts") throw "fallo string"; // rama no-Error (: err)
      return original.call(this, file);
    });

    // Act: los fallos no deben propagarse; ok.ts sí se procesa.
    new GraphIndexer(dbPath, tsconfig).index();

    // Assert: nodo de ok.ts presente, avisos de error emitidos para los rotos.
    conGrafo(dbPath, (db) => {
      expect(existeNodo(db, "beta")).toBe(true);
    });
    expect(errores.some((e) => e.includes("Error analizando") && e.includes("roto-error.ts"))).toBe(true);
    expect(errores.some((e) => e.includes("Error analizando") && e.includes("roto-string.ts"))).toBe(true);
    // Solo 1 archivo procesado con éxito (ok.ts).
    expect(logs.some((l) => l.includes("1 archivos procesados"))).toBe(true);
  });
});
