import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJsonFile } from "./json-store.js";

interface WatchLockFile {
  version: 1;
  projectId: string;
  pid: number;
  createdAt: string;
}

export interface WatchLock {
  path: string;
  release(): void;
}

const LOCK_VERSION = 1;

export function acquireWatchLock(projectId: string): WatchLock {
  const filePath = watchLockPath(projectId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  try {
    return createLock(filePath, projectId);
  } catch (err) {
    if (!isAlreadyExistsError(err)) throw err;

    const existing = readJsonFile<WatchLockFile | null>(filePath, null);
    if (existing?.pid && isPidActive(existing.pid)) {
      throw new Error(`Watcher lock activo para ${projectId}: ${filePath} (pid ${existing.pid})`);
    }

    fs.rmSync(filePath, { force: true });
    return createLock(filePath, projectId);
  }
}

export function getWatchLockPath(projectId: string): string {
  return watchLockPath(projectId);
}

function createLock(filePath: string, projectId: string): WatchLock {
  const fd = fs.openSync(filePath, "wx", 0o600);
  const value: WatchLockFile = {
    version: LOCK_VERSION,
    projectId,
    pid: process.pid,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.closeSync(fd);

  return {
    path: filePath,
    release: () => {
      fs.rmSync(filePath, { force: true });
    },
  };
}

function watchLockPath(projectId: string): string {
  return path.join(
    process.env.XDG_STATE_HOME ?? path.join(os.homedir(), ".local", "state"),
    "lacoco",
    "locks",
    `${projectId}.lock`,
  );
}

function isAlreadyExistsError(err: unknown): boolean {
  return err instanceof Error && "code" in err && err.code === "EEXIST";
}

function isPidActive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
