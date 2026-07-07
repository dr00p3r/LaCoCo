/**
 * Loader instance-centric de SWE-PolyBench → manifests del harness LaCoCo.
 *
 * Convierte instancias del dataset (`eval/data/swe-polybench/instances.tsjs.full.jsonl`)
 * en un set AUTOCONTENIDO de manifests bajo `eval/manifests/swe-polybench/`, que el
 * pipeline existente (prepare → index → retrieval → metrics) consume vía el flag
 * `--manifests-dir`. Aísla del gold interino en `eval/manifests/tasks.yaml`.
 *
 * Alcance del smoke de retrieval (M3–M5): 1 repo (svelte), instancias fáciles
 * `is_func_only && num_nodes==1 && !is_no_nodes`. Cada instancia es un repo propio
 * (`ref = base_commit`) y una task cuyo `gold.relevant_nodes` sale de traducir
 * `modified_nodes` con {@link translateModifiedNodes} — sin anotación manual.
 *
 * NO emite bloque `regression`: el estado pre-fix a indexar ES el `base_commit`
 * (que `prepare-repos` checkout-ea vía `ref`); el `regression`/`broken_patch` era del
 * benchmark manual previo y no aplica a SWE-PolyBench.
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync } from "node:fs";
import { join, posix } from "node:path";
import { parseDocument, stringify } from "yaml";

import { EVAL_ROOT, MANIFESTS_DIR } from "./lib/paths.js";
import { translateModifiedNodes, parseModifiedNodes } from "./lib/swe-polybench-nodes.js";
import { parseF2pTestId } from "./lib/swe-polybench-test-command.js";
import type { TaskDefinition } from "./lib/types.js";

/** Campos de una instancia del dataset que consume el loader. */
interface SwePolyBenchInstance {
  instance_id: string;
  repo: string;
  base_commit: string;
  problem_statement: string;
  modified_nodes: string;
  changed_files?: string[];
  is_func_only: boolean;
  num_nodes: number;
  is_no_nodes: boolean;
  F2P: string;
  test_command: string;
  pull_number?: number;
}

interface LoaderOptions {
  limit: number;
  repo: string;
  outDir: string;
}

const DATA_FILE = join(EVAL_ROOT, "data", "swe-polybench", "instances.tsjs.full.jsonl");
const UPDATED_AT = "2026-07-07";
/** Estrategias del smoke (subconjunto de phases.retrieval.include_strategies). */
const SMOKE_STRATEGIES = ["hybrid", "ictd", "clcr", "rpr"];
/** Manifests compartidos que se copian verbatim del canónico al dir del smoke. */
const SHARED_MANIFESTS = ["strategies.yaml", "agents.yaml", "metrics.yaml"] as const;

function parseArgs(argv: string[]): LoaderOptions {
  const options: LoaderOptions = {
    limit: 10,
    repo: "sveltejs/svelte",
    outDir: join(MANIFESTS_DIR, "swe-polybench"),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--limit") {
      if (value === undefined) throw new Error("--limit requires a value");
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--limit requires a positive integer");
      options.limit = parsed;
      i += 1;
    } else if (arg === "--repo") {
      if (value === undefined) throw new Error("--repo requires a value");
      options.repo = value;
      i += 1;
    } else if (arg === "--out-dir") {
      if (value === undefined) throw new Error("--out-dir requires a value");
      options.outDir = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return options;
}

/** Lee el JSONL y devuelve las instancias que pasan el filtro de "fácil". */
function loadEasyInstances(repo: string, limit: number): SwePolyBenchInstance[] {
  const raw = readFileSync(DATA_FILE, "utf8");
  const selected: SwePolyBenchInstance[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const inst = JSON.parse(trimmed) as SwePolyBenchInstance;
    if (
      inst.repo === repo &&
      inst.is_func_only === true &&
      inst.num_nodes === 1 &&
      inst.is_no_nodes !== true
    ) {
      selected.push(inst);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}

/** `sveltejs__svelte-510` → `svelte-510` (id único e instance-centric). */
function shortId(instanceId: string): string {
  return instanceId.split("__").pop() ?? instanceId;
}

/** Dirs únicos (POSIX) de los archivos tocados; sirven como `expected_areas`. */
function areasFromFiles(files: string[]): string[] {
  return [...new Set(files.map((f) => posix.dirname(f)).filter((d) => d !== "" && d !== "."))];
}

/** Títulos de prueba F2P parseados (repr Python → ids → título). Solo trazabilidad. */
function f2pTitles(rawF2p: string): string[] {
  return parseModifiedNodes(rawF2p).map((id) => parseF2pTestId(id).title);
}

interface BuildResult {
  tasks: TaskDefinition[];
  repositories: Record<string, unknown>[];
  totalNodes: number;
  totalUnmapped: number;
  withUnmapped: { id: string; unmapped: number }[];
}

function build(instances: SwePolyBenchInstance[]): BuildResult {
  const tasks: TaskDefinition[] = [];
  const repositories: Record<string, unknown>[] = [];
  let totalNodes = 0;
  let totalUnmapped = 0;
  const withUnmapped: { id: string; unmapped: number }[] = [];

  for (const inst of instances) {
    const id = shortId(inst.instance_id);
    const translation = translateModifiedNodes(inst.modified_nodes, inst.changed_files ?? null);
    totalNodes += translation.nodeIds.length;
    totalUnmapped += translation.unmapped.length;
    if (translation.unmapped.length > 0) {
      withUnmapped.push({ id, unmapped: translation.unmapped.length });
    }

    const query = inst.problem_statement.trim();
    const firstLine = query.split("\n")[0]!.trim();

    tasks.push({
      id,
      repo_id: id,
      title: `SWE-PolyBench ${inst.instance_id}`,
      type: "bug_fix",
      difficulty: "medium",
      prompt: query,
      deterministic_input: {
        retrieval_input: { query },
        oracle_input: null,
        embedding_input: firstLine === "" ? query : firstLine,
        intent: "fix",
        dimensions: ["CPG", "DTG"],
      },
      expected_areas: areasFromFiles(translation.files),
      target_tests: f2pTitles(inst.F2P),
      gold: {
        status: "ready",
        primary_anchor: translation.nodeIds[0] ?? null,
        relevant_nodes: translation.nodeIds,
        multihop_nodes: [],
        annotation_notes:
          `Gold derivado de SWE-PolyBench (instance ${inst.instance_id}), traducido por ` +
          `swe-polybench-nodes.ts. ${translation.nodeIds.length} nodo(s), ` +
          `${translation.unmapped.length} sin mapear.`,
      },
      translation_gold: {
        status: "pending_manual_annotation",
        relevant_terms: [],
        annotation_notes: "No aplica al smoke de retrieval SWE-PolyBench.",
      },
      // Metadata extra tolerada por `[key: string]: unknown` (trazabilidad/reporte).
      tags: ["swe-polybench", "svelte"],
      swe_polybench: {
        instance_id: inst.instance_id,
        base_commit: inst.base_commit,
        pull_number: inst.pull_number ?? null,
        unmapped_count: translation.unmapped.length,
      },
    });

    repositories.push({
      id,
      display_name: `svelte @ ${inst.base_commit.slice(0, 7)}`,
      url: "https://github.com/sveltejs/svelte.git",
      ref: inst.base_commit,
      package_manager: "npm",
      install_command: "npm install",
      test_command: inst.test_command,
      source_roots: ["src"],
      tsconfig_candidates: [],
      language_scope: ["javascript", "typescript"],
    });
  }

  return { tasks, repositories, totalNodes, totalUnmapped, withUnmapped };
}

/** Escribe `repos.yaml` reusando header+`defaults` del canónico (preserva comentarios). */
function writeReposManifest(outDir: string, repositories: Record<string, unknown>[]): void {
  const canonical = readFileSync(join(MANIFESTS_DIR, "repos.yaml"), "utf8");
  const doc = parseDocument(canonical);
  doc.set("updated_at", UPDATED_AT);
  doc.setIn(["repositories"], repositories);
  writeFileSync(join(outDir, "repos.yaml"), doc.toString(), "utf8");
}

/** Copia `run.yaml` del canónico e inyecta el split `swe-polybench` (preserva comentarios). */
function writeRunManifest(outDir: string): void {
  const canonical = readFileSync(join(MANIFESTS_DIR, "run.yaml"), "utf8");
  const doc = parseDocument(canonical);
  // Sin task_ids/repo_ids → corre todas las tasks del dir. gold.status="ready".
  doc.setIn(["splits", "swe-polybench"], {
    description: "Smoke de retrieval SWE-PolyBench (svelte, is_func_only + num_nodes==1).",
    strategies: SMOKE_STRATEGIES,
    sanitizer_variants: ["deterministic"],
    require_gold_status: "ready",
  });
  // El smoke de retrieval NO corre tests: el `test_command` crudo de Docker
  // (nvm/`/testbed/`) fallaría local y quemaría el timeout de 900s por repo. Sin
  // regression tampoco hay estado roto que verificar. Se apagan los 3 toggles.
  doc.setIn(["phases", "prepare_repos", "run_baseline_tests"], false);
  doc.setIn(["phases", "prepare_repos", "fail_on_baseline_test_failure"], false);
  doc.setIn(["phases", "prepare_repos", "verify_regression"], false);
  writeFileSync(join(outDir, "run.yaml"), doc.toString(), "utf8");
}

function writeTasksManifest(outDir: string, tasks: TaskDefinition[]): void {
  const manifest = {
    manifest_version: 1,
    kind: "tasks",
    updated_at: UPDATED_AT,
    tasks,
  };
  writeFileSync(join(outDir, "tasks.yaml"), stringify(manifest), "utf8");
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const instances = loadEasyInstances(options.repo, options.limit);
  if (instances.length === 0) {
    throw new Error(`no instances matched repo=${options.repo} (is_func_only + num_nodes==1)`);
  }

  const { tasks, repositories, totalNodes, totalUnmapped, withUnmapped } = build(instances);

  mkdirSync(options.outDir, { recursive: true });
  writeTasksManifest(options.outDir, tasks);
  writeReposManifest(options.outDir, repositories);
  writeRunManifest(options.outDir);
  for (const name of SHARED_MANIFESTS) {
    copyFileSync(join(MANIFESTS_DIR, name), join(options.outDir, name));
  }

  console.log(`Instancias: ${instances.length} (${options.repo})`);
  console.log(`Manifests escritos en: ${options.outDir}`);
  console.log(`  tasks.yaml (${tasks.length}), repos.yaml (${repositories.length}), run.yaml (+split swe-polybench)`);
  console.log(`  copiados verbatim: ${SHARED_MANIFESTS.join(", ")}`);
  console.log(`relevant_nodes totales: ${totalNodes} · sin mapear: ${totalUnmapped}`);
  if (withUnmapped.length > 0) {
    console.log("Instancias con nodos sin mapear:");
    for (const { id, unmapped } of withUnmapped) console.log(`  ${id}: ${unmapped}`);
  } else {
    console.log("Sin nodos sin mapear (traductor sano).");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
