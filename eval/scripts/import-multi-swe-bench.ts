/**
 * Loader instance-centric de **Multi-SWE-bench** (ByteDance) → manifests LaCoCo.
 *
 * Hermano de `import-swe-polybench.ts`: convierte instancias estilo SWE-bench
 * (esquema SIN `modified_nodes`) en tasks/repos del bundle. La diferencia clave es
 * el gold: Multi-SWE-bench solo trae el `fix_patch`, así que el import deja el gold
 * a nivel ARCHIVO (`extractPatchEvidenceTier1` con `modifiedNodes: null`) y los
 * `edited_symbols` se derivan DESPUÉS, contra el checkout `base_commit`, en
 * `enrich-gold-symbols.ts` (usa `deriveEditedSymbolsFromCheckout`). Así los repos
 * de Multi-SWE-bench quedan con gold-símbolo igual que los de SWE-PolyBench.
 *
 * Se espera un jsonl YA NORMALIZADO (lo produce `swe-polybench/fetch_multi_swe_bench.py`)
 * con los campos de {@link MultiSweBenchInstance}. Diseñado para correr con `--append`
 * dentro de un bundle pre-creado (p. ej. `swe-polybench-10repos`), reusando los
 * writers/append-guard de `import-swe-polybench.ts` para no clobbear run.yaml/splits.
 */

import { readFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import { MANIFESTS_DIR } from "./lib/paths.js";
import { extractPatchEvidenceTier1, filesInDiff } from "./lib/patch-evidence-gold.js";
import { isEntrypoint } from "./lib/cli.js";
import type { TaskDefinition } from "./lib/types.js";
import {
  areasFromFiles,
  cleanIssueText,
  deriveSourceRoots,
  mergeById,
  readExistingList,
  repoNameFromSlug,
  shortId,
  writePatchSidecars,
  writeReposManifest,
  writeTasksManifest,
  type PatchSidecar,
} from "./import-swe-polybench.js";

/**
 * Instancia normalizada de Multi-SWE-bench (la produce el fetcher). `repo` es el
 * slug completo `<org>/<repo>` (como SWE-PolyBench) para reusar `repoNameFromSlug`
 * y el armado de la URL de clonado.
 */
interface MultiSweBenchInstance {
  instance_id: string; // `<org>__<repo>-<number>`
  repo: string; // `<org>/<repo>`
  base_commit: string;
  problem_statement: string;
  fix_patch: string;
  test_patch?: string | null;
  test_command?: string | null;
  number?: number | null;
}

interface LoaderOptions {
  dataFile: string;
  outDir: string;
  repo?: string;
  limit: number;
  onlyMixed: boolean;
  onlySingle: boolean;
  append: boolean;
}

const TEST_DIR_RE = /(^|\/)(tests?|__tests__|spec|e2e|test)(\/|$)/i;

function parseArgs(argv: string[]): LoaderOptions {
  const options: LoaderOptions = {
    dataFile: "",
    outDir: join(MANIFESTS_DIR, "swe-polybench-10repos"),
    limit: Number.MAX_SAFE_INTEGER,
    onlyMixed: false,
    onlySingle: false,
    append: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--data-file") {
      if (value === undefined) throw new Error("--data-file requires a value (normalized Multi-SWE-bench jsonl)");
      options.dataFile = value;
      i += 1;
    } else if (arg === "--out-dir") {
      if (value === undefined) throw new Error("--out-dir requires a value");
      options.outDir = value;
      i += 1;
    } else if (arg === "--repo") {
      if (value === undefined) throw new Error("--repo requires a value (org/repo slug)");
      options.repo = value;
      i += 1;
    } else if (arg === "--limit") {
      if (value === undefined) throw new Error("--limit requires a value");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--limit requires a positive integer");
      options.limit = parsed;
      i += 1;
    } else if (arg === "--only-mixed") {
      // Solo instancias cuyo fix toca >=2 archivos fuente (proxy multi-hop). El
      // régimen final igualmente se re-parte por conteo de símbolos tras enrich.
      options.onlyMixed = true;
    } else if (arg === "--only-single") {
      // Solo instancias que tocan exactamente 1 archivo fuente (control single-hop).
      options.onlySingle = true;
    } else if (arg === "--append") {
      options.append = true;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  if (options.dataFile === "") throw new Error("--data-file is required (normalized Multi-SWE-bench jsonl)");
  if (options.onlyMixed && options.onlySingle) throw new Error("--only-mixed and --only-single are mutually exclusive");
  return options;
}

/** Archivos FUENTE (no-test) que toca el fix, para el proxy de régimen y source_roots. */
function sourceFilesOfFix(inst: MultiSweBenchInstance): string[] {
  const testFiles = new Set(inst.test_patch != null && inst.test_patch !== "" ? filesInDiff(inst.test_patch) : []);
  return filesInDiff(inst.fix_patch).filter((f) => !testFiles.has(f) && !TEST_DIR_RE.test(f));
}

/** Número de PR desde el instance_id (`...-1234`) o el campo explícito. */
function pullNumber(inst: MultiSweBenchInstance): number | null {
  if (typeof inst.number === "number") return inst.number;
  const tail = inst.instance_id.split("-").pop();
  const parsed = tail === undefined ? Number.NaN : Number(tail);
  return Number.isInteger(parsed) ? parsed : null;
}

function loadInstances(options: LoaderOptions): MultiSweBenchInstance[] {
  const raw = readFileSync(options.dataFile, "utf8");
  const selected: MultiSweBenchInstance[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const inst = JSON.parse(trimmed) as MultiSweBenchInstance;
    if (options.repo !== undefined && inst.repo !== options.repo) continue;
    if (inst.fix_patch == null || inst.fix_patch === "") continue;
    const sources = sourceFilesOfFix(inst);
    // Sin archivos fuente tocados no hay nada que recuperar (fix solo-tests/docs).
    if (sources.length === 0) continue;
    if (options.onlyMixed && sources.length < 2) continue;
    if (options.onlySingle && sources.length !== 1) continue;
    selected.push(inst);
    if (selected.length >= options.limit) break;
  }
  return selected;
}

interface BuildResult {
  tasks: TaskDefinition[];
  repositories: Record<string, unknown>[];
  patches: PatchSidecar[];
  mixed: number;
  single: number;
}

function build(instances: MultiSweBenchInstance[]): BuildResult {
  const tasks: TaskDefinition[] = [];
  const repositories: Record<string, unknown>[] = [];
  const patches: PatchSidecar[] = [];
  let mixed = 0;
  let single = 0;

  for (const inst of instances) {
    const id = shortId(inst.instance_id);
    const sources = sourceFilesOfFix(inst);
    if (sources.length >= 2) mixed += 1;
    else single += 1;

    // Gold Tier 1 SIN símbolos: Multi-SWE-bench no trae `modified_nodes`, así que
    // arranca a nivel archivo (`fell_back_to_file_level=true`). `edited_symbols` los
    // rellena `enrich-gold-symbols.ts` contra el checkout base.
    const patchEvidence = extractPatchEvidenceTier1({
      patch: inst.fix_patch,
      testPatch: inst.test_patch ?? null,
      modifiedNodes: null,
      changedFiles: sources,
      f2p: null,
    });

    patches.push({ id, patch: inst.fix_patch, testPatch: inst.test_patch ?? null });

    const query = inst.problem_statement.trim();
    const cleanedQuery = cleanIssueText(query);

    tasks.push({
      id,
      repo_id: id,
      title: `Multi-SWE-bench ${inst.instance_id}`,
      type: "bug_fix",
      difficulty: "medium",
      prompt: query,
      deterministic_input: {
        retrieval_input: { query },
        oracle_input: null,
        embedding_input: cleanedQuery === "" ? query : cleanedQuery,
        intent: "debug",
        dimensions: ["CPG", "DTG"],
      },
      expected_areas: areasFromFiles(sources),
      // Los test files que toca el test_patch: activan el gate shouldRunTests y
      // dan al caller la lista de targets para el run file-scoped (sin títulos F2P
      // upstream, se corre el file entero; exit code = grade).
      target_tests: inst.test_patch != null && inst.test_patch !== "" ? filesInDiff(inst.test_patch) : [],
      gold: {
        status: "ready",
        patch_evidence: patchEvidence,
        primary_anchor: null,
        relevant_nodes: [],
        multihop_nodes: [],
        multihop_status: "pending",
        annotation_notes:
          `Gold derivado de Multi-SWE-bench (instance ${inst.instance_id}). Patch-evidence ` +
          `nivel archivo en el import: ${patchEvidence.edited_files.length} archivo(s), ` +
          `${patchEvidence.touched_tests.length} test(s). ` +
          `edited_symbols se derivan del diff contra el checkout base en enrich-gold-symbols.`,
      },
      translation_gold: {
        status: "pending_manual_annotation",
        relevant_terms: [],
        annotation_notes: "No aplica: Multi-SWE-bench no trae modified_nodes.",
      },
      tags: ["multi-swe-bench", repoNameFromSlug(inst.repo)],
      swe_polybench: {
        instance_id: inst.instance_id,
        base_commit: inst.base_commit,
        pull_number: pullNumber(inst),
        unmapped_count: 0,
        patch_ref: `patches/${id}.patch`,
        test_patch_ref: inst.test_patch != null && inst.test_patch !== "" ? `patches/${id}.test.patch` : null,
      },
    });

    repositories.push({
      id,
      display_name: `${repoNameFromSlug(inst.repo)} @ ${inst.base_commit.slice(0, 7)}`,
      url: `https://github.com/${inst.repo}.git`,
      ref: inst.base_commit,
      package_manager: "npm",
      install_command: "npm install",
      // Default `npm test`: parseTestCommand lo lee como npm-script y
      // resolveConcreteRunner resuelve el runner real (jest/mocha) desde
      // `scripts.test` del checkout. El grading corre el test file completo que
      // toca el test_patch (synthesizeFileScopedTestRun). Un `true` no-op haría
      // "pasar" todo falsamente. Instancias con test_command upstream lo respetan.
      test_command: inst.test_command != null && inst.test_command !== "" ? inst.test_command : "npm test",
      source_roots: deriveSourceRoots(sources),
      tsconfig_candidates: [],
      language_scope: ["javascript", "typescript"],
    });
  }

  return { tasks, repositories, patches, mixed, single };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const instances = loadInstances(options);
  if (instances.length === 0) {
    throw new Error(
      `no instances matched (data-file=${options.dataFile}` +
        (options.repo ? `, repo=${options.repo}` : "") +
        (options.onlyMixed ? ", only-mixed" : "") +
        (options.onlySingle ? ", only-single" : "") +
        ")",
    );
  }

  const { tasks, repositories, patches, mixed, single } = build(instances);

  mkdirSync(options.outDir, { recursive: true });

  const tasksAsRecords = tasks as unknown as Record<string, unknown>[];
  let outTasks: Record<string, unknown>[] = tasksAsRecords;
  let outRepos: Record<string, unknown>[] = repositories;
  if (options.append) {
    outTasks = mergeById(readExistingList(join(options.outDir, "tasks.yaml"), "tasks"), tasksAsRecords);
    outRepos = mergeById(readExistingList(join(options.outDir, "repos.yaml"), "repositories"), repositories);
  }

  writeTasksManifest(options.outDir, outTasks as unknown as TaskDefinition[]);
  writeReposManifest(options.outDir, outRepos);
  writePatchSidecars(options.outDir, patches);

  // Este importador NO escribe run.yaml/strategies.yaml/metrics.yaml: el bundle
  // `swe-polybench-10repos` los trae ya con las 8 estrategias y los splits
  // bench10_mh/bench10_sh (poblados por build-bench10-splits tras enrich).
  const runManifestPath = join(options.outDir, "run.yaml");
  if (!existsSync(runManifestPath)) {
    console.warn(
      `AVISO: ${runManifestPath} no existe. Crea el bundle swe-polybench-10repos ` +
        `(run.yaml + strategies.yaml + metrics.yaml + agents.yaml) antes de correr retrieval.`,
    );
  }

  console.log(`Instancias Multi-SWE-bench: ${instances.length}${options.repo ? ` (${options.repo})` : ""}${options.append ? " [append]" : ""}`);
  console.log(`  régimen (por # archivos fuente del fix): ${mixed} multi-hop(>=2) · ${single} single-hop(1)`);
  console.log(`Manifests escritos en: ${options.outDir}`);
  console.log(`  tasks.yaml (${outTasks.length}), repos.yaml (${outRepos.length}), ${patches.length} patch sidecar(s)`);
  console.log("Gold a nivel archivo; corre enrich-gold-symbols para poblar edited_symbols.");
}

if (isEntrypoint(import.meta.url)) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
