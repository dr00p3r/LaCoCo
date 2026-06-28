import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { asRecord, asString } from "./config.js";
import type { RepositoryDefinition, RepositoriesManifest } from "./types.js";

export interface ResolveTsconfigOptions {
  repository: RepositoryDefinition;
  repositoriesManifest: RepositoriesManifest;
  repoPath: string;
  dryRun: boolean;
}

export interface ResolvedTsconfig {
  path: string;
  generated: boolean;
}

function shouldGenerate(manifest: RepositoriesManifest): { enabled: boolean; fileName: string } {
  const defaults = asRecord(manifest.defaults, "repos.yaml.defaults");
  const index = asRecord(defaults.lacoco_index, "repos.yaml.defaults.lacoco_index");
  if (typeof index.generate_eval_tsconfig_when_missing !== "boolean") {
    throw new Error("repos.yaml.defaults.lacoco_index.generate_eval_tsconfig_when_missing must be a boolean");
  }
  return {
    enabled: index.generate_eval_tsconfig_when_missing,
    fileName: asString(index.eval_tsconfig_name, "repos.yaml.defaults.lacoco_index.eval_tsconfig_name"),
  };
}

function generatedConfig(repository: RepositoryDefinition): Record<string, unknown> {
  const languageScope = Array.isArray(repository.language_scope)
    ? repository.language_scope.filter((value): value is string => typeof value === "string")
    : [];
  const includeJavaScript = languageScope.includes("javascript");
  const extensions = includeJavaScript ? ["js", "jsx", "ts", "tsx"] : ["ts", "tsx"];
  const baseInclude = repository.source_roots.flatMap((root) =>
    extensions.map((extension) => `${root}/**/*.${extension}`),
  );
  const overrides = repository.lacoco_tsconfig_overrides === undefined
    ? {}
    : asRecord(repository.lacoco_tsconfig_overrides, `${repository.id}.lacoco_tsconfig_overrides`);
  const overrideCompilerOptions = overrides.compilerOptions === undefined
    ? {}
    : asRecord(overrides.compilerOptions, `${repository.id}.lacoco_tsconfig_overrides.compilerOptions`);

  return {
    compilerOptions: {
      target: "ES2022",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      skipLibCheck: true,
      noEmit: true,
      ...(includeJavaScript ? { allowJs: true, checkJs: false } : {}),
      ...overrideCompilerOptions,
    },
    include: overrides.include ?? baseInclude,
    ...(overrides.exclude === undefined ? {} : { exclude: overrides.exclude }),
  };
}

export function resolveRepositoryTsconfig(options: ResolveTsconfigOptions): ResolvedTsconfig {
  for (const candidate of options.repository.tsconfig_candidates) {
    const candidatePath = resolve(options.repoPath, candidate);
    if (existsSync(candidatePath)) {
      return { path: candidatePath, generated: false };
    }
  }

  const generation = shouldGenerate(options.repositoriesManifest);
  if (!generation.enabled) {
    throw new Error(
      `no tsconfig candidate exists for ${options.repository.id} and generation is disabled`,
    );
  }

  const generatedPath = resolve(options.repoPath, generation.fileName);
  if (!options.dryRun) {
    writeFileSync(generatedPath, `${JSON.stringify(generatedConfig(options.repository), null, 2)}\n`, "utf8");
  }
  return { path: generatedPath, generated: true };
}
