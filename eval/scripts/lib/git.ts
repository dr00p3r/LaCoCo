import { existsSync } from "node:fs";
import { join } from "node:path";
import { executeCommand, shellQuote, type CommandResult } from "./exec.js";

export interface GitRepositoryOptions {
  url: string;
  ref: string;
  repoPath: string;
  logsDirectory: string;
  timeoutMs: number;
  fetchTags: boolean;
  cleanCommand?: string;
}

async function gitStep(
  options: GitRepositoryOptions,
  name: string,
  command: string,
  cwd: string,
): Promise<CommandResult> {
  return executeCommand({
    command,
    cwd,
    timeoutMs: options.timeoutMs,
    logPath: join(options.logsDirectory, `${name}.log`),
  });
}

export async function prepareGitRepository(options: GitRepositoryOptions): Promise<string> {
  if (!existsSync(options.repoPath)) {
    await gitStep(
      options,
      "clone",
      `git clone ${shellQuote(options.url)} ${shellQuote(options.repoPath)}`,
      join(options.repoPath, ".."),
    );
  } else if (!existsSync(join(options.repoPath, ".git"))) {
    throw new Error(`repository path exists but is not a Git checkout: ${options.repoPath}`);
  } else {
    const tags = options.fetchTags ? " --tags" : "";
    await gitStep(options, "fetch", `git fetch${tags} --force origin`, options.repoPath);
  }

  await gitStep(
    options,
    "checkout",
    `git checkout --detach ${shellQuote(options.ref)}`,
    options.repoPath,
  );

  if (options.cleanCommand !== undefined) {
    await gitStep(options, "clean", options.cleanCommand, options.repoPath);
  }

  const result = await gitStep(options, "resolve-commit", "git rev-parse HEAD", options.repoPath);
  const commit = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(`git rev-parse returned an invalid commit for ${options.repoPath}`);
  }
  return commit;
}
