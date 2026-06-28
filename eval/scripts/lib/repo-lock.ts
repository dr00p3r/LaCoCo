import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { asRecord, asString } from "./config.js";

export interface LockedRepository {
  id: string;
  url: string;
  requestedRef: string;
  commit: string;
  repoPath: string;
  preparedAt: string;
  steps: Record<string, "passed" | "failed" | "skipped">;
}

export interface RepositoriesLock {
  schemaVersion: 1;
  runId: string;
  updatedAt: string;
  repositories: LockedRepository[];
}

export function createRepositoriesLock(runId: string): RepositoriesLock {
  return {
    schemaVersion: 1,
    runId,
    updatedAt: new Date().toISOString(),
    repositories: [],
  };
}

export function upsertLockedRepository(
  lock: RepositoriesLock,
  repository: LockedRepository,
): void {
  const index = lock.repositories.findIndex(({ id }) => id === repository.id);
  if (index === -1) {
    lock.repositories.push(repository);
  } else {
    lock.repositories[index] = repository;
  }
  lock.updatedAt = new Date().toISOString();
}

export function writeRepositoriesLock(path: string, lock: RepositoriesLock): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
  renameSync(temporaryPath, path);
}

export function readRepositoriesLock(path: string): RepositoriesLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`could not read repositories lock ${path}`, { cause: error });
  }

  const root = asRecord(parsed, "repos.lock.json");
  if (root.schemaVersion !== 1) {
    throw new Error("repos.lock.json.schemaVersion must be 1");
  }
  const repositoriesValue = root.repositories;
  if (!Array.isArray(repositoriesValue)) {
    throw new Error("repos.lock.json.repositories must be an array");
  }
  const repositories = repositoriesValue.map((value, index) => {
    const item = asRecord(value, `repos.lock.json.repositories[${index}]`);
    const stepsValue = asRecord(item.steps, `repos.lock.json.repositories[${index}].steps`);
    const steps: Record<string, "passed" | "failed" | "skipped"> = {};
    for (const [name, status] of Object.entries(stepsValue)) {
      if (status !== "passed" && status !== "failed" && status !== "skipped") {
        throw new Error(`repos.lock.json.repositories[${index}].steps.${name} is invalid`);
      }
      steps[name] = status;
    }
    return {
      id: asString(item.id, `repos.lock.json.repositories[${index}].id`),
      url: asString(item.url, `repos.lock.json.repositories[${index}].url`),
      requestedRef: asString(item.requestedRef, `repos.lock.json.repositories[${index}].requestedRef`),
      commit: asString(item.commit, `repos.lock.json.repositories[${index}].commit`),
      repoPath: asString(item.repoPath, `repos.lock.json.repositories[${index}].repoPath`),
      preparedAt: asString(item.preparedAt, `repos.lock.json.repositories[${index}].preparedAt`),
      steps,
    } satisfies LockedRepository;
  });

  return {
    schemaVersion: 1,
    runId: asString(root.runId, "repos.lock.json.runId"),
    updatedAt: asString(root.updatedAt, "repos.lock.json.updatedAt"),
    repositories,
  };
}
