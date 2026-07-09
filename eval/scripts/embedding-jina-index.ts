/**
 * embedding-jina-index.ts — indexación AISLADA para el experimento de embeddings.
 *
 * Indexa los repos en checkouts aislados (git worktrees en
 * `eval/workdir/repos-jina/{repo}`) hacia un directorio de índices separado
 * (`eval/workdir/indexes-jina/{repo}`), reusando la MISMA generación de tsconfig
 * del harness (`resolveRepositoryTsconfig`) para replicar las condiciones del
 * baseline. No toca `eval/workdir/{repos,indexes}` ni el registry del baseline
 * (el worktree tiene otro repoRoot ⇒ otro ProjectRecord).
 *
 * El MODELO de embeddings se toma de las envs LACOCO_EMBEDDING_* (ver
 * src/embeddings/embedding-config.ts). Ejecutar con las envs jina seteadas:
 *   env LACOCO_EMBEDDING_MODEL=jinaai/jina-embeddings-v2-base-code \
 *       LACOCO_EMBEDDING_DIM=768 LACOCO_EMBEDDING_QUANTIZED=false \
 *     node --import tsx eval/scripts/embedding-jina-index.ts [--repo-id zod]
 *
 * Prerrequisito: los worktrees deben existir (git worktree add ... <commit>) y
 * tener node_modules (symlink al checkout original).
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { asRecord, asString } from "./lib/config.js";
import { loadManifests } from "./lib/load-manifests.js";
import { PROJECT_ROOT, resolveManifestsDir } from "./lib/paths.js";
import { resolveRepositoryTsconfig } from "./lib/tsconfig.js";
import { isEntrypoint } from "./lib/cli.js";
import {
  EMBEDDING_MODEL,
  EMBEDDING_DIM,
  EMBEDDING_QUANTIZED,
} from "../../src/embeddings/embedding-config.js";

const EXPERIMENT_REPOS = ["zod", "rxjs", "inversify"] as const;
const WORKTREE_BASE = resolve(PROJECT_ROOT, "eval/workdir/repos-jina");
const INDEX_BASE = resolve(PROJECT_ROOT, "eval/workdir/indexes-jina");

function fill(template: string, vars: Record<string, string>): string {
  let out = template;
  for (const [key, value] of Object.entries(vars)) out = out.replaceAll(`{${key}}`, value);
  return out;
}

function run(command: string): void {
  console.log(`\n$ ${command}`);
  execSync(command, { cwd: PROJECT_ROOT, stdio: "inherit", env: process.env });
}

export function indexJina(argv = process.argv.slice(2)): void {
  let repoFilter: string | undefined;
  let manifestsDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--repo-id") {
      repoFilter = argv[i + 1];
      i += 1;
    } else if (argv[i] === "--manifests-dir") {
      manifestsDir = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`unknown argument: ${String(argv[i])}`);
    }
  }

  console.log(`Embedding model: ${EMBEDDING_MODEL} (dim ${EMBEDDING_DIM}, quantized ${EMBEDDING_QUANTIZED})`);
  if (EMBEDDING_MODEL === "Xenova/all-MiniLM-L6-v2") {
    throw new Error(
      "LACOCO_EMBEDDING_MODEL apunta al modelo baseline; setea las envs jina antes de indexar el experimento",
    );
  }

  const manifests = loadManifests(resolveManifestsDir(manifestsDir));
  const phases = asRecord(manifests.run.phases, "run.yaml.phases");
  const commands = asRecord(
    asRecord(phases.index_repos, "run.yaml.phases.index_repos").commands,
    "run.yaml.phases.index_repos.commands",
  );
  const initTemplate = asString(commands.init_template, "init_template");
  const graphTemplate = asString(commands.index_graph_template, "index_graph_template");
  const vectorsTemplate = asString(commands.index_vectors_template, "index_vectors_template");

  const repoIds = repoFilter === undefined ? [...EXPERIMENT_REPOS] : [repoFilter];
  for (const repoId of repoIds) {
    const repository = manifests.repos.repositories.find(({ id }) => id === repoId);
    if (repository === undefined) throw new Error(`unknown repo id: ${repoId}`);

    const repoPath = join(WORKTREE_BASE, repoId);
    if (!existsSync(repoPath)) {
      throw new Error(`worktree no existe: ${repoPath} (crea el git worktree primero)`);
    }
    const indexDir = join(INDEX_BASE, repoId);
    mkdirSync(indexDir, { recursive: true });
    const dbPath = join(indexDir, "tensor.sqlite");
    const lancedbPath = join(indexDir, "lancedb");

    // Regenera el tsconfig eval en el worktree con la MISMA lógica del harness.
    const tsconfig = resolveRepositoryTsconfig({
      repository,
      repositoriesManifest: manifests.repos,
      repoPath,
      dryRun: false,
    });

    console.log(`\n=== ${repoId} ===`);
    console.log(`  worktree: ${repoPath}`);
    console.log(`  tsconfig: ${tsconfig.path}${tsconfig.generated ? " (generated)" : ""}`);
    console.log(`  index:    ${indexDir}`);

    run(fill(initTemplate, { repo_path: repoPath }));
    run(fill(graphTemplate, { tsconfig: tsconfig.path, db_path: dbPath }));
    run(fill(vectorsTemplate, { tsconfig: tsconfig.path, lancedb_path: lancedbPath }));
  }

  console.log("\nIndexación jina completa.");
}

if (isEntrypoint(import.meta.url)) {
  try {
    indexJina();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
