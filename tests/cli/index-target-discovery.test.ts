import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverTsconfigs, resolveIndexTarget } from "../../src/indexer/tsconfig-discovery.js";

describe("index target discovery", () => {
  it("descubre tsconfigs utiles en repositorios multi-servicio e ignora artefactos", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lacoco-discovery-"));
    try {
      touch(path.join(tempDir, "api-gateway", "tsconfig.json"));
      touch(path.join(tempDir, "api-gateway", "tsconfig.build.json"));
      touch(path.join(tempDir, "frontend", "tsconfig.app.json"));
      touch(path.join(tempDir, "usuarios", "pom.xml"));
      touch(path.join(tempDir, "node_modules", "dep", "tsconfig.json"));
      touch(path.join(tempDir, "dist", "tsconfig.json"));

      const discovered = discoverTsconfigs(tempDir).map((filePath) => path.relative(tempDir, filePath));

      expect(discovered).toEqual([
        path.join("api-gateway", "tsconfig.json"),
        path.join("frontend", "tsconfig.app.json"),
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("mantiene compatibilidad con la ruta directa a un tsconfig", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lacoco-target-"));
    try {
      const tsconfigPath = path.join(tempDir, "service", "tsconfig.json");
      touch(tsconfigPath);

      const target = resolveIndexTarget(tsconfigPath);

      expect(target.kind).toBe("tsconfig");
      expect(target.projectPath).toBe(path.dirname(tsconfigPath));
      expect(target.tsconfigPaths).toEqual([tsconfigPath]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function touch(filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "{}", "utf-8");
}
