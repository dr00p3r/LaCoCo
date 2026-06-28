import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifests } from "./load-manifests.js";
import { resolveRepositoryTsconfig } from "./tsconfig.js";

describe("resolveRepositoryTsconfig", () => {
  it("plans without writing and generates repository overrides when requested", () => {
    const manifests = loadManifests();
    const repository = manifests.repos.repositories.find(({ id }) => id === "dayjs");
    expect(repository).toBeDefined();
    if (repository === undefined) {
      return;
    }
    const repoPath = mkdtempSync(join(tmpdir(), "lacoco-tsconfig-"));

    const planned = resolveRepositoryTsconfig({
      repository,
      repositoriesManifest: manifests.repos,
      repoPath,
      dryRun: true,
    });
    expect(existsSync(planned.path)).toBe(false);

    const generated = resolveRepositoryTsconfig({
      repository,
      repositoriesManifest: manifests.repos,
      repoPath,
      dryRun: false,
    });
    const contents = JSON.parse(readFileSync(generated.path, "utf8")) as {
      compilerOptions: Record<string, unknown>;
      include: string[];
    };
    expect(generated.generated).toBe(true);
    expect(contents.compilerOptions.allowJs).toBe(true);
    expect(contents.compilerOptions.moduleResolution).toBe("node");
    expect(contents.include).toEqual(["src/**/*.js", "test/**/*.js"]);
  });
});
