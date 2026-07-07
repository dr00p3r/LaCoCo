import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyBrokenPatch, resetRepoClean } from "./lib/git.js";
import { upsertLockedRepository, writeRepositoriesLock, createRepositoriesLock, type LockedRepository } from "./lib/repo-lock.js";

const temporaryDirectories: string[] = [];

function makeRepo(): string {
  const directory = mkdtempSync(join(tmpdir(), "lacoco-prep-"));
  temporaryDirectories.push(directory);
  execSync("git init -q -b main", { cwd: directory });
  execSync("git config user.email t@t.local", { cwd: directory });
  execSync("git config user.name t", { cwd: directory });
  writeFileSync(join(directory, "hello.txt"), "hello\n");
  execSync("git add hello.txt", { cwd: directory });
  execSync("git commit -q -m initial", { cwd: directory });
  return directory;
}

afterEach(() => {
  for (const dir of temporaryDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("repos.lock.json round-trip with regression_tasks", () => {
  it("persists regression_tasks and reads them back", () => {
    const lockDir = mkdtempSync(join(tmpdir(), "lacoco-lock-"));
    temporaryDirectories.push(lockDir);
    const lockPath = join(lockDir, "repos.lock.json");
    const lock = createRepositoriesLock("test-run");
    const locked: LockedRepository = {
      id: "zod",
      url: "https://example.com/zod",
      requestedRef: "v3.25.76",
      commit: "7baee4e17f86f4017e09e12b0acdee36a5b1c087",
      repoPath: "/tmp/zod",
      preparedAt: new Date().toISOString(),
      steps: { checkout: "passed", install: "passed", build: "passed", test: "passed" },
      reset_excludes: ["node_modules", ".pnpm"],
      regression_tasks: [
        {
          id: "zod-001",
          base_commit: "7baee4e17f86f4017e09e12b0acdee36a5b1c087",
          broken_patch: "regression/zod-001.broken.diff",
          grading_tests: ["trim"],
          baseline_failing_tests: ["trim"],
          regression_verified_at: new Date().toISOString(),
        },
      ],
    };
    upsertLockedRepository(lock, locked);
    writeRepositoriesLock(lockPath, lock);

    const raw = readFileSync(lockPath, "utf8");
    expect(raw).toContain("regression_tasks");
    expect(raw).toContain("baseline_failing_tests");
    expect(raw).toContain("reset_excludes");
    expect(raw).toContain("node_modules");
  });
});

describe("regression apply/reset round-trip", () => {
  it("leaves the worktree in a deterministic state after apply+reset", async () => {
    const repo = makeRepo();
    const patch = join(mkdtempSync(join(tmpdir(), "lacoco-patch-")), "broken.diff");
    writeFileSync(patch, [
      "diff --git a/hello.txt b/hello.txt",
      "--- a/hello.txt",
      "+++ b/hello.txt",
      "@@ -1 +1 @@",
      "-hello",
      "+goodbye",
      "",
    ].join("\n"), "utf8");

    await applyBrokenPatch({ repoPath: repo, brokenPatchPath: patch, timeoutMs: 10_000 });
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe("goodbye\n");

    await resetRepoClean({ repoPath: repo, timeoutMs: 10_000 });
    expect(readFileSync(join(repo, "hello.txt"), "utf8")).toBe("hello\n");
  });
});
