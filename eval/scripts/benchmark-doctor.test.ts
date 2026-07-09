import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { runBenchmarkDoctor } from "./benchmark-doctor.js";
import { loadManifests } from "./lib/load-manifests.js";
import { resolveNodeId } from "./lib/node-id.js";
import { getManifestPaths, resolveManifestsDir } from "./lib/paths.js";

function copySweManifests(directory: string, indexesDirectory: string): void {
  mkdirSync(directory, { recursive: true });
  const source = getManifestPaths(resolveManifestsDir("eval/manifests/swe-polybench"));
  const target = getManifestPaths(directory);
  for (const key of Object.keys(source) as Array<keyof typeof source>) {
    let contents = readFileSync(source[key], "utf8");
    if (key === "run") {
      contents = contents.replace(
        'indexes: "eval/workdir/indexes-jina"',
        `indexes: "${indexesDirectory}"`,
      );
    }
    writeFileSync(target[key], contents, "utf8");
  }
}

function writeLock(runDirectory: string, runId: string, repoPath: string): void {
  writeFileSync(
    join(runDirectory, "repos.lock.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      runId,
      updatedAt: "2026-07-08T00:00:00.000Z",
      repositories: [{
        id: "svelte-510",
        url: "https://example.invalid/svelte.git",
        requestedRef: "main",
        commit: "0".repeat(40),
        repoPath,
        preparedAt: "2026-07-08T00:00:00.000Z",
        steps: { checkout: "passed" },
      }],
    }, null, 2)}\n`,
    "utf8",
  );
}

function createGraph(path: string, nodeId: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const database = new Database(path);
  database.exec("CREATE TABLE nodes (id TEXT PRIMARY KEY)");
  database.prepare("INSERT INTO nodes (id) VALUES (?)").run(nodeId);
  database.close();
}

describe("runBenchmarkDoctor", () => {
  it("reports effective manifests, artifacts, and retrieval warnings", () => {
    const root = mkdtempSync(join(tmpdir(), "lacoco-doctor-"));
    const manifestsDirectory = join(root, "manifests");
    const indexesDirectory = join(root, "indexes");
    const runDirectory = join(root, "runs", "doctor-ok");
    const repoPath = join(root, "repos", "svelte-510");
    copySweManifests(manifestsDirectory, indexesDirectory);
    const manifests = loadManifests(manifestsDirectory);
    const task = manifests.tasks.tasks.find(({ id }) => id === "svelte-510");
    if (task === undefined) throw new Error("fixture task not found");
    const goldNode = resolveNodeId(task.gold.relevant_nodes[0]!, repoPath);
    const goldFile = goldNode.slice(0, goldNode.indexOf("#"));
    mkdirSync(resolve(goldFile, ".."), { recursive: true });
    writeFileSync(goldFile, "export default function visitEachBlock() {}\n", "utf8");
    mkdirSync(runDirectory, { recursive: true });
    writeLock(runDirectory, basename(runDirectory), repoPath);
    createGraph(join(indexesDirectory, "svelte-510", "tensor.sqlite"), goldNode);
    mkdirSync(join(indexesDirectory, "svelte-510", "lancedb"), { recursive: true });
    const contextPath = join(runDirectory, "artifacts", "svelte-510", "rpr", "deterministic", "context.json");
    mkdirSync(resolve(contextPath, ".."), { recursive: true });
    writeFileSync(contextPath, "{\"ok\":true}\n", "utf8");
    writeFileSync(
      join(runDirectory, "retrieval.jsonl"),
      `${JSON.stringify({
        schema_version: 1,
        run_id: basename(runDirectory),
        task_id: "svelte-510",
        repo_id: "svelte-510",
        strategy_id: "rpr",
        lacoco_strategy: "rpr",
        query: "See https://svelte.dev/repl\n```diff\n- old\n+ new\n```",
        ranked_nodes: [
          { rank: 1, node_id: "lib#typescript#push" },
          { rank: 2, node_id: "lib#typescript#shift" },
          { rank: 3, node_id: "lib#typescript#test" },
        ],
        classification: { cleanQuery: "https://svelte.dev/repl\n```diff\n+ new\n```" },
        timings_ms: { total: 10 },
        exit_code: 0,
        error: null,
        artifact_paths: { context_json: contextPath },
      })}\n`,
      "utf8",
    );

    const report = runBenchmarkDoctor([
      "--run-dir",
      runDirectory,
      "--manifests-dir",
      manifestsDirectory,
      "--split",
      "retrieval_official",
      "--repo-id",
      "svelte-510",
      "--task-id",
      "svelte-510",
      "--strategy-id",
      "rpr",
    ]);

    expect(report.inputs.manifests_dir).toContain("lacoco-doctor-");
    expect(report.checks.every(({ status }) => status !== "fail")).toBe(true);
    expect(report.selection.expected_cells).toBe(1);
    expect(report.retrieval_analysis.cells[0]?.warnings).toEqual([
      "single_gold_precision_ceiling",
      "no_gold_in_candidates",
      "rpr_external_terminal_nodes",
    ]);
    expect(report.retrieval_analysis.by_strategy[0]?.query_noise).toEqual({
      has_url: 1,
      has_diff_block: 1,
    });
    expect(existsSync(join(runDirectory, "benchmark-doctor.json"))).toBe(true);
    expect(existsSync(join(runDirectory, "benchmark-doctor.md"))).toBe(true);
  });

  it("marks missing lock and indexes as failures", () => {
    const root = mkdtempSync(join(tmpdir(), "lacoco-doctor-missing-"));
    const manifestsDirectory = join(root, "manifests");
    const indexesDirectory = join(root, "indexes");
    const runDirectory = join(root, "runs", "doctor-missing");
    copySweManifests(manifestsDirectory, indexesDirectory);
    mkdirSync(runDirectory, { recursive: true });

    const report = runBenchmarkDoctor([
      "--run-dir",
      runDirectory,
      "--manifests-dir",
      manifestsDirectory,
      "--split",
      "retrieval_official",
      "--repo-id",
      "svelte-510",
      "--task-id",
      "svelte-510",
      "--strategy-id",
      "rpr",
    ]);

    const failures = report.checks.filter(({ status }) => status === "fail").map(({ id }) => id);
    expect(failures).toContain("repos_lock");
    expect(failures).toContain("indexes");
    expect(failures).toContain("retrieval_jsonl");
  });
});
