import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export interface CommandOptions {
  command: string;
  cwd: string;
  timeoutMs: number;
  logPath: string;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  command: string;
  cwd: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  timeoutMs: number;
  timedOut: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  logPath: string;
}

export class CommandExecutionError extends Error {
  public constructor(public readonly result: CommandResult) {
    const reason = result.timedOut
      ? `timed out after ${result.timeoutMs} ms`
      : `exited with code ${String(result.exitCode)}`;
    super(`command ${reason}: ${result.command} (log: ${result.logPath})`);
    this.name = "CommandExecutionError";
  }
}

function renderLog(result: CommandResult): string {
  return [
    `command: ${result.command}`,
    `cwd: ${result.cwd}`,
    `startedAt: ${result.startedAt}`,
    `finishedAt: ${result.finishedAt}`,
    `durationMs: ${result.durationMs}`,
    `timeoutMs: ${result.timeoutMs}`,
    `timedOut: ${result.timedOut}`,
    `exitCode: ${String(result.exitCode)}`,
    `signal: ${String(result.signal)}`,
    `logPath: ${result.logPath}`,
    "",
    "--- stdout ---",
    result.stdout,
    "",
    "--- stderr ---",
    result.stderr,
    "",
  ].join("\n");
}

function killProcessTree(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }
  try {
    if (process.platform === "win32") {
      process.kill(pid, signal);
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // The process may have exited between the timeout and the signal.
  }
}

export async function executeCommand(options: CommandOptions): Promise<CommandResult> {
  const startedAt = new Date();
  const started = performance.now();
  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const child = spawn(options.command, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    shell: true,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const timeout = setTimeout(() => {
    timedOut = true;
    killProcessTree(child.pid, "SIGTERM");
  }, options.timeoutMs);
  const forceKill = setTimeout(() => {
    if (timedOut) {
      killProcessTree(child.pid, "SIGKILL");
    }
  }, options.timeoutMs + 5_000);

  const completion = await new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolveCompletion) => {
    child.on("error", (error) => {
      stderr += `${stderr.length === 0 ? "" : "\n"}${error.stack ?? error.message}\n`;
    });
    child.on("close", (exitCode, signal) => {
      resolveCompletion({ exitCode, signal });
    });
  });
  clearTimeout(timeout);
  clearTimeout(forceKill);

  const result: CommandResult = {
    command: options.command,
    cwd: options.cwd,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
    timeoutMs: options.timeoutMs,
    timedOut,
    exitCode: completion.exitCode,
    signal: completion.signal,
    stdout,
    stderr,
    logPath: options.logPath,
  };

  mkdirSync(dirname(options.logPath), { recursive: true });
  writeFileSync(options.logPath, renderLog(result), "utf8");

  if (result.timedOut || result.exitCode !== 0) {
    throw new CommandExecutionError(result);
  }
  return result;
}

export function shellQuote(value: string): string {
  if (process.platform === "win32") {
    return `"${value.replaceAll('"', '\\"')}"`;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
