import { ModuleResolutionKind, Project, ScriptTarget } from "ts-morph";
import { describe, expect, it } from "vitest";
import { CodeExtractor } from "../../src/extractor/code-extractor.js";
import type { EdgeRow, ExtractionCallbacks, NodeRow } from "../../src/extractor/types.js";

describe("CodeExtractor relations", () => {
  it("connects imported calls, class members, exported values, and type references", () => {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        moduleResolution: ModuleResolutionKind.NodeJs,
        target: ScriptTarget.ES2022,
      },
    });
    project.createSourceFile("/dep.ts", `
      export interface BaseInput { value: string }
      export interface Result { ok: boolean }
      export class Worker { run(): Result { return { ok: true }; } }
      export function helper(): void {}
      export const scheduler = new Worker();
    `);
    project.createSourceFile("/main.ts", `
      import { BaseInput, Result, Worker, helper, scheduler } from "./dep";
      export interface Request extends BaseInput { result: Result }
      export class Service {
        request!: Request;
        execute(): Worker { helper(); this.finish(); return new Worker(); }
        private finish(): void {}
      }
      export function schedule(value: unknown = scheduler): void {}
    `);

    const nodes: NodeRow[] = [];
    const edges: EdgeRow[] = [];
    const callbacks: ExtractionCallbacks = {
      insertNode: (node) => nodes.push(node),
      insertEdge: (sourceId, targetId, relation) => edges.push({ sourceId, targetId, relation }),
    };
    const extractor = new CodeExtractor(callbacks);
    for (const sourceFile of project.getSourceFiles()) extractor.processFile(sourceFile);

    expect(nodes).toContainEqual(expect.objectContaining({ id: "/dep.ts#scheduler", kind: "VARIABLE" }));
    expect(edges).toEqual(expect.arrayContaining([
      edge("/main.ts#Service", "/main.ts#Service.execute", "DECLARES"),
      edge("/main.ts#Service", "/main.ts#Service.finish", "DECLARES"),
      edge("/main.ts#Service", "/main.ts#Service::request", "DECLARES"),
      edge("/main.ts#Service.execute", "/dep.ts#helper", "CALLS"),
      edge("/main.ts#Service.execute", "/main.ts#Service.finish", "CALLS"),
      edge("/main.ts#Service.execute", "/dep.ts#Worker", "INSTANTIATES"),
      edge("/dep.ts#scheduler", "/dep.ts#Worker", "INSTANTIATES"),
      edge("/main.ts#schedule", "/dep.ts#scheduler", "REFERENCES"),
      edge("/main.ts#Request", "/dep.ts#BaseInput", "EXTENDS"),
      edge("/main.ts#Request", "/dep.ts#Result", "REFERENCES"),
    ]));
  });
});

describe("CodeExtractor line spans", () => {
  it("populates startLine/endLine from ts-morph declarations", () => {
    const project = new Project({
      useInMemoryFileSystem: true,
      compilerOptions: {
        moduleResolution: ModuleResolutionKind.NodeJs,
        target: ScriptTarget.ES2022,
      },
    });
    // Contenido sin newline inicial → líneas 1-indexadas predecibles.
    project.createSourceFile(
      "/spans.ts",
      [
        "export interface Foo { a: number }", // L1
        "export function bar(): void {}", // L2
        "export class Baz {", // L3
        "  run(): void {}", // L4
        "}", // L5
        "export const qux = (n: number) => n + 1;", // L6
      ].join("\n"),
    );

    const nodes: NodeRow[] = [];
    const callbacks: ExtractionCallbacks = {
      insertNode: (node) => nodes.push(node),
      insertEdge: () => {},
    };
    const extractor = new CodeExtractor(callbacks);
    for (const sourceFile of project.getSourceFiles()) extractor.processFile(sourceFile);

    const byId = (id: string): NodeRow => {
      const node = nodes.find((n) => n.id === id);
      if (!node) throw new Error(`nodo no encontrado: ${id}`);
      return node;
    };

    expect(byId("/spans.ts#Foo")).toMatchObject({ startLine: 1, endLine: 1 });
    expect(byId("/spans.ts#bar")).toMatchObject({ startLine: 2, endLine: 2 });
    expect(byId("/spans.ts#Baz")).toMatchObject({ startLine: 3, endLine: 5 });
    expect(byId("/spans.ts#Baz.run")).toMatchObject({ startLine: 4, endLine: 4 });
    expect(byId("/spans.ts#qux")).toMatchObject({ startLine: 6, endLine: 6 });
  });
});

function edge(sourceId: string, targetId: string, relation: EdgeRow["relation"]): EdgeRow {
  return { sourceId, targetId, relation };
}
