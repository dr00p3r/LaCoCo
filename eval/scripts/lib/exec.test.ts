import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandExecutionError, executeCommand } from "./exec.js";

describe("executeCommand", () => {
  it("records command failures with output and timing metadata", async () => {
    const directory = mkdtempSync(join(tmpdir(), "lacoco-exec-"));
    const logPath = join(directory, "failure.log");
    const error = await executeCommand({
      command: "printf out; printf err >&2; exit 3",
      cwd: directory,
      timeoutMs: 5_000,
      logPath,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CommandExecutionError);
    const result = (error as CommandExecutionError).result;
    expect(result.exitCode).toBe(3);
    expect(result.stdout).toBe("out");
    expect(result.stderr).toBe("err");
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.logPath).toBe(logPath);
    expect(readFileSync(logPath, "utf8")).toContain("exitCode: 3");
  });
});
