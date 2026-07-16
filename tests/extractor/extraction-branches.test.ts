/**
 * Pruebas de ramas del extractor AST.
 *
 * Objetivo: forzar los caminos poco cubiertos de los 5 módulos del extractor
 * mediante fixtures de código TypeScript reales procesados por `CodeExtractor`,
 * más pruebas unitarias directas de las utilidades puras.
 *
 * Módulos cubiertos:
 *   - class-extraction.ts   (EXTENDS/IMPLEMENTS, INJECTS, propiedades,
 *                            accessors get/set, métodos + sobrecargas)
 *   - callable-analysis.ts  (CONSUMES_DATA por array/intersección/unión,
 *                            PRODUCES con unwrap, MUTATES_STATE, INSTANTIATES,
 *                            IMPORTS_EXTERNAL, arrow inline)
 *   - variable-extraction.ts (arrow export, object literal + método shorthand
 *                            + anidado, new expr, no-exportados)
 *   - utilities.ts          (firmas de clase/arrow, unwrapGenericWrapper,
 *                            isDeprecated, resolveTypeToId sobre anónimos)
 *   - node-extraction.ts    (interfaces extends, type alias, enum, función)
 */

import {
  ModuleResolutionKind,
  Project,
  ScriptTarget,
  ts,
  type ArrowFunction,
  type Type,
} from "ts-morph";
import { describe, expect, it } from "vitest";
import { CodeExtractor } from "../../src/extractor/code-extractor.js";
import {
  buildArrowSignature,
  buildClassSignature,
  isDeprecated,
  unwrapGenericWrapper,
  resolveTypeToId,
} from "../../src/extractor/utilities.js";
import type { EdgeRow, ExtractionCallbacks, NodeRow } from "../../src/extractor/types.js";

// ───────────────────────────────────────────────────────────────────────────
// Helpers compartidos (mismo patrón que react-extraction.test.ts)
// ───────────────────────────────────────────────────────────────────────────

/** Crea un proyecto ts-morph en memoria con soporte JSX/JS. */
function newProject(): Project {
  return new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      moduleResolution: ModuleResolutionKind.NodeJs,
      target: ScriptTarget.ES2022,
      jsx: ts.JsxEmit.React,
      allowJs: true,
    },
  });
}

/** Extrae nodos y aristas de un conjunto de archivos. */
function extract(files: Record<string, string>): { nodes: NodeRow[]; edges: EdgeRow[] } {
  const project = newProject();
  for (const [path, content] of Object.entries(files)) project.createSourceFile(path, content);

  const nodes: NodeRow[] = [];
  const edges: EdgeRow[] = [];
  const callbacks: ExtractionCallbacks = {
    insertNode: (node) => nodes.push(node),
    insertEdge: (sourceId, targetId, relation) => edges.push({ sourceId, targetId, relation }),
  };
  const extractor = new CodeExtractor(callbacks);
  for (const sourceFile of project.getSourceFiles()) extractor.processFile(sourceFile);
  return { nodes, edges };
}

function edge(sourceId: string, targetId: string, relation: EdgeRow["relation"]): EdgeRow {
  return { sourceId, targetId, relation };
}

/** Devuelve todas las aristas de un origen con una relación concreta. */
function targetsOf(edges: EdgeRow[], sourceId: string, relation: EdgeRow["relation"]): string[] {
  return edges.filter((e) => e.sourceId === sourceId && e.relation === relation).map((e) => e.targetId);
}

// ───────────────────────────────────────────────────────────────────────────
// class-extraction.ts
// ───────────────────────────────────────────────────────────────────────────

describe("class-extraction: SYS relations (EXTENDS / IMPLEMENTS)", () => {
  it("emite EXTENDS hacia la superclase e IMPLEMENTS hacia cada interfaz", () => {
    // Arrange
    const files = {
      "/svc.ts": `
        export class Base<T> { protected value!: T; }
        export interface ILogger { log(): void; }
        export interface IDisposable { dispose(): void; }
        export class OrderService extends Base<number> implements ILogger, IDisposable {
          log(): void {}
          dispose(): void {}
        }
      `,
    };
    // Act
    const { edges } = extract(files);
    // Assert
    expect(edges).toContainEqual(edge("/svc.ts#OrderService", "/svc.ts#Base", "EXTENDS"));
    expect(edges).toContainEqual(edge("/svc.ts#OrderService", "/svc.ts#ILogger", "IMPLEMENTS"));
    expect(edges).toContainEqual(edge("/svc.ts#OrderService", "/svc.ts#IDisposable", "IMPLEMENTS"));
  });

  it("no emite SYS cuando la clase no tiene base ni interfaces", () => {
    // Arrange / Act
    const { edges } = extract({ "/plain.ts": `export class Plain { run(): void {} }` });
    // Assert
    expect(edges.some((e) => e.relation === "EXTENDS")).toBe(false);
    expect(edges.some((e) => e.relation === "IMPLEMENTS")).toBe(false);
  });
});

describe("class-extraction: inyección por constructor (INJECTS)", () => {
  it("inyecta solo parámetros de tipo objeto resoluble, ignorando primitivos y any", () => {
    // Arrange
    const files = {
      "/di.ts": `
        export class Repo { find(): void {} }
        export class Service {
          constructor(
            private readonly repo: Repo,   // objeto resoluble → INJECTS
            private readonly name: string, // primitivo → ignorado
            private readonly opts: any,     // any → ignorado
          ) {}
        }
      `,
    };
    // Act
    const { edges } = extract(files);
    // Assert
    const injects = targetsOf(edges, "/di.ts#Service", "INJECTS");
    expect(injects).toEqual(["/di.ts#Repo"]);
  });
});

describe("class-extraction: propiedades y estáticos", () => {
  it("declara propiedades de instancia y estáticas como nodos PROPERTY", () => {
    // Arrange
    const files = {
      "/props.ts": `
        export class Config {
          static readonly VERSION = "1.0";
          private secret = "x";
        }
      `,
    };
    // Act
    const { nodes, edges } = extract(files);
    // Assert
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/props.ts#Config::VERSION", kind: "PROPERTY" }));
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/props.ts#Config::secret", kind: "PROPERTY" }));
    expect(edges).toContainEqual(edge("/props.ts#Config", "/props.ts#Config::VERSION", "DECLARES"));
  });
});

describe("class-extraction: accessors get/set", () => {
  it("emite nodos ACCESSOR diferenciados para getter y setter", () => {
    // Arrange
    const files = {
      "/acc.ts": `
        export class Aggregate {
          private _id = 1;
          get id(): number { return this._id; }
          set id(v: number) { this._id = v; }
        }
      `,
    };
    // Act
    const { nodes, edges } = extract(files);
    // Assert
    const getter = nodes.find((n) => n.id === "/acc.ts#Aggregate::get:id");
    const setter = nodes.find((n) => n.id === "/acc.ts#Aggregate::set:id");
    expect(getter).toMatchObject({ kind: "ACCESSOR", name: "get id" });
    expect(setter).toMatchObject({ kind: "ACCESSOR", name: "set id" });
    // La firma del accessor no incluye el cuerpo (se corta en la primera llave).
    expect(getter?.signature).not.toContain("{");
    expect(edges).toContainEqual(edge("/acc.ts#Aggregate", "/acc.ts#Aggregate::get:id", "DECLARES"));
    expect(edges).toContainEqual(edge("/acc.ts#Aggregate", "/acc.ts#Aggregate::set:id", "DECLARES"));
  });
});

describe("class-extraction: métodos y sobrecargas", () => {
  it("conserva solo la implementación de un método sobrecargado", () => {
    // Arrange
    const files = {
      "/ovl.ts": `
        export class Handler {
          process(x: string): void;
          process(x: number): void;
          process(x: string | number): void { void x; }
        }
      `,
    };
    // Act
    const { nodes } = extract(files);
    // Assert — exactamente un nodo METHOD para 'process' (no las firmas de sobrecarga).
    const methodNodes = nodes.filter((n) => n.id === "/ovl.ts#Handler.process" && n.kind === "METHOD");
    expect(methodNodes).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// callable-analysis.ts
// ───────────────────────────────────────────────────────────────────────────

describe("callable-analysis: CONSUMES_DATA por forma del parámetro", () => {
  it("cubre objeto, intersección y unión (excluyendo null/undefined)", () => {
    // Arrange — nota: un array (`B[]`) es un tipo objeto, así que lo captura la
    // rama isObject y resuelve al `Array` de la lib (null); no llega a la rama de array.
    const files = {
      "/data.ts": `
        export interface A { a: number }
        export interface C { c: number }
        export interface D { d: number }
        export interface E { e: number }

        export function consume(
          obj: A,               // objeto → CONSUMES_DATA A
          mix: C & D,           // intersección → CONSUMES_DATA C y D
          opt: E | null,        // unión con null → CONSUMES_DATA E (null excluido)
        ): void { void obj; void mix; void opt; }
      `,
    };
    // Act
    const { edges } = extract(files);
    const consumes = targetsOf(edges, "/data.ts#consume", "CONSUMES_DATA");
    // Assert
    expect(consumes).toEqual(expect.arrayContaining([
      "/data.ts#A", "/data.ts#C", "/data.ts#D", "/data.ts#E",
    ]));
  });

  it("ignora parámetros de tipo objeto anónimo (símbolo __type)", () => {
    // Arrange — el tipo inline `{ x: number }` es anónimo → resolveTypeToId null.
    const files = {
      "/anon.ts": `export function f(p: { x: number }): void { void p; }`,
    };
    // Act
    const { edges } = extract(files);
    // Assert
    expect(edges.some((e) => e.sourceId === "/anon.ts#f" && e.relation === "CONSUMES_DATA")).toBe(false);
  });
});

describe("callable-analysis: PRODUCES con unwrap de wrappers", () => {
  it("desempaqueta Promise<T> hacia el tipo interno", () => {
    // Arrange
    const files = {
      "/prod.ts": `
        export interface Order { id: number }
        export async function load(): Promise<Order> { return { id: 1 }; }
      `,
    };
    // Act
    const { edges } = extract(files);
    // Assert
    expect(edges).toContainEqual(edge("/prod.ts#load", "/prod.ts#Order", "PRODUCES"));
  });

  it("no emite PRODUCES para retorno void", () => {
    // Arrange / Act
    const { edges } = extract({ "/void.ts": `export function noop(): void {}` });
    // Assert
    expect(edges.some((e) => e.sourceId === "/void.ts#noop" && e.relation === "PRODUCES")).toBe(false);
  });
});

describe("callable-analysis: recorrido profundo del AST", () => {
  it("emite INSTANTIATES, CALLS, MUTATES_STATE (método mutable y asignación) y arrow inline", () => {
    // Arrange
    const files = {
      "/ast.ts": `
        export interface Dto { v: number }
        export class Basket {
          items: number[] = [];
          add(n: number): void { this.items.push(n); }
        }
        export class Service {
          private basket = new Basket();
          private count = 0;
          run(): Basket {
            this.basket.add(1);        // 'add' es método mutable → MUTATES_STATE hacia Basket
            this.count = this.count + 1; // asignación a propiedad → MUTATES_STATE hacia Service
            [1, 2].forEach((x: Dto) => { void x; }); // arrow inline con param tipado → CONSUMES_DATA Dto
            return new Basket();         // NewExpression → INSTANTIATES
          }
        }
      `,
    };
    // Act
    const { edges } = extract(files);
    const src = "/ast.ts#Service.run";
    // Assert
    expect(edges).toContainEqual(edge(src, "/ast.ts#Basket", "INSTANTIATES"));
    expect(edges).toContainEqual(edge(src, "/ast.ts#Basket.add", "CALLS"));
    expect(targetsOf(edges, src, "MUTATES_STATE")).toEqual(expect.arrayContaining(["/ast.ts#Basket", "/ast.ts#Service"]));
    expect(edges).toContainEqual(edge(src, "/ast.ts#Dto", "CONSUMES_DATA"));
  });

  it("emite IMPORTS_EXTERNAL y un nodo EXTERNAL_LIB al llamar a una dependencia de node_modules", () => {
    // Arrange — módulo simulado dentro de node_modules.
    const project = newProject();
    project.createSourceFile(
      "/node_modules/leftpad/index.d.ts",
      `export declare function leftpad(input: string, len: number): string;`,
    );
    project.createSourceFile(
      "/app.ts",
      `
        import { leftpad } from "leftpad";
        export function pad(s: string): string { return leftpad(s, 4); }
      `,
    );
    const nodes: NodeRow[] = [];
    const edges: EdgeRow[] = [];
    const extractor = new CodeExtractor({
      insertNode: (n) => nodes.push(n),
      insertEdge: (s, t, r) => edges.push({ sourceId: s, targetId: t, relation: r }),
    });
    // Act
    for (const sf of project.getSourceFiles()) extractor.processFile(sf);
    // Assert
    const extEdge = edges.find((e) => e.sourceId === "/app.ts#pad" && e.relation === "IMPORTS_EXTERNAL");
    expect(extEdge).toBeDefined();
    const libNode = nodes.find((n) => n.kind === "EXTERNAL_LIB" && n.id === extEdge?.targetId);
    expect(libNode).toMatchObject({ kind: "EXTERNAL_LIB", name: expect.stringContaining("leftpad") });
  });

  it("emite CALLS por defecto de parámetro que referencia una constante exportada", () => {
    // Arrange — el inicializador del parámetro dispara extractValueReferences.
    const files = {
      "/ref.ts": `
        export const DEFAULT_LIMIT = 10;
        export function paginate(limit: number = DEFAULT_LIMIT): number { return limit; }
      `,
    };
    // Act
    const { edges } = extract(files);
    // Assert
    expect(edges).toContainEqual(edge("/ref.ts#paginate", "/ref.ts#DEFAULT_LIMIT", "REFERENCES"));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// variable-extraction.ts
// ───────────────────────────────────────────────────────────────────────────

describe("variable-extraction: object literals", () => {
  it("extrae arrow property, método shorthand y objeto anidado como nodos propios", () => {
    // Arrange
    const files = {
      "/handlers.ts": `
        export interface Dto { v: number }
        export const handlers = {
          create: (dto: Dto) => dto.v,        // arrow property → ARROW_FUNCTION
          remove(id: number) { return id; },   // método shorthand → METHOD
          nested: {                            // objeto anidado → VARIABLE + recursión
            ping: () => 1,
          },
        };
      `,
    };
    // Act
    const { nodes, edges } = extract(files);
    // Assert
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/handlers.ts#handlers.create", kind: "ARROW_FUNCTION" }));
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/handlers.ts#handlers.remove", kind: "METHOD" }));
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/handlers.ts#handlers.nested", kind: "VARIABLE" }));
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/handlers.ts#handlers.nested.ping", kind: "ARROW_FUNCTION" }));
    expect(edges).toContainEqual(edge("/handlers.ts#handlers", "/handlers.ts#handlers.create", "DECLARES"));
    expect(edges).toContainEqual(edge("/handlers.ts#handlers.nested", "/handlers.ts#handlers.nested.ping", "DECLARES"));
    // La arrow property analiza su cuerpo → CONSUMES_DATA hacia Dto.
    expect(edges).toContainEqual(edge("/handlers.ts#handlers.create", "/handlers.ts#Dto", "CONSUMES_DATA"));
  });
});

describe("variable-extraction: declaraciones de variable", () => {
  it("emite INSTANTIATES para `export const x = new C()`", () => {
    // Arrange
    const files = {
      "/inst.ts": `
        export class Engine {}
        export const engine = new Engine();
      `,
    };
    // Act
    const { nodes, edges } = extract(files);
    // Assert
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/inst.ts#engine", kind: "VARIABLE" }));
    expect(edges).toContainEqual(edge("/inst.ts#engine", "/inst.ts#Engine", "INSTANTIATES"));
  });

  it("emite un nodo VARIABLE simple para un valor primitivo exportado", () => {
    // Arrange / Act
    const { nodes } = extract({ "/val.ts": `export const MAX = 42;` });
    // Assert
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/val.ts#MAX", kind: "VARIABLE" }));
  });

  it("ignora variables no exportadas en archivos backend (.ts)", () => {
    // Arrange / Act
    const { nodes } = extract({ "/local.ts": `const hidden = () => 1; export const shown = () => 2;` });
    // Assert
    expect(nodes.find((n) => n.id === "/local.ts#hidden")).toBeUndefined();
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/local.ts#shown", kind: "ARROW_FUNCTION" }));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// node-extraction.ts
// ───────────────────────────────────────────────────────────────────────────

describe("node-extraction: interfaces, types y enums", () => {
  it("emite INTERFACE con EXTENDS, TYPE alias y ENUM con miembros", () => {
    // Arrange
    const files = {
      "/model.ts": `
        export interface Animal { legs: number }
        export interface Dog extends Animal { bark(): void }
        export type ID = string | number;
        export enum Color { Red, Green, Blue }
      `,
    };
    // Act
    const { nodes, edges } = extract(files);
    // Assert
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/model.ts#Dog", kind: "INTERFACE" }));
    expect(edges).toContainEqual(edge("/model.ts#Dog", "/model.ts#Animal", "EXTENDS"));
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/model.ts#ID", kind: "TYPE" }));
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/model.ts#Color", kind: "ENUM" }));
    expect(nodes).toContainEqual(expect.objectContaining({ id: "/model.ts#Color.Red", kind: "ENUM_MEMBER" }));
    expect(edges).toContainEqual(edge("/model.ts#Color", "/model.ts#Color.Red", "DECLARES"));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// utilities.ts — pruebas unitarias directas
// ───────────────────────────────────────────────────────────────────────────

/** Obtiene la primera arrow function declarada como variable en un fuente. */
function firstArrow(code: string): ArrowFunction {
  const project = newProject();
  const sf = project.createSourceFile("/u.ts", code);
  const decl = sf.getVariableDeclarationOrThrow((d) => d.getInitializer()?.getKindName() === "ArrowFunction");
  return decl.getInitializerOrThrow() as ArrowFunction;
}

/** Obtiene el tipo de retorno de la primera función declarada. */
function returnType(code: string): Type {
  const project = newProject();
  const sf = project.createSourceFile("/t.ts", code);
  return sf.getFunctions()[0]!.getReturnType();
}

describe("utilities: buildArrowSignature", () => {
  it("incluye async y el tipo de retorno explícito", () => {
    // Arrange
    const arrow = firstArrow(`const f = async (order: number): Promise<number> => order;`);
    // Act
    const sig = buildArrowSignature("f", arrow);
    // Assert
    expect(sig).toBe("const f = async (order: number): Promise<number> =>");
  });

  it("omite async y el tipo de retorno cuando no están presentes", () => {
    // Arrange
    const arrow = firstArrow(`const g = (x: string) => x;`);
    // Act
    const sig = buildArrowSignature("g", arrow);
    // Assert
    expect(sig).toBe("const g = (x: string) =>");
  });
});

describe("utilities: buildClassSignature", () => {
  it("compone modificadores, genéricos, extends e implements", () => {
    // Arrange
    const project = newProject();
    const sf = project.createSourceFile(
      "/c.ts",
      `
        class Base {}
        interface IFace {}
        export abstract class Svc<T> extends Base implements IFace {}
      `,
    );
    const cls = sf.getClassOrThrow("Svc");
    // Act
    const sig = buildClassSignature(cls);
    // Assert
    expect(sig).toContain("abstract");
    expect(sig).toContain("class Svc<T>");
    expect(sig).toContain("extends Base");
    expect(sig).toContain("implements IFace");
  });

  it("usa 'Anonymous' y sin cláusulas para una clase anónima mínima", () => {
    // Arrange — expresión de clase anónima.
    const project = newProject();
    const sf = project.createSourceFile("/anon.ts", `const X = class {};`);
    const cls = sf.getDescendantsOfKind(ts.SyntaxKind.ClassExpression)[0]!;
    // Act
    const sig = buildClassSignature(cls as unknown as import("ts-morph").ClassDeclaration);
    // Assert
    expect(sig).toBe("class Anonymous");
  });
});

describe("utilities: unwrapGenericWrapper", () => {
  it("desempaqueta Promise<T> al tipo interno", () => {
    // Arrange
    const t = returnType(`export function f(): Promise<{ id: number }> { return { id: 1 }; }`);
    // Act
    const inner = unwrapGenericWrapper(t);
    // Assert — el interno ya no es una Promise.
    expect(inner?.getSymbol()?.getName()).not.toBe("Promise");
  });

  it("devuelve el mismo tipo para un primitivo (no objeto)", () => {
    // Arrange
    const t = returnType(`export function f(): number { return 1; }`);
    // Act
    const result = unwrapGenericWrapper(t);
    // Assert
    expect(result).toBe(t);
  });

  it("devuelve null al superar la profundidad máxima de anidamiento", () => {
    // Arrange
    const t = returnType(`export function f(): number { return 1; }`);
    // Act — depth > 5 corta inmediatamente.
    const result = unwrapGenericWrapper(t, 6);
    // Assert
    expect(result).toBeNull();
  });
});

describe("utilities: isDeprecated y resolveTypeToId", () => {
  it("marca isDeprecated=1 en una función con @deprecated en su JSDoc", () => {
    // Arrange
    const { nodes } = extract({
      "/dep.ts": `
        /** @deprecated usar v2 */
        export function legacy(): void {}
      `,
    });
    // Act
    const node = nodes.find((n) => n.id === "/dep.ts#legacy");
    // Assert
    expect(node?.isDeprecated).toBe(1);
  });

  it("isDeprecated devuelve 0 cuando el símbolo es undefined", () => {
    // Arrange / Act / Assert
    expect(isDeprecated(undefined)).toBe(0);
  });

  it("resolveTypeToId devuelve null para un tipo primitivo sin símbolo", () => {
    // Arrange
    const t = returnType(`export function f(): string { return ""; }`);
    // Act / Assert — string no expone símbolo declarable resoluble a nodo.
    expect(resolveTypeToId(t)).toBeNull();
  });
});
