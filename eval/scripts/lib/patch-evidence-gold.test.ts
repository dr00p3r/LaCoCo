import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Project } from "ts-morph";
import {
  deriveEditedSymbolsFromCheckout,
  enrichPatchEvidenceWithDefinitions,
  extractPatchEvidenceTier1,
  parseUnifiedDiff,
  sourceChangesFromPatch,
} from "./patch-evidence-gold.js";

const SINGLE_EDIT_PATCH = `diff --git a/src/math/box.ts b/src/math/box.ts
--- a/src/math/box.ts
+++ b/src/math/box.ts
@@ -10,3 +10,4 @@ export class Box {
   expand() {
-    return this.min;
+    this.recompute();
+    return this.min;
   }
`;

const TEST_PATCH = `diff --git a/test/box.spec.ts b/test/box.spec.ts
--- a/test/box.spec.ts
+++ b/test/box.spec.ts
@@ -1,2 +1,3 @@
 import { Box } from "../src/math/box";
+it("expands", () => {});
`;

describe("parseUnifiedDiff", () => {
  it("extracts changed files and added new-side line numbers", () => {
    const changes = parseUnifiedDiff(SINGLE_EDIT_PATCH);
    expect(changes).toHaveLength(1);
    expect(changes[0]!.path).toBe("src/math/box.ts");
    // hunk empieza en +10; contexto (expand) = 10, add = 11, add = 12, contexto = 13.
    expect(changes[0]!.addedLines).toEqual([11, 12]);
    // lado viejo: la única línea `-` es `return this.min;` (old 11); el contexto se
    // descarta porque el hunk sí tiene líneas eliminadas.
    expect(changes[0]!.oldSideLines).toEqual([11]);
  });

  it("sourceChangesFromPatch drops files that belong to the test patch", () => {
    const combined = `${SINGLE_EDIT_PATCH}${TEST_PATCH}`;
    const src = sourceChangesFromPatch(combined, TEST_PATCH);
    expect(src.map((c) => c.path)).toEqual(["src/math/box.ts"]);
  });
});

describe("extractPatchEvidenceTier1", () => {
  it("derives edited files, symbols, and touched tests", () => {
    const gold = extractPatchEvidenceTier1({
      patch: SINGLE_EDIT_PATCH,
      testPatch: TEST_PATCH,
      modifiedNodes: "['src/math/box.ts->program->class_declaration:Box->method_definition:expand']",
      changedFiles: ["src/math/box.ts"],
    });
    expect(gold.source).toBe("patch");
    expect(gold.edited_files).toContain("src/math/box.ts");
    expect(gold.edited_symbols).toEqual([
      { file: "src/math/box.ts", symbol: "Box.expand", kind: "method" },
    ]);
    expect(gold.touched_tests).toEqual(["test/box.spec.ts"]);
    expect(gold.resolution.fell_back_to_file_level).toBe(false);
  });

  it("falls back to file level when the patch has no mappable node", () => {
    const gold = extractPatchEvidenceTier1({
      patch: SINGLE_EDIT_PATCH,
      modifiedNodes: "[]",
      changedFiles: ["src/math/box.ts"],
    });
    expect(gold.edited_symbols).toEqual([]);
    expect(gold.edited_files).toContain("src/math/box.ts");
    expect(gold.resolution.fell_back_to_file_level).toBe(true);
  });

  it("handles a multi-edit-site patch (union of files and symbols)", () => {
    const multi = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,2 @@
 export function a() {}
+export function extra() {}
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,1 +1,2 @@
 export class B {}
+// touched
`;
    const gold = extractPatchEvidenceTier1({
      patch: multi,
      modifiedNodes: "['src/a.ts->program->function_declaration:a', 'src/b.ts->program->class_declaration:B']",
      changedFiles: ["src/a.ts", "src/b.ts"],
    });
    expect(gold.edited_files.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(gold.edited_symbols).toEqual([
      { file: "src/a.ts", symbol: "a", kind: "function" },
      { file: "src/b.ts", symbol: "B", kind: "class" },
    ]);
  });
});

describe("enrichPatchEvidenceWithDefinitions (Tier 2)", () => {
  it("resolves an introduced call to its internal definition", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("/repo/src/dep.ts", "export function helper(): void {}\n");
    project.createSourceFile(
      "/repo/src/main.ts",
      'import { helper } from "./dep";\nexport function run(): void {\n  helper();\n}\n',
    );

    const base = extractPatchEvidenceTier1({ patch: "", modifiedNodes: "[]", changedFiles: ["src/main.ts"] });
    const enriched = enrichPatchEvidenceWithDefinitions(base, {
      project,
      repoDir: "/repo",
      changes: [{ path: "src/main.ts", addedLines: [3], oldSideLines: [] }], // línea de `helper();`
      resolveSourcePath: (rel) => `/repo/${rel}`,
    });

    expect(enriched.introduced_refs).toContainEqual({ file: "src/main.ts", symbol: "helper", kind: "function" });
    expect(enriched.resolved_definitions).toContainEqual({
      file: "src/dep.ts",
      symbol: "helper",
      kind: "function",
    });
    expect(enriched.resolution.unresolved_refs).toEqual([]);
  });

  it("records unresolved refs for external symbols", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile(
      "/repo/src/main.ts",
      "export function run(): void {\n  console.log(missingGlobal());\n}\n",
    );
    const base = extractPatchEvidenceTier1({ patch: "", modifiedNodes: "[]", changedFiles: ["src/main.ts"] });
    const enriched = enrichPatchEvidenceWithDefinitions(base, {
      project,
      repoDir: "/repo",
      changes: [{ path: "src/main.ts", addedLines: [2], oldSideLines: [] }],
      resolveSourcePath: (rel) => `/repo/${rel}`,
    });
    // `missingGlobal` no tiene definición interna → unresolved.
    expect(enriched.resolution.unresolved_refs).toContain("missingGlobal");
    expect(enriched.resolved_definitions).toEqual([]);
  });
});

describe("deriveEditedSymbolsFromCheckout", () => {
  // Árbol BASE (pre-fix): el pipeline indexa este estado, así que el gold-símbolo
  // se resuelve mapeando las líneas del lado VIEJO del diff contra este árbol.
  const BASE_MAIN = `export function alpha(): number {
  return 1;
}

export class Widget {
  render(): string {
    return "old";
  }
}
`;

  // Modifica alpha (línea vieja 2) y Widget.render (línea vieja 7), y AÑADE un
  // archivo nuevo entero (pura adición → sin símbolo base → file-level).
  const FIX_PATCH = `diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -1,3 +1,3 @@
 export function alpha(): number {
-  return 1;
+  return 2;
 }
@@ -5,5 +5,5 @@ export class Widget {
 export class Widget {
   render(): string {
-    return "old";
+    return "new";
   }
 }
diff --git a/src/added.ts b/src/added.ts
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,1 @@
+export function brandNew(): void {}
`;

  it("maps old-side lines to the enclosing symbol in the base tree", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("/repo/src/main.ts", BASE_MAIN);

    const changes = sourceChangesFromPatch(FIX_PATCH);
    const symbols = deriveEditedSymbolsFromCheckout(changes, project, "/repo", (rel) => `/repo/${rel}`);

    expect(symbols).toContainEqual({ file: "src/main.ts", symbol: "alpha", kind: "function" });
    expect(symbols).toContainEqual({ file: "src/main.ts", symbol: "Widget.render", kind: "method" });
    // La adición pura (archivo nuevo) no aporta símbolo: cae a file-level.
    expect(symbols.map((s) => s.symbol).sort()).toEqual(["Widget.render", "alpha"]);
  });

  it("returns no symbols for a pure-addition patch (file-level fallback)", () => {
    const project = new Project({ useInMemoryFileSystem: true });
    project.createSourceFile("/repo/src/main.ts", BASE_MAIN);

    const pureAdd = `diff --git a/src/main.ts b/src/main.ts
--- a/src/main.ts
+++ b/src/main.ts
@@ -10,0 +11,3 @@
+export function tacked(): void {
+  return;
+}
`;
    const changes = sourceChangesFromPatch(pureAdd);
    const symbols = deriveEditedSymbolsFromCheckout(changes, project, "/repo", (rel) => `/repo/${rel}`);
    expect(symbols).toEqual([]);
  });
});

describe("independence invariant", () => {
  it("does not import from src/graph", () => {
    const source = readFileSync(fileURLToPath(new URL("./patch-evidence-gold.ts", import.meta.url)), "utf8");
    // El extractor de gold debe resolver símbolos con ts-morph directo, nunca a
    // través del módulo de grafo de LaCoCo (evita circularidad hermana). Se
    // inspeccionan solo las sentencias import/require, no los comentarios.
    const importLines = source
      .split("\n")
      .filter((line) => /^\s*(import|export)\b.*\bfrom\b/.test(line) || /\brequire\s*\(/.test(line));
    for (const line of importLines) {
      expect(line).not.toMatch(/graph/);
    }
  });
});
