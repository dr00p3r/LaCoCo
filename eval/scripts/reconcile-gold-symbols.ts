/**
 * Reconciliación del gold-símbolo contra el grafo construido.
 *
 * La derivación del gold (SWE-PolyBench: `modified_nodes` string-only;
 * Multi-SWE-bench: ts-morph sobre el checkout) puede producir un `file` que NO
 * coincide con la identidad de nodo del grafo — típicamente por extensión
 * (`SimpleSelect.js` vs `SimpleSelect.tsx`) o por movimiento de directorio
 * (`docs/src/...` vs `docs/data/...`). El símbolo existe idéntico en el grafo,
 * pero bajo otro `file`, así que `EditSiteHit` solo puede acertar a nivel archivo
 * (fallback) en vez de símbolo-exacto.
 *
 * Este paso, DESPUÉS de `eval:index`, abre el grafo por repo y, para cada
 * `edited_symbol` cuyo node-id NO esté en el grafo, busca el nodo real con el
 * MISMO símbolo y el MISMO basename (sin extensión); si hay exactamente uno,
 * reescribe el `file` del gold a la ruta del grafo. Conservador: con 0 o >1
 * candidatos deja el gold intacto. No inventa símbolos (no circular): corrige la
 * DIRECCIÓN de un símbolo ya derivado del diff.
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { parse } from "yaml";

import { resolveManifestsDir } from "./lib/paths.js";
import { asRecord, asString } from "./lib/config.js";
import { loadManifests } from "./lib/load-manifests.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { readRepositoriesLock } from "./lib/repo-lock.js";
import { findGraphDatabase, openGraphLookup, type GraphLookup } from "./lib/graph-reader.js";
import { isAddressableSymbol } from "./lib/patch-evidence-gold.js";
import { resolveNodeId, toRelativeNodeId } from "./lib/node-id.js";
import { writeTasksManifest } from "./import-swe-polybench.js";
import { isEntrypoint } from "./lib/cli.js";
import type { TaskDefinition } from "./lib/types.js";

interface Options {
  runId: string;
  manifestsDir?: string;
  repoId?: string;
  dryRun: boolean;
}

function parseArgs(argv: string[]): Options {
  const options: Partial<Options> = { dryRun: false };
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
    } else if (arg === "--repo-id") {
      if (value === undefined) throw new Error("--repo-id requires a value");
      options.repoId = value;
      i += 1;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  if (options.runId === undefined) throw new Error("--run-id is required (to resolve the graph for each task)");
  return options as Options;
}

/** basename sin extensión: `docs/x/SimpleSelect.tsx` → `SimpleSelect`. */
function stem(filePath: string): string {
  return basename(filePath).replace(/\.[^.]+$/, "");
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const manifestsDir = resolveManifestsDir(options.manifestsDir);
  if (manifestsDir === undefined) {
    throw new Error("--manifests-dir (o LACOCO_EVAL_MANIFESTS_DIR) es obligatorio: reescribe tasks.yaml de un bundle, no del canónico eval/manifests");
  }
  const manifests = loadManifests(manifestsDir);
  const layout = resolveEvalLayout(manifests.run, options.runId);

  const defaults = asRecord(manifests.repos.defaults, "repos.yaml.defaults");
  const indexDefaults = asRecord(defaults.lacoco_index, "repos.yaml.defaults.lacoco_index");
  const graphDbName = asString(indexDefaults.graph_db_name, "repos.yaml.defaults.lacoco_index.graph_db_name");

  const repoPathById = new Map<string, string>();
  if (existsSync(layout.lockFile)) {
    for (const r of readRepositoriesLock(layout.lockFile).repositories) repoPathById.set(r.id, r.repoPath);
  }

  const tasksPath = join(manifestsDir, "tasks.yaml");
  const doc = parse(readFileSync(tasksPath, "utf8")) as { tasks?: TaskDefinition[] } | null;
  const tasks = doc?.tasks ?? [];
  if (tasks.length === 0) throw new Error(`no tasks in ${tasksPath}`);

  const graphByRepo = new Map<string, GraphLookup | null>();
  const openGraphFor = (repoId: string): GraphLookup | null => {
    if (graphByRepo.has(repoId)) return graphByRepo.get(repoId) ?? null;
    const graphPath = findGraphDatabase(layout.runDirectory, layout.indexesDirectory, repoId, graphDbName);
    let lookup: GraphLookup | null = null;
    if (graphPath !== null) {
      try {
        lookup = openGraphLookup(graphPath);
      } catch {
        lookup = null;
      }
    }
    graphByRepo.set(repoId, lookup);
    return lookup;
  };

  let symbolsReconciled = 0;
  let malformedDropped = 0;
  let tasksTouched = 0;
  let unresolved = 0;
  const changes: string[] = [];

  try {
    for (const task of tasks) {
      if (options.repoId !== undefined && task.repo_id !== options.repoId) continue;
      const evidence = task.gold?.patch_evidence;
      if (evidence === undefined || evidence.edited_symbols.length === 0) continue;

      let taskChanged = false;

      // (0) Descarta símbolos malformados ya presentes en el manifest (p. ej. un
      // patrón destructurado `{ a, b }` que se coló como nombre). Nunca casan con
      // el grafo; el edit-site queda cubierto por edited_files.
      const clean = evidence.edited_symbols.filter((ref) => isAddressableSymbol(ref.symbol));
      if (clean.length !== evidence.edited_symbols.length) {
        for (const ref of evidence.edited_symbols) {
          if (!isAddressableSymbol(ref.symbol)) changes.push(`  ${task.id}: descarta símbolo malformado ${ref.file}#${ref.symbol}`);
        }
        malformedDropped += evidence.edited_symbols.length - clean.length;
        evidence.edited_symbols = clean;
        taskChanged = true;
      }
      if (evidence.edited_symbols.length === 0) {
        if (taskChanged) tasksTouched += 1;
        continue;
      }

      const graph = openGraphFor(task.repo_id);
      if (graph === null || graph.nodeCount() === 0) {
        if (taskChanged) tasksTouched += 1;
        continue;
      }
      const repoPath = repoPathById.get(task.repo_id) ?? join(layout.reposDirectory, task.repo_id);
      for (const ref of evidence.edited_symbols) {
        const currentId = resolveNodeId(`${ref.file}#${ref.symbol}`, repoPath);
        if (graph.hasNode(currentId)) continue; // ya símbolo-exacto
        const goldStem = stem(ref.file);
        const candidates = graph
          .nodeIdsBySymbolSuffix(ref.symbol)
          .filter((node) => stem(node.filepath) === goldStem);
        // Único match por símbolo+basename → reescribe la dirección del gold.
        const uniqueFiles = new Set(candidates.map((c) => c.filepath));
        if (uniqueFiles.size === 1) {
          const newRelFile = toRelativeNodeId(candidates[0]!.filepath, repoPath);
          if (newRelFile !== ref.file) {
            changes.push(`  ${task.id}: ${ref.file}#${ref.symbol} → ${newRelFile}#${ref.symbol}`);
            ref.file = newRelFile;
            symbolsReconciled += 1;
            taskChanged = true;
          }
        } else {
          unresolved += 1;
        }
      }
      if (taskChanged) {
        // La reescritura puede colisionar dos refs en el mismo file#symbol.
        const seen = new Set<string>();
        evidence.edited_symbols = evidence.edited_symbols.filter((ref) => {
          const key = `${ref.file}#${ref.symbol}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        tasksTouched += 1;
      }
    }
  } finally {
    for (const lookup of graphByRepo.values()) lookup?.close();
  }

  if (!options.dryRun && tasksTouched > 0) writeTasksManifest(manifestsDir, tasks);

  console.log(`Reconciliación gold-símbolo (run ${options.runId})${options.dryRun ? " [DRY-RUN]" : ""}:`);
  console.log(`  ${symbolsReconciled} símbolo(s) reescrito(s) a la identidad del grafo en ${tasksTouched} task(s)`);
  console.log(`  ${malformedDropped} símbolo(s) malformado(s) descartado(s)`);
  console.log(`  ${unresolved} símbolo(s) ausente(s) del grafo sin match único (se dejan igual)`);
  if (changes.length > 0) {
    console.log("  reescrituras:");
    for (const line of changes) console.log(line);
  }
  if (options.dryRun) console.log("  (dry-run: tasks.yaml NO reescrito)");
  else if (tasksTouched > 0) console.log(`  tasks.yaml reescrito: ${tasksPath}`);
  else console.log("  nada que reconciliar; tasks.yaml intacto");
}

if (isEntrypoint(import.meta.url)) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
