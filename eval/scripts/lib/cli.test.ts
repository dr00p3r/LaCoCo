import { describe, expect, it } from "vitest";
import { parseEvalCliOptions } from "./cli.js";

describe("parseEvalCliOptions", () => {
  it("combines supported evaluation filters", () => {
    expect(parseEvalCliOptions(
      [
        "--repo-id", "zod",
        "--task-id", "zod-001",
        "--strategy-id", "hybrid",
        "--split", "pilot",
        "--run-id", "run",
        "--dry-run",
      ],
      ["--repo-id", "--task-id", "--strategy-id", "--split", "--run-id", "--dry-run"],
    )).toEqual({
      dryRun: true,
      repoId: "zod",
      taskId: "zod-001",
      strategyId: "hybrid",
      split: "pilot",
      runId: "run",
    });
  });

  it("rejects flags that a script does not support", () => {
    expect(() => parseEvalCliOptions(["--task-id", "zod-001"], ["--repo-id"]))
      .toThrow("unknown argument: --task-id");
  });

  it("rejects duplicate filters", () => {
    expect(() => parseEvalCliOptions(
      ["--repo-id", "zod", "--repo-id", "rxjs"],
      ["--repo-id"],
    )).toThrow("duplicate argument: --repo-id");
  });

  it("parses the resume switch", () => {
    expect(parseEvalCliOptions(["--resume"], ["--resume"])).toEqual({
      dryRun: false,
      resume: true,
    });
  });
});
