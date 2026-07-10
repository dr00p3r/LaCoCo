import fs from "node:fs";
import path from "node:path";

export interface IndexTarget {
  inputPath: string;
  projectPath: string;
  tsconfigPaths: string[];
  kind: "tsconfig" | "directory";
}

const IGNORED_DIRECTORIES = new Set([
  ".angular",
  ".git",
  ".lacoco",
  ".next",
  ".nuxt",
  ".output",
  ".svelte-kit",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
]);

const IGNORED_TSCONFIG_NAMES = new Set([
  "tsconfig.build.json",
  "tsconfig.e2e.json",
  "tsconfig.spec.json",
  "tsconfig.test.json",
]);

export function resolveIndexTarget(inputPath: string): IndexTarget {
  const resolvedInput = path.resolve(inputPath);
  if (!fs.existsSync(resolvedInput)) {
    throw new Error(`La ruta de indexación no existe: ${resolvedInput}`);
  }

  const stat = fs.statSync(resolvedInput);
  if (stat.isFile()) {
    if (!isTsconfigCandidate(path.basename(resolvedInput))) {
      throw new Error(`La ruta de indexación debe ser un tsconfig*.json o un directorio: ${resolvedInput}`);
    }
    return {
      inputPath: resolvedInput,
      projectPath: path.dirname(resolvedInput),
      tsconfigPaths: [resolvedInput],
      kind: "tsconfig",
    };
  }

  if (!stat.isDirectory()) {
    throw new Error(`La ruta de indexación no es archivo ni directorio: ${resolvedInput}`);
  }

  const tsconfigPaths = discoverTsconfigs(resolvedInput);
  if (tsconfigPaths.length === 0) {
    throw new Error(`No se encontraron proyectos JavaScript/TypeScript indexables bajo: ${resolvedInput}`);
  }

  return {
    inputPath: resolvedInput,
    projectPath: resolvedInput,
    tsconfigPaths,
    kind: "directory",
  };
}

export function discoverTsconfigs(rootPath: string): string[] {
  const root = path.resolve(rootPath);
  const candidates: string[] = [];
  walk(root, candidates);
  return candidates.sort((left, right) => left.localeCompare(right));
}

function walk(directory: string, candidates: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name)) walk(entryPath, candidates);
      continue;
    }

    if (entry.isFile() && isTsconfigCandidate(entry.name)) {
      candidates.push(entryPath);
    }
  }
}

function isTsconfigCandidate(filename: string): boolean {
  const lower = filename.toLowerCase();
  return (
    lower.startsWith("tsconfig") &&
    lower.endsWith(".json") &&
    !IGNORED_TSCONFIG_NAMES.has(lower)
  );
}
