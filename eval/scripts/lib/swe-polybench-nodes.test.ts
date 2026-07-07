import { describe, expect, it } from "vitest";
import {
  cstPathToNodeId,
  parseModifiedNodes,
  translateModifiedNodes,
} from "./swe-polybench-nodes.js";

describe("parseModifiedNodes", () => {
  it("devuelve [] para vacío, '[]', null y undefined", () => {
    expect(parseModifiedNodes("")).toEqual([]);
    expect(parseModifiedNodes("[]")).toEqual([]);
    expect(parseModifiedNodes(null)).toEqual([]);
    expect(parseModifiedNodes(undefined)).toEqual([]);
  });

  it("parsea JSON con comillas dobles", () => {
    expect(parseModifiedNodes('["a->program->function_declaration:f"]')).toEqual([
      "a->program->function_declaration:f",
    ]);
  });

  it("parsea repr de lista Python con comillas simples", () => {
    const raw = "['a.js->program->function_declaration:f', 'b.js->program->class_declaration:C']";
    expect(parseModifiedNodes(raw)).toEqual([
      "a.js->program->function_declaration:f",
      "b.js->program->class_declaration:C",
    ]);
  });

  it("acepta un arreglo ya parseado (como changed_files)", () => {
    expect(parseModifiedNodes(["x", "y"])).toEqual(["x", "y"]);
  });
});

describe("cstPathToNodeId", () => {
  it("función suelta → relpath#func", () => {
    const r = cstPathToNodeId("src/core/Raycaster.js->program->function_declaration:Raycaster");
    expect(r.nodeId).toBe("src/core/Raycaster.js#Raycaster");
    expect(r.kind).toBe("FUNCTION");
    expect(r.collapsed).toBe(false);
  });

  it("método de clase → relpath#Clase.metodo", () => {
    const r = cstPathToNodeId(
      "src/math/Matrix4.js->program->class_declaration:Matrix4->method_definition:setFromMatrix3",
    );
    expect(r.nodeId).toBe("src/math/Matrix4.js#Matrix4.setFromMatrix3");
    expect(r.kind).toBe("METHOD");
    expect(r.collapsed).toBe(false);
  });

  it("clase sola → relpath#Clase", () => {
    const r = cstPathToNodeId("src/core/Raycaster.d.ts->program->class_declaration:Raycaster");
    expect(r.nodeId).toBe("src/core/Raycaster.d.ts#Raycaster");
    expect(r.kind).toBe("CLASS");
    expect(r.collapsed).toBe(false);
  });

  it("constructor → colapsa a la clase (LaCoCo no indexa constructores)", () => {
    const r = cstPathToNodeId(
      "src/generators/Generator.js->program->class_declaration:Generator->method_definition:constructor",
    );
    expect(r.nodeId).toBe("src/generators/Generator.js#Generator");
    expect(r.kind).toBe("CLASS");
    expect(r.collapsed).toBe(true);
  });

  it("nodo anidado bajo un método → colapsa al método", () => {
    const r = cstPathToNodeId(
      "f.js->program->class_declaration:C->method_definition:m->function_declaration:inner",
    );
    expect(r.nodeId).toBe("f.js#C.m");
    expect(r.kind).toBe("METHOD");
    expect(r.collapsed).toBe(true);
  });

  it("función anidada bajo una función de nivel superior → colapsa a la externa", () => {
    const r = cstPathToNodeId(
      "f.js->program->function_declaration:outer->function_declaration:inner",
    );
    expect(r.nodeId).toBe("f.js#outer");
    expect(r.kind).toBe("FUNCTION");
    expect(r.collapsed).toBe(true);
  });

  it("hoja `pair` bajo un método → colapsa al método", () => {
    const r = cstPathToNodeId(
      "lib/plugins/deploy/deploy.js->program->class_declaration:Deploy->method_definition:run->pair:[]",
    );
    expect(r.nodeId).toBe("lib/plugins/deploy/deploy.js#Deploy.run");
    expect(r.kind).toBe("METHOD");
    expect(r.collapsed).toBe(true);
  });

  it("método huérfano (object-literal CommonJS, sin clase) → no mapea a nivel nodo", () => {
    const r = cstPathToNodeId(
      "lib/plugins/aws/lib/naming.js->program->method_definition:getTopicDLQPolicyLogicalId",
    );
    expect(r.nodeId).toBeNull();
    expect(r.reason).toBe("orphan_method");
    // el archivo sigue disponible como señal de nivel archivo
    expect(r.relpath).toBe("lib/plugins/aws/lib/naming.js");
  });

  it("ruta sin segmento de nodo → no mapea", () => {
    const r = cstPathToNodeId("a.js->program");
    expect(r.nodeId).toBeNull();
    expect(r.reason).toBe("no_node_segment");
  });

  it("ruta vacía → no mapea", () => {
    const r = cstPathToNodeId("");
    expect(r.nodeId).toBeNull();
    expect(r.reason).toBe("empty_path");
  });
});

describe("translateModifiedNodes", () => {
  it("dedup de node-ids y archivos, y unión con changed_files", () => {
    const raw = JSON.stringify([
      "src/a.js->program->function_declaration:f",
      "src/a.js->program->function_declaration:f", // duplicado exacto
      "src/b.js->program->class_declaration:C->method_definition:m",
      "src/c.js->program->method_definition:orphan", // huérfano → solo archivo
    ]);
    const t = translateModifiedNodes(raw, ["src/a.js", "src/d.js"]);

    expect(t.nodeIds.sort()).toEqual(["src/a.js#f", "src/b.js#C.m"]);
    expect(t.files.sort()).toEqual(["src/a.js", "src/b.js", "src/c.js", "src/d.js"]);
    expect(t.unmapped).toHaveLength(1);
    expect(t.unmapped[0]!.reason).toBe("orphan_method");
  });

  it("modified_nodes vacío → conjuntos vacíos (salvo changed_files)", () => {
    const t = translateModifiedNodes("[]", ["only/file.ts"]);
    expect(t.nodeIds).toEqual([]);
    expect(t.files).toEqual(["only/file.ts"]);
    expect(t.translated).toEqual([]);
  });
});
