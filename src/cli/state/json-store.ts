import fs from "node:fs";
import path from "node:path";

export class JsonStoreError extends Error {}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  if (!fs.existsSync(filePath)) return fallback;

  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8")) as T;
  } catch (err) {
    throw new JsonStoreError(
      `Archivo JSON corrupto: ${filePath}. ${err instanceof Error ? err.message : String(err)}`
    );
  }
}

export function writeJsonFileAtomic(filePath: string, value: unknown): void {
  writeTextFileAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`, 0o600);
}

export function writeTextFileAtomic(filePath: string, value: string, mode = 0o600): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const tempPath = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );

  fs.writeFileSync(tempPath, value, {
    encoding: "utf-8",
    mode,
  });
  fs.renameSync(tempPath, filePath);
}

export function pathExists(filePath: string): boolean {
  return fs.existsSync(filePath);
}
