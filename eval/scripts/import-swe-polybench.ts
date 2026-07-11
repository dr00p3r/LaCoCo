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

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from "node:fs";
import { join, posix } from "node:path";
import { parse, parseDocument, stringify } from "yaml";

import { EVAL_ROOT, MANIFESTS_DIR, resolveManifestsDir } from "./lib/paths.js";
import { translateModifiedNodes, parseModifiedNodes } from "./lib/swe-polybench-nodes.js";
import { parseF2pTestId } from "./lib/swe-polybench-test-command.js";
import { extractPatchEvidenceTier1 } from "./lib/patch-evidence-gold.js";
import { extractMultihopFromGraph } from "./lib/multihop-translator.js";
import { loadManifests } from "./lib/load-manifests.js";
import { readRepositoriesLock } from "./lib/repo-lock.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { isEntrypoint } from "./lib/cli.js";
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
  /** Diff del patch de referencia (el fix). Fuente del patch-evidence gold. */
  patch: string;
  /** Diff del patch de tests asociado. */
  test_patch?: string;
}

interface LoaderOptions {
  limit: number;
  repo: string;
  outDir: string;
  runId?: string;
  enableMultihop: boolean;
  includeMixed?: boolean;
  onlyMixed?: boolean;
  manifestsDir?: string;
  append?: boolean;
  dataFile?: string;
}

const DATA_FILE = join(EVAL_ROOT, "data", "swe-polybench", "instances.tsjs.full.jsonl");
export const UPDATED_AT = "2026-07-07";
/** Estrategias del smoke (subconjunto de phases.retrieval.include_strategies). */
// Escalera reformada (2026-07-09): hybrid (baseline) + clcr (comparación) + consensus
// (grafo por consenso de aristas entrantes). ictd/rpr/agentic podadas (no rinden).
const SMOKE_STRATEGIES = ["hybrid", "clcr", "consensus"];
/** Manifests compartidos que se copian verbatim del canónico al dir del smoke. */
export const SHARED_MANIFESTS = ["strategies.yaml", "agents.yaml", "metrics.yaml"] as const;

function parseArgs(argv: string[]): LoaderOptions {
  const options: LoaderOptions = {
    limit: 10,
    repo: "sveltejs/svelte",
    outDir: join(MANIFESTS_DIR, "swe-polybench"),
    enableMultihop: false,
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
    } else if (arg === "--run-id") {
      if (value === undefined) throw new Error("--run-id requires a value");
      options.runId = value;
      i += 1;
    } else if (arg === "--manifests-dir") {
      if (value === undefined) throw new Error("--manifests-dir requires a value");
      options.manifestsDir = value;
      i += 1;
    } else if (arg === "--data-file") {
      // Fuente de instancias distinta al DATA_FILE por defecto. Permite apuntar al
      // dataset SWE-PolyBench COMPLETO (21 repos) descargado con fetch_metadata.py
      // --dataset AmazonScience/SWE-PolyBench --full, en vez del subset _Verified local.
      if (value === undefined) throw new Error("--data-file requires a value");
      options.dataFile = value;
      i += 1;
    } else if (arg === "--enable-multihop") {
      // Flag sin valor. Requiere --run-id para resolver dbPath por tarea.
      options.enableMultihop = true;
    } else if (arg === "--include-mixed") {
      // Flag sin valor. Amplia el filtro: acepta is_mixed tambien. Combinado
      // con --limit permite ir mas alla del subset is_func_only estricto.
      options.includeMixed = true;
    } else if (arg === "--only-mixed") {
      // Flag sin valor. SOLO instancias multi-hop (num_nodes 2-4); excluye los
      // single-hop (num_nodes==1). Para el test de estrategias de grafo en su regimen.
      options.onlyMixed = true;
      options.includeMixed = true;
    } else if (arg === "--append") {
      // Flag sin valor. Mergea con tasks.yaml/repos.yaml ya presentes en --out-dir
      // (por id) en vez de sobrescribir → acumula varios repos en un solo manifest.
      options.append = true;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return options;
}

/** Lee el JSONL y devuelve las instancias que pasan el filtro de "fácil". */
export function loadEasyInstances(repo: string, limit: number, includeMixed = false, onlyMixed = false, dataFile: string = DATA_FILE): SwePolyBenchInstance[] {
  const raw = readFileSync(dataFile, "utf8");
  const selected: SwePolyBenchInstance[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const inst = JSON.parse(trimmed) as SwePolyBenchInstance;
    if (inst.repo !== repo || inst.is_no_nodes === true) continue;
    // Filtro "facil" canonico: 1 sola funcion/clase/metodo modificado.
    // Con --only-mixed se omiten los single-hop (regimen de estrategias de grafo).
    if (!onlyMixed && inst.is_func_only === true && inst.num_nodes === 1) {
      selected.push(inst);
    } else if (includeMixed && inst.num_nodes > 1 && inst.num_nodes <= 4) {
      // --include-mixed: acepta is_mixed con hasta 4 nodos. Mas alla el gold
      // se vuelve ruidoso para M3 (precision por cell cae).
      selected.push(inst);
    }
    if (selected.length >= limit) break;
  }
  return selected;
}

/** `sveltejs__svelte-510` → `svelte-510` (id único e instance-centric). */
export function shortId(instanceId: string): string {
  return instanceId.split("__").pop() ?? instanceId;
}

/** Dirs únicos (POSIX) de los archivos tocados; sirven como `expected_areas`. */
export function areasFromFiles(files: string[]): string[] {
  return [...new Set(files.map((f) => posix.dirname(f)).filter((d) => d !== "" && d !== "."))];
}

/** `mui/material-ui` → `material-ui`. Nombre corto del repo para tags/display_name. */
export function repoNameFromSlug(repoSlug: string): string {
  return repoSlug.split("/").pop() ?? repoSlug;
}

const TEST_DIR_RE = /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)/i;

/**
 * `source_roots` del índice, derivados de los archivos tocados por la instancia.
 * Para cada archivo (excluyendo dirs de test): si tiene un segmento `src`, la raíz
 * es el prefijo hasta e incluyendo `src` (→ `packages/<pkg>/src` en monorepos como
 * mui, `src` en single-tree como svelte/prettier); si no, el primer segmento de dir
 * (p. ej. `lib` en serverless). Escopa el índice al subárbol que contiene el gold,
 * clave para que un monorepo no se indexe entero. Fallback `["src"]`.
 */
export function deriveSourceRoots(changedFiles: readonly string[] | null): string[] {
  const roots = new Set<string>();
  for (const file of changedFiles ?? []) {
    if (TEST_DIR_RE.test(file)) continue;
    const parts = file.split("/");
    const srcIdx = parts.indexOf("src");
    if (srcIdx >= 0) roots.add(parts.slice(0, srcIdx + 1).join("/"));
    else if (parts.length > 1) roots.add(parts[0]!);
  }
  return roots.size > 0 ? [...roots].sort() : ["src"];
}

/** Títulos de prueba F2P parseados (repr Python → ids → título). Solo trazabilidad. */
function f2pTitles(rawF2p: string): string[] {
  return parseModifiedNodes(rawF2p).map((id) => parseF2pTestId(id).title);
}

/**
 * Limpieza ligera del `problem_statement` para usarlo como query de retrieval.
 *
 * El baseline usaba solo la PRIMERA línea (el título), tirando el cuerpo donde
 * viven los identificadores de código (símbolos, paths, snippets). Un usuario real
 * pega el reporte completo, así que la query ideal es el issue entero — pero sin la
 * basura que ensucia el embedding: normaliza saltos `\r\n`, colapsa el URL de los
 * links markdown a su texto, borra URLs sueltas (REPL/gists) y compacta líneas en
 * blanco. NO toca fences de código ni diffs: ahí están las palabras que sirven.
 */
export function cleanIssueText(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, "$1") // [texto](url) → texto
    .replace(/https?:\/\/\S+/g, "") // URLs sueltas
    .replace(/\n{3,}/g, "\n\n") // colapsa líneas en blanco
    .trim();
}

export interface PatchSidecar {
  id: string;
  patch: string;
  testPatch: string | null;
}

interface BuildResult {
  tasks: TaskDefinition[];
  repositories: Record<string, unknown>[];
  totalNodes: number;
  totalUnmapped: number;
  withUnmapped: { id: string; unmapped: number }[];
  multihopComputed: number;
  multihopEmpty: number;
  patches: PatchSidecar[];
  fellBackToFileLevel: number;
}

interface BuildContext {
  /**
   * Lock del run + ruta a `indexes/`. Si esta presente, se intenta derivar
   * el multihop por tarea consultando el `tensor.sqlite` correspondiente.
   */
  lockByRepoId: Map<string, { repoPath: string; indexesDir: string }>;
}

function resolveDbPathForLock(repoPath: string, indexesDir: string, repoId: string): string {
  // Prioriza el path basado en el lock (lo que escribio eval:index) sobre
  // un fallback a <repoPath>/.lacoco/tensor.sqlite, replicando el patron
  // de run-retrieval.ts.
  const lockBased = join(indexesDir, repoId, "tensor.sqlite");
  if (existsSync(lockBased)) return lockBased;
  return join(repoPath, ".lacoco", "tensor.sqlite");
}

function build(instances: SwePolyBenchInstance[], ctx: BuildContext): BuildResult {
  const tasks: TaskDefinition[] = [];
  const repositories: Record<string, unknown>[] = [];
  let totalNodes = 0;
  let totalUnmapped = 0;
  const withUnmapped: { id: string; unmapped: number }[] = [];
  let multihopComputed = 0;
  let multihopEmpty = 0;
  const patches: PatchSidecar[] = [];
  let fellBackToFileLevel = 0;

  for (const inst of instances) {
    const id = shortId(inst.instance_id);
    const translation = translateModifiedNodes(inst.modified_nodes, inst.changed_files ?? null);

    // Patch-evidence gold (Tier 1): edit-site (archivos + símbolos) + tests, sin
    // necesitar el repo checked-out. Tier 2 (introduced_refs/resolved_definitions)
    // se rellena en un paso posterior que sí tiene el árbol post-patch.
    const patchEvidence = extractPatchEvidenceTier1({
      patch: inst.patch ?? "",
      testPatch: inst.test_patch ?? null,
      modifiedNodes: inst.modified_nodes,
      changedFiles: inst.changed_files ?? null,
      f2p: inst.F2P,
    });
    if (patchEvidence.resolution.fell_back_to_file_level) fellBackToFileLevel += 1;
    if (inst.patch != null && inst.patch !== "") {
      patches.push({ id, patch: inst.patch, testPatch: inst.test_patch ?? null });
    }
    totalNodes += translation.nodeIds.length;
    totalUnmapped += translation.unmapped.length;
    if (translation.unmapped.length > 0) {
      withUnmapped.push({ id, unmapped: translation.unmapped.length });
    }

    const query = inst.problem_statement.trim();
    const cleanedQuery = cleanIssueText(query);

    // Multihop automatico: solo si hay anchor, lock para esta tarea, y el
    // grafo correspondiente existe en disco. Cualquier fallo degrada a
    // multihop vacio con multihop_status="auto" (la tarea queda valida
    // para M3-M5 y excluida de M6).
    let multihopNodes: string[] = [];
    let multihopStatus: "auto" | "manual" = "manual";
    let multihopNotes = "";
    const lockEntry = ctx.lockByRepoId.get(id);
    if (lockEntry !== undefined) {
      const dbPath = resolveDbPathForLock(lockEntry.repoPath, lockEntry.indexesDir, id);
      if (existsSync(dbPath) && translation.nodeIds.length > 0 && translation.nodeIds[0] !== undefined) {
        try {
          const result = extractMultihopFromGraph({
            dbPath,
            primaryAnchor: translation.nodeIds[0],
            repoPath: lockEntry.repoPath,
            edgeKinds: ["CALLS", "REFERENCES", "DECLARES"],
            depthMin: 2,
            depthMax: 3,
            topK: 5,
            excludeNodes: translation.nodeIds,
          });
          multihopNodes = result.multihopNodes;
          multihopStatus = "auto";
          multihopComputed += 1;
          if (multihopNodes.length === 0) multihopEmpty += 1;
          multihopNotes = ` Multihop auto: ${multihopNodes.length} nodo(s) via BFS-2 (CALLS+REFERENCES+DECLARES, depth 2-3, top-5 por degree centrality).`;
        } catch (error) {
          // Si el multihop falla (db corrupto, nodos faltantes, etc.) seguimos
          // con multihop vacio + status auto: la tarea sigue siendo valida,
          // solo se excluye de M6.
          multihopNotes = ` Multihop auto no disponible: ${error instanceof Error ? error.message : String(error)}.`;
        }
      } else if (translation.nodeIds[0] !== undefined) {
        multihopStatus = "auto";
        multihopNotes = " Multihop auto: db no encontrado, multihop vacio (tarea excluida de M6).";
      }
    }

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
        embedding_input: cleanedQuery === "" ? query : cleanedQuery,
        intent: "debug",
        dimensions: ["CPG", "DTG"],
      },
      expected_areas: areasFromFiles(translation.files),
      target_tests: f2pTitles(inst.F2P),
      gold: {
        status: "ready",
        patch_evidence: patchEvidence,
        primary_anchor: translation.nodeIds[0] ?? null,
        relevant_nodes: translation.nodeIds,
        multihop_nodes: multihopNodes,
        multihop_status: multihopStatus,
        annotation_notes:
          `Gold derivado de SWE-PolyBench (instance ${inst.instance_id}). Patch-evidence ` +
          `(fuente principal): ${patchEvidence.edited_files.length} archivo(s), ` +
          `${patchEvidence.edited_symbols.length} símbolo(s), ` +
          `${patchEvidence.touched_tests.length} test(s)` +
          (patchEvidence.resolution.fell_back_to_file_level ? " [fallback file-level]" : "") +
          `. Campos legacy (relevant_nodes/multihop) = diagnóstico de grafo.` +
          multihopNotes,
      },
      translation_gold: {
        status: "pending_manual_annotation",
        relevant_terms: [],
        annotation_notes: "No aplica al smoke de retrieval SWE-PolyBench.",
      },
      tags: ["swe-polybench", repoNameFromSlug(inst.repo)],
      swe_polybench: {
        instance_id: inst.instance_id,
        base_commit: inst.base_commit,
        pull_number: inst.pull_number ?? null,
        unmapped_count: translation.unmapped.length,
        patch_ref: inst.patch != null && inst.patch !== "" ? `patches/${id}.patch` : null,
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
      test_command: inst.test_command,
      source_roots: deriveSourceRoots(inst.changed_files ?? null),
      tsconfig_candidates: [],
      language_scope: ["javascript", "typescript"],
    });
  }

  return {
    tasks,
    repositories,
    totalNodes,
    totalUnmapped,
    withUnmapped,
    multihopComputed,
    multihopEmpty,
    patches,
    fellBackToFileLevel,
  };
}

/** Escribe los sidecars de patch (fix + tests) bajo `<outDir>/patches/`. */
export function writePatchSidecars(outDir: string, patches: PatchSidecar[]): void {
  if (patches.length === 0) return;
  const patchesDir = join(outDir, "patches");
  mkdirSync(patchesDir, { recursive: true });
  for (const { id, patch, testPatch } of patches) {
    writeFileSync(join(patchesDir, `${id}.patch`), patch, "utf8");
    if (testPatch !== null && testPatch !== "") {
      writeFileSync(join(patchesDir, `${id}.test.patch`), testPatch, "utf8");
    }
  }
}

/** Escribe `repos.yaml` reusando header+`defaults` del canónico (preserva comentarios). */
export function writeReposManifest(outDir: string, repositories: Record<string, unknown>[]): void {
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

/** Lee la lista (`tasks`/`repositories`) de un manifest YAML existente, o [] si no existe. */
export function readExistingList(path: string, key: "tasks" | "repositories"): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  const doc = parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
  const list = doc?.[key];
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/** Mergea dos listas de objetos por `id` (los `next` ganan sobre `prev`). */
export function mergeById<T extends { id?: unknown }>(prev: T[], next: T[]): T[] {
  const byId = new Map<string, T>();
  for (const item of prev) byId.set(String(item.id), item);
  for (const item of next) byId.set(String(item.id), item);
  return [...byId.values()];
}

export function writeTasksManifest(outDir: string, tasks: TaskDefinition[]): void {
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
  const instances = loadEasyInstances(options.repo, options.limit, options.includeMixed === true, options.onlyMixed === true, options.dataFile ?? DATA_FILE);
  if (instances.length === 0) {
    throw new Error(
      `no instances matched repo=${options.repo} (is_func_only + num_nodes=1`
        + (options.includeMixed ? " + is_mixed <=4" : "")
        + ")",
    );
  }

  // Si se dio --run-id + --enable-multihop, leemos el lock y resolvemos
  // dbPath por tarea. Si no, el multihop queda vacio con multihop_status
  // "manual" (status por default en el validador, retro-compat).
  let ctx: BuildContext = { lockByRepoId: new Map() };
  if (options.enableMultihop) {
    if (options.runId === undefined) {
      throw new Error("--enable-multihop requires --run-id (to resolve the indexed graph for each task)");
    }
    const manifests = loadManifests(resolveManifestsDir(options.manifestsDir));
    const layout = resolveEvalLayout(manifests.run, options.runId);
    if (!existsSync(layout.lockFile)) {
      throw new Error(`lock not found at ${layout.lockFile}; run eval:prepare + eval:index for ${options.runId} first`);
    }
    const lock = readRepositoriesLock(layout.lockFile);
    const indexesDir = layout.indexesDirectory;
    for (const repo of lock.repositories) {
      ctx.lockByRepoId.set(repo.id, { repoPath: repo.repoPath, indexesDir });
    }
    if (ctx.lockByRepoId.size === 0) {
      throw new Error(`lock at ${layout.lockFile} has no repositories; run eval:prepare first`);
    }
  }

  const { tasks, repositories, totalNodes, totalUnmapped, withUnmapped, multihopComputed, multihopEmpty, patches, fellBackToFileLevel } = build(instances, ctx);

  mkdirSync(options.outDir, { recursive: true });

  // --append: mergea con lo ya presente en --out-dir por `id` (los nuevos ganan),
  // para acumular varios repos en un solo manifest sin re-correr desde cero.
  const tasksAsRecords = tasks as unknown as Record<string, unknown>[];
  let outTasks: Record<string, unknown>[] = tasksAsRecords;
  let outRepos: Record<string, unknown>[] = repositories;
  if (options.append === true) {
    outTasks = mergeById(readExistingList(join(options.outDir, "tasks.yaml"), "tasks"), tasksAsRecords);
    outRepos = mergeById(readExistingList(join(options.outDir, "repos.yaml"), "repositories"), repositories);
  }

  writeTasksManifest(options.outDir, outTasks as unknown as TaskDefinition[]);
  writeReposManifest(options.outDir, outRepos);
  writePatchSidecars(options.outDir, patches);
  // En --append NO se re-clonan run.yaml ni los SHARED_MANIFESTS desde la RAÍZ si ya
  // existen en el bundle: eso borraría splits editados a mano y una strategies.yaml
  // con más estrategias (repograph/ppr/connector). Solo se escriben la primera vez.
  const preserveManifests = options.append === true;
  const runManifestPath = join(options.outDir, "run.yaml");
  if (!(preserveManifests && existsSync(runManifestPath))) {
    writeRunManifest(options.outDir);
  }
  for (const name of SHARED_MANIFESTS) {
    const dest = join(options.outDir, name);
    if (preserveManifests && existsSync(dest)) continue;
    copyFileSync(join(MANIFESTS_DIR, name), dest);
  }

  console.log(`Instancias: ${instances.length} (${options.repo})${options.append ? " [append]" : ""}`);
  console.log(`Manifests escritos en: ${options.outDir}`);
  const runNote = preserveManifests && existsSync(runManifestPath) ? "run.yaml preservado (append)" : "run.yaml (+split swe-polybench)";
  const sharedNote = preserveManifests ? "SHARED_MANIFESTS preservados si existían (append)" : `copiados verbatim: ${SHARED_MANIFESTS.join(", ")}`;
  console.log(`  tasks.yaml (${outTasks.length}), repos.yaml (${outRepos.length}), ${runNote}`);
  console.log(`  ${sharedNote}`);
  console.log(`patch-evidence: ${patches.length} sidecar(s) en patches/ · ${fellBackToFileLevel} tarea(s) file-level (patch sin nodo mapeable)`);
  console.log(`relevant_nodes (diagnóstico) totales: ${totalNodes} · sin mapear: ${totalUnmapped}`);
  if (withUnmapped.length > 0) {
    console.log("Instancias con nodos sin mapear:");
    for (const { id, unmapped } of withUnmapped) console.log(`  ${id}: ${unmapped}`);
  } else {
    console.log("Sin nodos sin mapear (traductor sano).");
  }
  if (options.enableMultihop) {
    console.log(`Multihop auto: ${multihopComputed} computado(s), ${multihopEmpty} con multihop vacio (excluidos de M6).`);
  } else {
    console.log("Multihop auto no solicitado (pasa --enable-multihop --run-id <id> para derivar BFS-2 desde el grafo).");
  }
}

if (isEntrypoint(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
