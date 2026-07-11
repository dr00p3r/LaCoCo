import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBrokenPatch,
  captureWorkingTreeDiff,
  parseTestRunnerOutput,
  resetRepoClean,
  verifyBrokenState,
} from "./git.js";

const temporaryDirectories: string[] = [];

function makeRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), "lacoco-git-"));
  temporaryDirectories.push(directory);
  execSync("git init -q -b main", { cwd: directory });
  execSync("git config user.email t@t.local", { cwd: directory });
  execSync("git config user.name t", { cwd: directory });
  writeFileSync(join(directory, "hello.txt"), "hello\n");
  execSync("git add hello.txt", { cwd: directory });
  execSync("git commit -q -m initial", { cwd: directory });
  return directory;
}

function makePatch(diff: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "lacoco-patch-")), "broken.diff");
  writeFileSync(file, diff, "utf8");
  return file;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resetRepoClean with excludes", () => {
  it("preserves node_modules when excluded", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "x");
    writeFileSync(join(repo, "scratch.txt"), "y");

    await resetRepoClean({ repoPath: repo, timeoutMs: 10_000, excludes: ["node_modules"] });

    expect(existsSync(join(repo, "node_modules", "pkg", "index.js"))).toBe(true);
    expect(existsSync(join(repo, "scratch.txt"))).toBe(false);
  });

  it("removes node_modules when no excludes given", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "pkg", "index.js"), "x");

    await resetRepoClean({ repoPath: repo, timeoutMs: 10_000 });

    expect(existsSync(join(repo, "node_modules", "pkg", "index.js"))).toBe(false);
  });

  it("preserves multiple excludes", async () => {
    const repo = makeRepo();
    mkdirSync(join(repo, "node_modules", "a"), { recursive: true });
    mkdirSync(join(repo, ".pnpm", "b"), { recursive: true });
    writeFileSync(join(repo, "node_modules", "a", "x"), "1");
    writeFileSync(join(repo, ".pnpm", "b", "y"), "2");

    await resetRepoClean({
      repoPath: repo,
      timeoutMs: 10_000,
      excludes: ["node_modules", ".pnpm"],
    });

    expect(existsSync(join(repo, "node_modules", "a", "x"))).toBe(true);
    expect(existsSync(join(repo, ".pnpm", "b", "y"))).toBe(true);
  });
});

describe("captureWorkingTreeDiff", () => {
  it("can exclude generated lockfiles from captured patches", async () => {
    const repo = makeRepo();
    writeFileSync(join(repo, "hello.txt"), "changed\n");
    writeFileSync(join(repo, "package-lock.json"), "{}\n");

    const diff = await captureWorkingTreeDiff({
      repoPath: repo,
      timeoutMs: 10_000,
      excludePatchPaths: ["package-lock.json"],
    });

    expect(diff).toContain("diff --git a/hello.txt b/hello.txt");
    expect(diff).not.toContain("package-lock.json");
  });
});

describe("applyBrokenPatch", () => {
  it("applies a valid patch", async () => {
    const repo = makeRepo();
    const patch = makePatch([
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+goodbye",
      "",
    ].join("\n"));
    await applyBrokenPatch({ repoPath: repo, brokenPatchPath: patch, timeoutMs: 10_000 });
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe("goodbye\n");
  });

  it("rejects a malformed patch via BrokenPatchApplyError", async () => {
    const repo = makeRepo();
    const patch = makePatch("this is not a diff\n");
    await expect(
      applyBrokenPatch({ repoPath: repo, brokenPatchPath: patch, timeoutMs: 10_000 }),
    ).rejects.toThrow(/git apply --check failed/);
  });
});

describe("parseTestRunnerOutput", () => {
  it("parses vitest output", () => {
    const stdout = [
      " RUN  v2.1.9 /tmp/zod",
      " × src/foo.test.ts > suite > trim 12ms",
      " ✓ src/foo.test.ts > suite > lowerCase 3ms",
      " Test Files  1 failed | 1 passed (2)",
      "      Tests  1 failed | 1 passed (2 total)",
    ].join("\n");
    const parsed = parseTestRunnerOutput(stdout, "");
    expect(parsed.failed.has("src/foo.test.ts > suite > trim")).toBe(true);
    expect(parsed.passed.has("src/foo.test.ts > suite > lowerCase")).toBe(true);
    expect(parsed.totalFailed).toBe(1);
    expect(parsed.totalPassed).toBe(1);
    expect(parsed.unknownRunner).toBe(false);
  });

  it("parses jest output", () => {
    const stdout = [
      "FAIL src/foo.spec.ts",
      "  ✕ should work",
      "  ✓ should pass",
      "Tests:  1 failed, 1 passed, 2 total",
    ].join("\n");
    const parsed = parseTestRunnerOutput(stdout, "");
    expect(parsed.failed.has("should work")).toBe(true);
    expect(parsed.passed.has("should pass")).toBe(true);
    expect(parsed.totalFailed).toBe(1);
    expect(parsed.totalPassed).toBe(1);
  });

  it("parses mocha output", () => {
    const stdout = [
      "  1) mergeMap",
      "       should map:",
      "  2) mergeMap",
      "       should flatMap:",
      "  2 passing",
      "  2 failing",
    ].join("\n");
    const parsed = parseTestRunnerOutput(stdout, "");
    expect(parsed.failed.has("mergeMap › should map")).toBe(true);
    expect(parsed.totalFailed).toBe(2);
    expect(parsed.totalPassed).toBe(2);
  });

  it("flags unknown runners", () => {
    const parsed = parseTestRunnerOutput("no markers here", "");
    expect(parsed.unknownRunner).toBe(true);
  });
});

describe("verifyBrokenState", () => {
  it("returns the failing set from a failing test command", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "lacoco-vblog-"));
    temporaryDirectories.push(logDir);
    const logPath = join(logDir, "verify.log");
    const report = await verifyBrokenState({
      repoPath: mkdtempSync(join(tmpdir(), "lacoco-dummy-")),
      testCommand: "printf 'Tests  3 failed | 7 passed (10 total)'; exit 1",
      timeoutMs: 10_000,
      expectedGradingTests: [],
      logPath,
    });
    expect(report.exitCode).toBe(1);
    expect(report.parsed.totalFailed).toBe(3);
    expect(report.gradingTestsFailing).toEqual([]);
    expect(report.gradingTestsMissing).toEqual([]);
  });

  it("flags grading tests that did not appear in the failing set", async () => {
    const logDir = mkdtempSync(join(tmpdir(), "lacoco-vblog-"));
    temporaryDirectories.push(logDir);
    const logPath = join(logDir, "verify.log");
    const report = await verifyBrokenState({
      repoPath: mkdtempSync(join(tmpdir(), "lacoco-dummy-")),
      testCommand: "true",
      timeoutMs: 10_000,
      expectedGradingTests: ["missing test"],
      logPath,
    });
    expect(report.gradingTestsMissing).toEqual(["missing test"]);
  });
});
