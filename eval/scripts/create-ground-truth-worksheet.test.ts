import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGroundTruthWorksheets } from "./create-ground-truth-worksheet.js";

describe("createGroundTruthWorksheets", () => {
  it("writes a selected task worksheet from structured retrieval JSONL", () => {
    const runDirectory = mkdtempSync(join(tmpdir(), "lacoco-gold-worksheet-"));
    const record = {
      schema_version: 1,
      run_id: "fixture",
      task_id: "zod-001",
      repo_id: "zod",
      strategy_id: "hybrid",
      ranked_nodes: [{
        rank: 1,
        node_id: "src/foo.ts#Foo",
        score: 0.9,
        source: "hybrid",
        text: "class Foo {}",
      }],
      timings_ms: { total: 10 },
      exit_code: 0,
    };
    writeFileSync(join(runDirectory, "retrieval.jsonl"), `${JSON.stringify(record)}\n`, "utf8");

    createGroundTruthWorksheets(["--run-dir", runDirectory, "--task-id", "zod-001"]);

    const worksheetPath = join(runDirectory, "gold-worksheets", "zod-001.md");
    expect(existsSync(worksheetPath)).toBe(true);
    expect(readFileSync(worksheetPath, "utf8")).toContain("src/foo.ts#Foo");
  });
});
