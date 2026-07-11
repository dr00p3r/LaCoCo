/**
 * Enriquecimiento post-checkout del gold a nivel SÍMBOLO.
 *
 * Los símbolos editados por un fix se resuelven mapeando las líneas del lado VIEJO
 * del diff contra el árbol **base_commit** (pre-fix). Como ese árbol solo existe
 * tras `eval:prepare`, este paso corre DESPUÉS de prepare y ANTES de retrieval:
 * lee el lock del run (`repos.lock.json` → `repoPath` por task), abre el patch
 * sidecar de cada task, corre {@link deriveEditedSymbolsFromCheckout} sobre un
 * `Project` de ts-morph montado en el checkout, y REESCRIBE `tasks.yaml` poniendo
 * `gold.patch_evidence.edited_symbols` (+ `fell_back_to_file_level=false`).
 *
 * Idempotente y estable (depende de `base_commit`). Por defecto solo enriquece
 * tasks cuyo gold aún es file-level (`edited_symbols` vacío) — típicamente los de
 * Multi-SWE-bench; las de SWE-PolyBench ya traen símbolos nativos. `--force`
 * re-deriva todas. Sirve TAMBIÉN a SWE-PolyBench si se quiere gold-símbolo sin
 * depender de `modified_nodes`.
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { Project } from "ts-morph";

import { resolveManifestsDir } from "./lib/paths.js";
import { loadManifests } from "./lib/load-manifests.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { readRepositoriesLock } from "./lib/repo-lock.js";
import { deriveEditedSymbolsFromCheckout, sourceChangesFromPatch } from "./lib/patch-evidence-gold.js";
import { writeTasksManifest } from "./import-swe-polybench.js";
import { isEntrypoint } from "./lib/cli.js";
import type { TaskDefinition } from "./lib/types.js";

interface Options {
  runId: string;
  manifestsDir?: string;
  force: boolean;
}

const TEST_DIR_RE = /(^|\/)(tests?|__tests__|spec|e2e|test)(\/|$)/i;

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = { force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--run-id") {
      if (value === undefined) throw new Error("--run-id requires a value");
      options.runId = value;
      i += 1;
    } else if (arg === "--manifests-dir") {
      if (value === undefined) throw new Error("--manifests-dir requires a value");
      options.manifestsDir = value;
      i += 1;
    } else if (arg === "--force") {
      options.force = true;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  if (options.runId === undefined) throw new Error("--run-id is required (to resolve the checkout for each task)");
  return options as Options;
}

/** Monta un `Project` de ts-morph con los archivos fuente cambiados del checkout base. */
function buildProject(repoPath: string, relPaths: string[]): Project {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
    compilerOptions: { allowJs: true },
  });
  for (const rel of relPaths) {
    const abs = join(repoPath, rel);
    if (existsSync(abs)) {
      try {
        project.addSourceFileAtPath(abs);
      } catch {
        // Archivo no parseable (sintaxis exótica/JSX raro): se omite; su símbolo
        // queda cubierto a nivel archivo por edited_files.
      }
    }
  }
  return project;
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const manifestsDir = resolveManifestsDir(options.manifestsDir);
  if (manifestsDir === undefined) {
    throw new Error("--manifests-dir (o LACOCO_EVAL_MANIFESTS_DIR) es obligatorio: reescribe tasks.yaml de un bundle, no del canónico eval/manifests");
  }
  const manifests = loadManifests(manifestsDir);
  const layout = resolveEvalLayout(manifests.run, options.runId);
  if (!existsSync(layout.lockFile)) {
    throw new Error(`lock not found at ${layout.lockFile}; run eval:prepare for ${options.runId} first`);
  }
  const lock = readRepositoriesLock(layout.lockFile);
  const repoPathById = new Map(lock.repositories.map((r) => [r.id, r.repoPath] as const));

  const tasksPath = join(manifestsDir, "tasks.yaml");
  const doc = parse(readFileSync(tasksPath, "utf8")) as { tasks?: TaskDefinition[] } | null;
  const tasks = doc?.tasks ?? [];
  if (tasks.length === 0) throw new Error(`no tasks in ${tasksPath}`);

  let enriched = 0;
  let skippedHasSymbols = 0;
  let skippedNoRepo = 0;
  let skippedNoPatch = 0;
  let stillFileLevel = 0;

  for (const task of tasks) {
    const evidence = task.gold?.patch_evidence;
    if (evidence === undefined) continue;
    if (!options.force && evidence.edited_symbols.length > 0) {
      skippedHasSymbols += 1;
      continue;
    }
    const repoPath = repoPathById.get(task.repo_id);
    if (repoPath === undefined) {
      skippedNoRepo += 1;
      continue;
    }
    const patchPath = join(manifestsDir, "patches", `${task.id}.patch`);
    const testPatchPath = join(manifestsDir, "patches", `${task.id}.test.patch`);
    if (!existsSync(patchPath)) {
      skippedNoPatch += 1;
      continue;
    }
    const patch = readFileSync(patchPath, "utf8");
    const testPatch = existsSync(testPatchPath) ? readFileSync(testPatchPath, "utf8") : null;

    // Excluye archivos del test_patch y de directorios de test: el gold-símbolo es
    // del código fuente que el fix modifica, no de las pruebas.
    const changes = sourceChangesFromPatch(patch, testPatch).filter((c) => !TEST_DIR_RE.test(c.path));
    const project = buildProject(repoPath, changes.map((c) => c.path));
    const symbols = deriveEditedSymbolsFromCheckout(changes, project, repoPath);

    if (symbols.length > 0) {
      evidence.edited_symbols = symbols;
      evidence.resolution.fell_back_to_file_level = false;
      enriched += 1;
    } else {
      stillFileLevel += 1;
    }
  }

  writeTasksManifest(manifestsDir, tasks);

  console.log(`Enrich gold-símbolo (run ${options.runId}) sobre ${tasks.length} task(s):`);
  console.log(`  ${enriched} enriquecida(s) con edited_symbols`);
  console.log(`  ${stillFileLevel} sin símbolo derivable (pura adición / no resoluble) → sigue file-level`);
  console.log(`  ${skippedHasSymbols} ya tenían símbolos (skip; usa --force para re-derivar)`);
  if (skippedNoRepo > 0) console.log(`  ${skippedNoRepo} sin repoPath en el lock (¿prepare pendiente?)`);
  if (skippedNoPatch > 0) console.log(`  ${skippedNoPatch} sin patch sidecar`);
  console.log(`tasks.yaml reescrito: ${tasksPath}`);
}

if (isEntrypoint(import.meta.url)) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
