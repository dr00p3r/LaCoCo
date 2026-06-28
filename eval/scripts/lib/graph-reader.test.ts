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
});
