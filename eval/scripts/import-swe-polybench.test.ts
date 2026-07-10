import { describe, it, expect } from "vitest";
import { repoNameFromSlug, deriveSourceRoots } from "./import-swe-polybench.js";

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
