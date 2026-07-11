import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import { repoNameFromSlug, deriveSourceRoots, loadEasyInstances } from "./import-swe-polybench.js";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function writeDataFile(rows: Record<string, unknown>[]): string {
  const dir = mkdtempSync(join(tmpdir(), "lacoco-datafile-"));
  tempDirs.push(dir);
  const path = join(dir, "instances.jsonl");
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return path;
}

function row(id: string, repo: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    instance_id: id, repo, base_commit: "a".repeat(40), problem_statement: "issue",
    modified_nodes: "[]", changed_files: ["src/x.ts"], is_func_only: true, num_nodes: 1,
    is_no_nodes: false, F2P: "[]", test_command: "npm test", patch: "diff", test_patch: "",
    ...extra,
  };
}

describe("repoNameFromSlug", () => {
  it("toma el nombre corto del slug owner/name", () => {
    expect(repoNameFromSlug("mui/material-ui")).toBe("material-ui");
    expect(repoNameFromSlug("prettier/prettier")).toBe("prettier");
    expect(repoNameFromSlug("sveltejs/svelte")).toBe("svelte");
  });
});

describe("deriveSourceRoots", () => {
  it("single-tree: usa 'src' cuando los cambios viven bajo src/", () => {
    expect(deriveSourceRoots(["src/validate/index.js", "src/compile/nodes/Foo.ts"])).toEqual(["src"]);
  });

  it("monorepo: escopa a packages/<pkg>/src del paquete tocado", () => {
    expect(deriveSourceRoots(["packages/material/src/Foo.js", "packages/material/src/Bar.js"]))
      .toEqual(["packages/material/src"]);
  });

  it("monorepo multi-paquete: incluye cada src tocado (ordenado)", () => {
    expect(deriveSourceRoots(["packages/b/src/X.ts", "packages/a/src/Y.ts"]))
      .toEqual(["packages/a/src", "packages/b/src"]);
  });

  it("sin segmento src: usa el primer dir (p. ej. lib en serverless)", () => {
    expect(deriveSourceRoots(["lib/plugins/aws/foo.js"])).toEqual(["lib"]);
  });

  it("excluye archivos de test al derivar las raíces", () => {
    expect(deriveSourceRoots(["src/Foo.ts", "test/Foo.test.ts", "__tests__/bar.js"])).toEqual(["src"]);
  });

  it("fallback a ['src'] si no hay changed_files utilizables", () => {
    expect(deriveSourceRoots(null)).toEqual(["src"]);
    expect(deriveSourceRoots([])).toEqual(["src"]);
    expect(deriveSourceRoots(["README.md"])).toEqual(["src"]); // archivo raíz sin dir
  });
});

describe("loadEasyInstances --data-file", () => {
  it("lee las instancias del data-file dado (no del DATA_FILE por defecto)", () => {
    const dataFile = writeDataFile([
      row("owner__repo-1", "owner/repo"),
      row("owner__repo-2", "owner/repo"),
      row("other__x-1", "other/x"),
    ]);
    const got = loadEasyInstances("owner/repo", 10, false, false, dataFile);
    expect(got.map((i) => i.instance_id)).toEqual(["owner__repo-1", "owner__repo-2"]);
  });

  it("respeta el filtro single-hop (is_func_only && num_nodes==1) y el limit", () => {
    const dataFile = writeDataFile([
      row("r-1", "owner/repo"),
      row("r-2", "owner/repo", { num_nodes: 3, is_func_only: false, is_mixed: true }), // multi-hop
      row("r-3", "owner/repo"),
    ]);
    // single-hop por defecto: excluye la multi-hop; limit=1 corta al primero
    expect(loadEasyInstances("owner/repo", 1, false, false, dataFile).map((i) => i.instance_id))
      .toEqual(["r-1"]);
    // --only-mixed: solo la multi-hop (num_nodes 2-4)
    expect(loadEasyInstances("owner/repo", 10, true, true, dataFile).map((i) => i.instance_id))
      .toEqual(["r-2"]);
  });
});
