import { cpSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadManifests, ManifestValidationError } from "./load-manifests.js";
import { MANIFESTS_DIR } from "./paths.js";

describe("loadManifests", () => {
  it("loads and validates every evaluation manifest", () => {
    const manifests = loadManifests();

    expect(manifests.repos.kind).toBe("repositories");
    expect(manifests.strategies.strategies.length).toBeGreaterThan(0);
    expect(manifests.agents.agents.length).toBeGreaterThan(0);
    expect(manifests.metrics.metrics.length).toBeGreaterThan(0);
    expect(manifests.run.kind).toBe("run_configuration");
    expect(manifests.tasks.tasks.length).toBeGreaterThan(0);
    expect(manifests.tasks.tasks[0]?.gold.relevant_nodes).toEqual([]);
    expect(manifests.tasks.tasks[0]?.gold.multihop_nodes).toEqual([]);
  });

  it("reports the file and field when a required value is missing", () => {
    const directory = mkdtempSync(join(tmpdir(), "lacoco-manifests-"));
    cpSync(MANIFESTS_DIR, directory, { recursive: true });
    const tasksPath = join(directory, "tasks.yaml");
    const tasks = readFileSync(tasksPath, "utf8").replace(/^    prompt:/m, "    missing_prompt:");
    writeFileSync(tasksPath, tasks);

    expect(() => loadManifests(directory)).toThrowError(
      new ManifestValidationError("tasks.yaml", "tasks[0].prompt must be a non-empty string"),
    );
  });

  it("rejects strategy parameters that drift from runtime defaults", () => {
    const directory = mkdtempSync(join(tmpdir(), "lacoco-manifests-"));
    cpSync(MANIFESTS_DIR, directory, { recursive: true });
    const strategiesPath = join(directory, "strategies.yaml");
    const strategies = readFileSync(strategiesPath, "utf8").replace(
      "      primary_hops: 2",
      "      primary_hops: 1",
    );
    writeFileSync(strategiesPath, strategies);

    expect(() => loadManifests(directory)).toThrow(/parameters does not match runtime defaults/);
  });
});
