/**
 * Genera los splits `bench10_mh` (multi-hop) y `bench10_sh` (single-hop) del bundle
 * de 10 repos, partiendo las tasks por el número de SÍMBOLOS editados del gold:
 *   - `edited_symbols.length >= 2` → multi-hop  (el fix toca ≥2 símbolos conectados;
 *     régimen donde `connector`/SCR debe batir a los baselines).
 *   - `edited_symbols.length === 1` → single-hop (control; los baselines empatan).
 *   - `edited_symbols.length === 0` → file-level puro (pura adición / no resoluble):
 *     se EXCLUYE de ambos splits (no tiene conteo de hops limpio) y se reporta.
 *
 * Debe correr DESPUÉS de `enrich-gold-symbols` (que rellena `edited_symbols` de los
 * repos Multi-SWE-bench) para que el conteo sea uniforme entre datasets. Reescribe
 * SOLO los dos splits vía `parseDocument` (preserva el resto de run.yaml y sus
 * comentarios). Idempotente.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";

import { resolveManifestsDir } from "./lib/paths.js";
import { isEntrypoint } from "./lib/cli.js";
import type { TaskDefinition } from "./lib/types.js";

const STRATEGIES_8 = ["hybrid", "ictd", "clcr", "rpr", "consensus", "repograph", "ppr", "connector"];

interface Options {
  manifestsDir?: string;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1];
    if (arg === "--manifests-dir") {
      if (value === undefined) throw new Error("--manifests-dir requires a value");
      options.manifestsDir = value;
      i += 1;
    } else {
      throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return options;
}

function splitBody(description: string, ids: string[]): Record<string, unknown> {
  return {
    description,
    require_gold_status: "ready",
    sanitizer_variants: ["deterministic"],
    repo_ids: ids,
    task_ids: ids,
    strategies: STRATEGIES_8,
  };
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const manifestsDir = resolveManifestsDir(options.manifestsDir);
  if (manifestsDir === undefined) {
    throw new Error("--manifests-dir (o LACOCO_EVAL_MANIFESTS_DIR) es obligatorio: escribe los splits en un bundle, no en el canónico eval/manifests");
  }

  const tasksPath = join(manifestsDir, "tasks.yaml");
  const doc = parse(readFileSync(tasksPath, "utf8")) as { tasks?: TaskDefinition[] } | null;
  const tasks = doc?.tasks ?? [];
  if (tasks.length === 0) throw new Error(`no tasks in ${tasksPath}`);

  const mh: string[] = [];
  const sh: string[] = [];
  const fileLevel: string[] = [];
  const perRepo = new Map<string, { mh: number; sh: number; fl: number }>();

  for (const task of tasks) {
    if (task.gold?.status !== "ready") continue;
    const evidence = task.gold.patch_evidence;
    if (evidence === undefined) continue;
    const repo = Array.isArray(task.tags) ? String(task.tags[task.tags.length - 1]) : "?";
    const bucket = perRepo.get(repo) ?? { mh: 0, sh: 0, fl: 0 };
    const n = evidence.edited_symbols.length;
    if (n >= 2) {
      mh.push(task.id);
      bucket.mh += 1;
    } else if (n === 1) {
      sh.push(task.id);
      bucket.sh += 1;
    } else {
      fileLevel.push(task.id);
      bucket.fl += 1;
    }
    perRepo.set(repo, bucket);
  }

  mh.sort();
  sh.sort();

  const runPath = join(manifestsDir, "run.yaml");
  const runDoc = parseDocument(readFileSync(runPath, "utf8"));
  runDoc.setIn(
    ["splits", "bench10_mh"],
    splitBody("10 repos, MULTI-HOP (fix toca >=2 símbolos): régimen donde connector/SCR separa.", mh),
  );
  runDoc.setIn(
    ["splits", "bench10_sh"],
    splitBody("10 repos, SINGLE-HOP (fix toca 1 símbolo): control, los baselines empatan.", sh),
  );
  writeFileSync(runPath, runDoc.toString(), "utf8");

  const repos = [...perRepo.keys()].sort();
  console.log(`Splits bench10 generados en ${runPath} (por # de edited_symbols):`);
  console.log(`  bench10_mh: ${mh.length} task(s) multi-hop (>=2 símbolos)`);
  console.log(`  bench10_sh: ${sh.length} task(s) single-hop (1 símbolo)`);
  console.log(`  excluidas (file-level, 0 símbolos): ${fileLevel.length}`);
  console.log(`Repos distintos con tareas: ${repos.length}`);
  for (const repo of repos) {
    const b = perRepo.get(repo)!;
    console.log(`    ${repo.padEnd(28)} mh=${b.mh} sh=${b.sh} file-level=${b.fl}`);
  }
  if (repos.length < 10) {
    console.warn(`AVISO: solo ${repos.length} repos distintos (<10). Importa más repos para la tesis.`);
  }
  if (mh.length < 30) {
    console.warn(`AVISO: solo ${mh.length} tareas multi-hop (<30). Sube la profundidad por repo.`);
  }
}

if (isEntrypoint(import.meta.url)) {
  try {
    main();
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
