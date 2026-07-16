/**
 * Ramas poco cubiertas de utilities.ts centradas en la resolución de símbolos
 * y declaraciones a IDs canónicos (resolveDeclarationToId / resolveSymbolToId /
 * resolveAliasedSymbol) y en los cortes de extractPackageName.
 *
 * Se ejercitan con proyectos ts-morph en memoria, obteniendo nodos/símbolos
 * concretos y llamando directamente a las utilidades puras.
 */

import {
  ModuleResolutionKind,
  Project,
  ScriptTarget,
  SyntaxKind,
  ts,
  type SourceFile,
} from "ts-morph";
import { describe, expect, it } from "vitest";
import {
  extractPackageName,
  resolveAliasedSymbol,
  resolveDeclarationToId,
  resolveSymbolToId,
} from "../../src/extractor/utilities.js";

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

function sourceFile(code: string, name = "/u.ts"): SourceFile {
  return newProject().createSourceFile(name, code);
}

describe("utilities: resolveDeclarationToId por tipo de declaración", () => {
  it("resuelve funciones nombradas y anónimas (default export)", () => {
    // Arrange
    const sf = sourceFile(`export function named(): void {}\nexport default function () {}`);
    const [named, anon] = sf.getFunctions();
    // Act / Assert — nombrada → id; anónima (sin nombre) → null.
    expect(resolveDeclarationToId(named!)).toBe("/u.ts#named");
    expect(resolveDeclarationToId(anon!)).toBeNull();
  });

  it("resuelve clase/interfaz/type/enum nombrados y una clase anónima a null", () => {
    // Arrange
    const sf = sourceFile(`
      export class Foo {}
      export interface Bar {}
      export type Baz = string;
      export enum Qux { A }
      export default class {}
    `);
    // Act / Assert
    expect(resolveDeclarationToId(sf.getClassOrThrow("Foo"))).toBe("/u.ts#Foo");
    expect(resolveDeclarationToId(sf.getInterfaceOrThrow("Bar"))).toBe("/u.ts#Bar");
    expect(resolveDeclarationToId(sf.getTypeAliasOrThrow("Baz"))).toBe("/u.ts#Baz");
    expect(resolveDeclarationToId(sf.getEnumOrThrow("Qux"))).toBe("/u.ts#Qux");
    const anonClass = sf.getClasses().find((c) => c.getName() === undefined)!;
    expect(resolveDeclarationToId(anonClass)).toBeNull();
  });

  it("resuelve variable exportada e ignora la no exportada", () => {
    // Arrange
    const sf = sourceFile(`export const shown = 1;\nconst hidden = 2;`);
    const shown = sf.getVariableDeclarationOrThrow("shown");
    const hidden = sf.getVariableDeclarationOrThrow("hidden");
    // Act / Assert
    expect(resolveDeclarationToId(shown)).toBe("/u.ts#shown");
    expect(resolveDeclarationToId(hidden)).toBeNull();
  });

  it("resuelve método de clase y método de objeto exportado; null sin dueño", () => {
    // Arrange
    const sf = sourceFile(`
      export class Svc { run(): void {} }
      export const obj = { handle(): void {} };
      const local = { hidden(): void {} };
    `);
    const classMethod = sf.getClassOrThrow("Svc").getMethodOrThrow("run");
    const methods = sf.getDescendantsOfKind(SyntaxKind.MethodDeclaration);
    const objMethod = methods.find((m) => m.getName() === "handle")!;
    const hiddenMethod = methods.find((m) => m.getName() === "hidden")!;
    // Act / Assert
    expect(resolveDeclarationToId(classMethod)).toBe("/u.ts#Svc.run");
    expect(resolveDeclarationToId(objMethod)).toBe("/u.ts#obj.handle");
    // Método en objeto de variable no exportada → null.
    expect(resolveDeclarationToId(hiddenMethod)).toBeNull();
  });

  it("resuelve propiedad, accessors get/set y miembro de enum", () => {
    // Arrange
    const sf = sourceFile(`
      export class Agg {
        field = 1;
        private _v = 0;
        get v(): number { return this._v; }
        set v(x: number) { this._v = x; }
      }
      export enum E { First, Second }
    `);
    const cls = sf.getClassOrThrow("Agg");
    const prop = cls.getPropertyOrThrow("field");
    const getter = cls.getGetAccessorOrThrow("v");
    const setter = cls.getSetAccessorOrThrow("v");
    const member = sf.getEnumOrThrow("E").getMemberOrThrow("First");
    // Act / Assert
    expect(resolveDeclarationToId(prop)).toBe("/u.ts#Agg::field");
    expect(resolveDeclarationToId(getter)).toBe("/u.ts#Agg::get:v");
    expect(resolveDeclarationToId(setter)).toBe("/u.ts#Agg::set:v");
    expect(resolveDeclarationToId(member)).toBe("/u.ts#E.First");
  });

  it("mapea `export default <expr>` al id #default", () => {
    // Arrange — export assignment que no es `export =`.
    const sf = sourceFile(`const Foo = 1;\nexport default Foo;`);
    const assignment = sf.getFirstDescendantByKindOrThrow(SyntaxKind.ExportAssignment);
    // Act / Assert
    expect(resolveDeclarationToId(assignment)).toBe("/u.ts#default");
  });
});

describe("utilities: resolveAliasedSymbol y resolveSymbolToId", () => {
  it("sigue el alias de import hasta el símbolo declarado originalmente", () => {
    // Arrange — símbolo importado (alias) que apunta a la función original.
    const project = newProject();
    project.createSourceFile("/orig.ts", `export function target(): void {}`);
    const consumer = project.createSourceFile(
      "/consumer.ts",
      `import { target } from "./orig";\nexport const use = () => target();`,
    );
    const importSymbol = consumer
      .getImportDeclarationOrThrow("./orig")
      .getNamedImports()[0]!
      .getNameNode()
      .getSymbolOrThrow();
    // Act
    const resolved = resolveAliasedSymbol(importSymbol);
    // Assert — el alias se resuelve al símbolo real y su id apunta al archivo origen.
    expect(importSymbol.isAlias()).toBe(true);
    expect(resolveSymbolToId(importSymbol)).toBe("/orig.ts#target");
    expect(resolved?.getName()).toBe("target");
  });

  it("devuelve null para un símbolo indefinido", () => {
    // Act / Assert
    expect(resolveAliasedSymbol(undefined)).toBeUndefined();
    expect(resolveSymbolToId(undefined)).toBeNull();
  });
});

describe("utilities: extractPackageName cortes finales", () => {
  it("resuelve paquete scoped sin subruta (sin barra final)", () => {
    // after empieza con @ y no tiene segunda barra → devuelve el paquete completo.
    expect(extractPackageName("/x/node_modules/@scope/name")).toBe("@scope/name");
  });

  it("resuelve paquete simple sin subruta (sin barra final)", () => {
    // after sin barra → devuelve el nombre tal cual.
    expect(extractPackageName("/x/node_modules/rxjs")).toBe("rxjs");
  });
});
