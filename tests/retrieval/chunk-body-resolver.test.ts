import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChunkBodyResolver, type NodeSpanSource } from "../../src/retriever/utilities/filters/chunk-body-resolver.js";
import type { ContextChunk } from "../../src/retriever/models/strategies/types.js";
import type { NodeSpan } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";

function spanSource(spans: Record<string, NodeSpan>): NodeSpanSource {
  return {
    getNodeSpans(ids: string[]): Map<string, NodeSpan> {
      const map = new Map<string, NodeSpan>();
      for (const id of ids) if (spans[id]) map.set(id, spans[id]);
      return map;
    },
  };
}

function chunk(nodeId: string, text: string): ContextChunk {
  return { chunkId: nodeId, nodeId, score: 1, text, source: "hybrid" };
}

describe("ChunkBodyResolver", () => {
  let dir: string;
  let file: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "lacoco-body-"));
    file = path.join(dir, "dom.ts");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function span(name: string, startLine: number | null, endLine: number | null): NodeSpan {
    return { nodeId: `${file}#${name}`, name, filepath: file, signature: `firma ${name}`, startLine, endLine };
  }

  it("reemplaza la firma por el cuerpo del working tree con location poblado", () => {
    fs.writeFileSync(file, ["line1", "function foo() {", "  return 42;", "}", "line5"].join("\n"));
    const resolver = new ChunkBodyResolver(spanSource({ [`${file}#foo`]: span("foo", 2, 4) }));

    const [out] = resolver.resolve([chunk(`${file}#foo`, "function foo(): number")]);
    expect(out.text).toBe("function foo() {\n  return 42;\n}");
    expect(out.location).toEqual({ filepath: file, startLine: 2, endLine: 4, truncated: false });
  });

  it("recorta cuerpos largos con head + tail y marca truncated", () => {
    const body = Array.from({ length: 100 }, (_, i) => `  const x${i} = ${i};`);
    fs.writeFileSync(file, ["function big() {", ...body, "}"].join("\n"));
    // símbolo abarca las 102 líneas
    const resolver = new ChunkBodyResolver(spanSource({ [`${file}#big`]: span("big", 1, 102) }));

    const [out] = resolver.resolve([chunk(`${file}#big`, "function big(): void")]);
    expect(out.location?.truncated).toBe(true);
    expect(out.text).toContain("líneas omitidas");
    expect(out.text.split("\n").length).toBeLessThan(102);
    expect(out.text).toContain("function big() {");
  });

  it("cae a la firma si el archivo no existe", () => {
    const resolver = new ChunkBodyResolver(spanSource({ [`${file}#foo`]: span("foo", 2, 4) }));
    const original = chunk(`${file}#foo`, "function foo(): number");
    const [out] = resolver.resolve([original]);
    expect(out).toBe(original);
  });

  it("cae a la firma si el índice está desfasado (endLine fuera de rango)", () => {
    fs.writeFileSync(file, ["solo", "dos lineas"].join("\n"));
    const resolver = new ChunkBodyResolver(spanSource({ [`${file}#foo`]: span("foo", 2, 40) }));
    const original = chunk(`${file}#foo`, "function foo(): number");
    const [out] = resolver.resolve([original]);
    expect(out).toBe(original);
  });

  it("cae a la firma si el símbolo ya no está en el slice (nombre ausente)", () => {
    fs.writeFileSync(file, ["line1", "algo distinto", "otra cosa", "}"].join("\n"));
    const resolver = new ChunkBodyResolver(spanSource({ [`${file}#foo`]: span("foo", 2, 4) }));
    const original = chunk(`${file}#foo`, "function foo(): number");
    const [out] = resolver.resolve([original]);
    expect(out).toBe(original);
  });

  it("cae a la firma si el span tiene líneas null (nodo pre-006 o EXTERNAL_LIB)", () => {
    fs.writeFileSync(file, "cualquier cosa");
    const resolver = new ChunkBodyResolver(spanSource({ [`${file}#foo`]: span("foo", null, null) }));
    const original = chunk(`${file}#foo`, "firma");
    const [out] = resolver.resolve([original]);
    expect(out).toBe(original);
  });

  it("cae a la firma si el nodo no tiene span registrado", () => {
    const resolver = new ChunkBodyResolver(spanSource({}));
    const original = chunk(`${file}#desconocido`, "firma");
    const [out] = resolver.resolve([original]);
    expect(out).toBe(original);
  });

  it("no confía en el nombre para el símbolo default", () => {
    fs.writeFileSync(file, ["line1", "export default withStyles()(Foo)", "line3"].join("\n"));
    const resolver = new ChunkBodyResolver(
      spanSource({ [`${file}#default`]: span("default", 2, 2) }),
    );
    const [out] = resolver.resolve([chunk(`${file}#default`, "withStyles()(Foo)")]);
    expect(out.text).toBe("export default withStyles()(Foo)");
    expect(out.location?.startLine).toBe(2);
  });
});
