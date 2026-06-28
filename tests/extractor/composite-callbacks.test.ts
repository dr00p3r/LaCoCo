import { describe, expect, it, vi } from "vitest";
import {
  CompositeCallbacks,
  SourceNodeBuffer,
} from "../../src/extractor/composite-callbacks.js";
import type { ExtractionCallbacks, NodeRow } from "../../src/extractor/types.js";

describe("CompositeCallbacks", () => {
  it("distribuye una sola emisión AST a todos los consumidores", () => {
    const first = callbacks();
    const second = callbacks();
    const composite = new CompositeCallbacks([first, second]);
    const node = createNode("file#A");

    composite.insertNode(node);
    composite.insertEdge("file#A", "file#B", "CALLS");

    expect(first.insertNode).toHaveBeenCalledWith(node);
    expect(second.insertNode).toHaveBeenCalledWith(node);
    expect(first.insertEdge).toHaveBeenCalledWith("file#A", "file#B", "CALLS");
    expect(second.insertEdge).toHaveBeenCalledWith("file#A", "file#B", "CALLS");
  });
});

describe("SourceNodeBuffer", () => {
  it("separa nodos por archivo y permite restaurar el estado anterior", () => {
    const buffer = new SourceNodeBuffer();
    const original = createNode("file#A");
    buffer.begin("file.ts");
    buffer.insertNode(original);
    buffer.end();

    const previous = buffer.begin("file.ts");
    buffer.insertNode(createNode("file#B"));
    buffer.restore("file.ts", previous);
    buffer.end();

    expect(buffer.get("file.ts")).toEqual([original]);
  });
});

function callbacks(): ExtractionCallbacks {
  return {
    insertNode: vi.fn(),
    insertEdge: vi.fn(),
  };
}

function createNode(id: string): NodeRow {
  return {
    id,
    kind: "FUNCTION",
    name: id,
    filepath: "file.ts",
    signature: `function ${id}()`,
    isDeprecated: 0,
  };
}
