import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { openGraphLookup } from "./graph-reader.js";

describe("openGraphLookup", () => {
  it("checks annotated node IDs against a readonly graph", () => {
    const directory = mkdtempSync(join(tmpdir(), "lacoco-graph-reader-"));
    const path = join(directory, "tensor.sqlite");
    const database = new Database(path);
    database.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY)");
    database.prepare("INSERT INTO nodes (id) VALUES (?)").run("src/foo.ts#Foo");
    database.close();

    const graph = openGraphLookup(path);
    try {
      expect(graph.findMissingNodeIds(["src/foo.ts#Foo", "src/bar.ts#Bar"]))
        .toEqual(["src/bar.ts#Bar"]);
    } finally {
      graph.close();
    }
  });

  it("resolves file-level presence and node count", () => {
    const directory = mkdtempSync(join(tmpdir(), "lacoco-graph-reader-file-"));
    const path = join(directory, "tensor.sqlite");
    const database = new Database(path);
    database.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, filepath TEXT)");
    const insert = database.prepare("INSERT INTO nodes (id, filepath) VALUES (?, ?)");
    insert.run("/repo/src/foo.ts#Foo", "/repo/src/foo.ts");
    insert.run("/repo/src/bar.ts", "/repo/src/bar.ts"); // nodo file-level (id == filepath)
    database.close();

    const graph = openGraphLookup(path);
    try {
      // símbolo cuyo archivo está en el grafo → hit de archivo
      expect(graph.hasNodeInFile("/repo/src/foo.ts")).toBe(true);
      // nodo file-level directo
      expect(graph.hasNodeInFile("/repo/src/bar.ts")).toBe(true);
      // archivo ausente → no
      expect(graph.hasNodeInFile("/repo/src/missing.ts")).toBe(false);
      expect(graph.nodeCount()).toBe(2);
    } finally {
      graph.close();
    }
  });

  it("reports an empty graph as zero nodes", () => {
    const directory = mkdtempSync(join(tmpdir(), "lacoco-graph-reader-empty-"));
    const path = join(directory, "tensor.sqlite");
    const database = new Database(path);
    database.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, filepath TEXT)");
    database.close();

    const graph = openGraphLookup(path);
    try {
      expect(graph.nodeCount()).toBe(0);
      expect(graph.hasNodeInFile("/repo/src/foo.ts")).toBe(false);
    } finally {
      graph.close();
    }
  });

  it("finds node ids by exact symbol suffix (for gold reconciliation)", () => {
    const directory = mkdtempSync(join(tmpdir(), "lacoco-graph-reader-suffix-"));
    const path = join(directory, "tensor.sqlite");
    const database = new Database(path);
    database.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY, filepath TEXT)");
    const insert = database.prepare("INSERT INTO nodes (id, filepath) VALUES (?, ?)");
    // el gold apunta a SimpleSelect.js; el grafo lo tiene en SimpleSelect.tsx
    insert.run("/repo/docs/SimpleSelect.tsx#SimpleSelect", "/repo/docs/SimpleSelect.tsx");
    insert.run("/repo/docs/Other.tsx#SimpleSelectHelper", "/repo/docs/Other.tsx"); // NO debe casar
    insert.run("/repo/lib/util.tsx#Foo.bar", "/repo/lib/util.tsx"); // Class.method
    // `_` en el símbolo no debe actuar de comodín de LIKE
    insert.run("/repo/lib/x.tsx#my_func", "/repo/lib/x.tsx");
    insert.run("/repo/lib/y.tsx#myXfunc", "/repo/lib/y.tsx");
    database.close();

    const graph = openGraphLookup(path);
    try {
      // sufijo exacto: SimpleSelect, no SimpleSelectHelper
      expect(graph.nodeIdsBySymbolSuffix("SimpleSelect")).toEqual([
        { id: "/repo/docs/SimpleSelect.tsx#SimpleSelect", filepath: "/repo/docs/SimpleSelect.tsx" },
      ]);
      // Class.method: el id lleva el sufijo completo
      expect(graph.nodeIdsBySymbolSuffix("Foo.bar")).toEqual([
        { id: "/repo/lib/util.tsx#Foo.bar", filepath: "/repo/lib/util.tsx" },
      ]);
      // `_` es literal, no comodín → my_func no debe casar con myXfunc
      expect(graph.nodeIdsBySymbolSuffix("my_func")).toEqual([
        { id: "/repo/lib/x.tsx#my_func", filepath: "/repo/lib/x.tsx" },
      ]);
      // símbolo inexistente
      expect(graph.nodeIdsBySymbolSuffix("Nope")).toEqual([]);
    } finally {
      graph.close();
    }
  });
});
