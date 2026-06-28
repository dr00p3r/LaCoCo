import { readFileSync } from "node:fs";

export interface JsonlEntry<T = unknown> {
  line: number;
  value: T;
}

export function readJsonl(path: string): JsonlEntry[] {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`could not read JSONL file ${path}`, { cause: error });
  }

  const entries: JsonlEntry[] = [];
  for (const [index, rawLine] of contents.split(/\r?\n/u).entries()) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    try {
      entries.push({ line: index + 1, value: JSON.parse(line) as unknown });
    } catch (error) {
      throw new Error(`${path}:${index + 1}: invalid JSON`, { cause: error });
    }
  }
  return entries;
}
