import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyBrokenPatch,
  parseTestRunnerOutput,
  prepareGitRepository,
  prepareMirror,
  resetRepoClean,
  slugForUrl,
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

describe("slugForUrl", () => {
  it("derives a flat slug from an https url and strips .git", () => {
    expect(slugForUrl("https://github.com/sveltejs/svelte.git")).toBe(
      "github.com__sveltejs__svelte",
    );
  });

  it("handles ssh urls", () => {
    expect(slugForUrl("git@github.com:mui/material-ui.git")).toBe(
      "github.com__mui__material-ui",
    );
  });

  it("is stable for the same url regardless of trailing whitespace", () => {
    expect(slugForUrl("  https://github.com/coder/code-server  ")).toBe(
      "github.com__coder__code-server",
    );
  });
});

describe("prepareMirror + prepareGitRepository --reference", () => {
  function makeBareLogs(): string {
    const dir = mkdtempSync(join(tmpdir(), "lacoco-mirror-"));
    temporaryDirectories.push(dir);
    return dir;
  }

  it("shares objects via alternates and keeps .git a directory", async () => {
    const source = makeRepo();
    const sourceHead = execSync("git rev-parse HEAD", { cwd: source }).toString().trim();
    const workRoot = makeBareLogs();
    const mirrorPath = join(workRoot, "mirror.git");
    const logsDirectory = join(workRoot, "logs");
    mkdirSync(logsDirectory, { recursive: true });

    await prepareMirror({
      url: source,
      mirrorPath,
      logsDirectory,
      timeoutMs: 30_000,
      fetchTags: false,
    });

    // Mirror is a bare repository.
    expect(existsSync(join(mirrorPath, "HEAD"))).toBe(true);
    expect(
      execSync("git rev-parse --is-bare-repository", { cwd: mirrorPath }).toString().trim(),
    ).toBe("true");

    // Idempotent: a second call updates instead of re-cloning (must not throw).
    await prepareMirror({
      url: source,
      mirrorPath,
      logsDirectory,
      timeoutMs: 30_000,
      fetchTags: false,
    });

    const repoPath = join(workRoot, "checkout");
    const commit = await prepareGitRepository({
      url: source,
      ref: sourceHead,
      repoPath,
      logsDirectory,
      timeoutMs: 30_000,
      fetchTags: false,
      mirrorPath,
    });

    expect(commit).toBe(sourceHead);
    // `.git` must be a DIRECTORY (not a worktree file) so generation log paths work.
    expect(statSync(join(repoPath, ".git")).isDirectory()).toBe(true);
    // Objects are shared via the alternates pointer into the mirror.
    const alternates = join(repoPath, ".git", "objects", "info", "alternates");
    expect(existsSync(alternates)).toBe(true);
    expect(readFileSync(alternates, "utf8")).toContain(mirrorPath);
  });

  it("clones without --reference when no mirror is given", async () => {
    const source = makeRepo();
    const sourceHead = execSync("git rev-parse HEAD", { cwd: source }).toString().trim();
    const workRoot = makeBareLogs();
    const logsDirectory = join(workRoot, "logs");
    mkdirSync(logsDirectory, { recursive: true });
    const repoPath = join(workRoot, "checkout");

    const commit = await prepareGitRepository({
      url: source,
      ref: sourceHead,
      repoPath,
      logsDirectory,
      timeoutMs: 30_000,
      fetchTags: false,
    });

    expect(commit).toBe(sourceHead);
    expect(existsSync(join(repoPath, ".git", "objects", "info", "alternates"))).toBe(false);
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
