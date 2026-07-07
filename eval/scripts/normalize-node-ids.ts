/**
 * normalize-node-ids.ts — normaliza los node_id de un retrieval.jsonl producido
 * sobre checkouts AISLADOS (worktrees) para que coincidan con el gold.
 *
 * El gold se resuelve contra el `reposDirectory` fijo (eval/workdir/repos/{repo}),
 * y las métricas comparan node_id por igualdad exacta de ruta absoluta. Cuando el
 * retrieval corrió sobre un worktree (p. ej. eval/workdir/repos-jina/{repo}), sus
 * node_id llevan ese prefijo y no matchean. Este script reescribe el prefijo del
 * repoPath de cada repo (del lock del run) hacia su ruta canónica en
 * eval/workdir/repos/{repo}, dejando el retrieval.jsonl CRUDO intacto y
 * escribiendo un archivo aparte (default retrieval.normalized.jsonl).
 *
 * Correcto porque el worktree y el checkout canónico son el mismo commit.
 *
 * Uso:
 *   node --import tsx eval/scripts/normalize-node-ids.ts --run-dir eval/runs/<id>
 *   [--input retrieval.jsonl] [--output retrieval.normalized.jsonl]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { isEntrypoint } from "./lib/cli.js";
import { readRepositoriesLock } from "./lib/repo-lock.js";
import { PROJECT_ROOT } from "./lib/paths.js";

interface Options {
  runDir: string;
  input: string;
  output: string;
}

function parse(argv: string[]): Options {
  let runDir: string | undefined;
  let input = "retrieval.jsonl";
  let output = "retrieval.normalized.jsonl";
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i + 1];
    if (argv[i] === "--run-dir") { runDir = value; i += 1; }
    else if (argv[i] === "--input") { input = value!; i += 1; }
    else if (argv[i] === "--output") { output = value!; i += 1; }
    else throw new Error(`unknown argument: ${String(argv[i])}`);
  }
  if (runDir === undefined) throw new Error("--run-dir is required");
  return { runDir, input, output };
}

/** Ruta canónica del repo en eval/workdir/repos/{id}. */
function canonicalRepoPath(repoPath: string): string {
  return repoPath.replace(/\/eval\/workdir\/repos-[^/]+\//u, "/eval/workdir/repos/");
}

export function normalizeNodeIds(argv = process.argv.slice(2)): void {
  const options = parse(argv);
  const runDir = resolve(PROJECT_ROOT, options.runDir);

  // Reemplazos derivados del lock: repoPath (worktree) → ruta canónica.
  const lock = readRepositoriesLock(join(runDir, "repos.lock.json"));
  const replacements = lock.repositories
    .map((r) => ({ from: r.repoPath, to: canonicalRepoPath(r.repoPath) }))
    .filter(({ from, to }) => from !== to);

  if (replacements.length === 0) {
    console.log("Nada que normalizar: los repoPath ya son canónicos.");
  }

  const inputPath = join(runDir, options.input);
  const lines = readFileSync(inputPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  let rewritten = 0;
  const out = lines.map((line) => {
    let next = line;
    for (const { from, to } of replacements) {
      if (next.includes(from)) {
        next = next.split(from).join(to);
        rewritten += 1;
      }
    }
    return next;
  });

  const outputPath = join(runDir, options.output);
  writeFileSync(outputPath, `${out.join("\n")}\n`, "utf8");
  console.log(`Normalizado: ${outputPath} (${lines.length} registros, ${rewritten} reescrituras de prefijo)`);
  console.log(`Crudo intacto: ${inputPath}`);
}

if (isEntrypoint(import.meta.url)) {
  try {
    normalizeNodeIds();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
