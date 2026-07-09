/**
 * analyze-hallucinations.ts
 *
 * Detector de alucinaciones para M2. Para cada GenerationRecord con
 * patch aplicado, carga el `patch.diff`, identifica archivos .ts
 * modificados, los parsea con ts-morph en el contexto del repo, y
 * cuenta:
 *   - invalid_calls:  call/new/method-access con `checker.getSymbolAtLocation` === undefined
 *   - unknown_calls:   tipos `any`, expresiones dinamicas, index access no resoluble
 *   - analyzable_calls: resto
 *
 * Salida: `hallucinations.jsonl` schema v1.
 *
 * Notas:
 *  - Para rxjs se usa `src/tsconfig.esm.json` (no hay `tsconfig.lacoco-eval.json`).
 *  - Limitacion: solo analiza archivos del patch, no el repo completo.
 *  - Si el patch no se puede aplicar (formato invalido), la cell queda
 *    sin entradas en hallucinations.jsonl (no se genera hallucination record).
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { parseEvalCliOptions, isEntrypoint } from "./lib/cli.js";
import { loadManifests } from "./lib/load-manifests.js";
import type { GenerationRecord } from "./lib/generation-record.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { PROJECT_ROOT, resolveManifestsDir } from "./lib/paths.js";
import { Project, SyntaxKind, type Node } from "ts-morph";

const HALLUCINATION_SCHEMA_VERSION = 1;

interface HallucinationRecord {
  schema_version: 1;
  run_id: string;
  task_id: string;
  repo_id: string;
  strategy_id: string;
  agent_id: string;
  files_analyzed: string[];
  invalid_calls: number;
  analyzable_calls: number;
  unknown_calls: number;
  invalid_symbols: Array<{ symbol: string; file: string; line: number }>;
  notes: string[];
}

function parseDiffFiles(diff: string): string[] {
  // Match `diff --git a/path/to/file b/path/to/file`
  const matches = diff.matchAll(/^diff --git a\/(.+?) b\/(.+?)$/gm);
  return [...matches].map((m) => m[1]!).filter((p) => p.endsWith(".ts") || p.endsWith(".tsx"));
}

function getTsConfigForRepo(repoId: string, repoPath: string): string | null {
  const candidates: string[] = [];
  if (repoId === "rxjs") {
    candidates.push("src/tsconfig.esm.json", "src/tsconfig.cjs.json");
  } else {
    candidates.push("tsconfig.lacoco-eval.json", "tsconfig.json");
  }
  for (const candidate of candidates) {
    const full = join(repoPath, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

function applyPatchInTempWorktree(repoPath: string, diff: string): string | null {
  const worktree = join(tmpdir(), `lacoco-m2-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(worktree, { recursive: true });
    // Clone the bare repo into a temp worktree (or use a worktree add)
    // Simpler: copy the repo (assumes no large files matter for this scope)
    execSync(`cp -a "${repoPath}/." "${worktree}/"`, { stdio: "pipe" });
    // Apply diff
    const patchFile = join(worktree, ".lacoco-m2.patch");
    writeFileSync(patchFile, diff, "utf8");
    execSync(`git apply --whitespace=nowarn "${patchFile}"`, { cwd: worktree, stdio: "pipe" });
    return worktree;
  } catch (error) {
    rmSync(worktree, { recursive: true, force: true });
    return null;
  }
}

function analyzeFile(
  filePath: string,
  project: Project,
): { invalid: number; unknown: number; analyzable: number; invalidSymbols: HallucinationRecord["invalid_symbols"] } {
  let invalid = 0;
  let unknown = 0;
  let analyzable = 0;
  const invalidSymbols: HallucinationRecord["invalid_symbols"] = [];

  const sourceFile = project.getSourceFile(filePath);
  if (sourceFile === undefined) {
    return { invalid, unknown, analyzable, invalidSymbols };
  }

  function visit(node: Node): void {
    const kind = node.getKind();
    if (kind === SyntaxKind.CallExpression) {
      const callExpr = node.asKindOrThrow(SyntaxKind.CallExpression);
      const expr = callExpr.getExpression();
      // Skip dynamic calls (e.g., obj[methodName]())
      if (expr.getKind() === SyntaxKind.ElementAccessExpression) {
        unknown += 1;
      } else {
        const symbol = callExpr.getExpression().getSymbol();
        if (symbol === undefined) {
          invalid += 1;
          const text = callExpr.getText().slice(0, 80);
          invalidSymbols.push({ symbol: text, file: filePath, line: callExpr.getStartLineNumber() });
        } else {
          analyzable += 1;
        }
      }
    } else if (kind === SyntaxKind.NewExpression) {
      const newExpr = node.asKindOrThrow(SyntaxKind.NewExpression);
      const symbol = newExpr.getExpression().getSymbol();
      if (symbol === undefined) {
        invalid += 1;
        invalidSymbols.push({ symbol: newExpr.getText().slice(0, 80), file: filePath, line: newExpr.getStartLineNumber() });
      } else {
        analyzable += 1;
      }
    } else if (kind === SyntaxKind.PropertyAccessExpression) {
      const prop = node.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
      // Only count top-level property accesses that look like method/field references
      // not as part of an lvalue in an assignment. We accept that we might overcount;
      // the type checker resolves it correctly.
      const parent = prop.getParent();
      if (parent && (parent.getKind() === SyntaxKind.CallExpression && parent.asKindOrThrow(SyntaxKind.CallExpression).getExpression() === prop)) {
        // Already counted as a call
      } else {
        const symbol = prop.getSymbol();
        if (symbol === undefined) {
          // Could be dynamic, skip rather than count as invalid
          unknown += 1;
        } else {
          analyzable += 1;
        }
      }
    }
    node.forEachChild(visit);
  }
  sourceFile.forEachChild(visit);

  return { invalid, unknown, analyzable, invalidSymbols };
}

export async function runHallucinationAnalysis(argv = process.argv.slice(2)): Promise<void> {
  const options = parseEvalCliOptions(argv, [
    "--run-id",
    "--manifests-dir",
  ]);
  const manifests = loadManifests(resolveManifestsDir(options.manifestsDir));
  const layout = resolveEvalLayout(manifests.run, options.runId);

  const generationPath = join(layout.runDirectory, "generation.jsonl");
  if (!existsSync(generationPath)) {
    throw new Error(`generation.jsonl not found at ${generationPath}; run eval:generation first`);
  }
  const lines = readFileSync(generationPath, "utf8").split("\n").filter((l) => l.trim().length > 0);
  const records: GenerationRecord[] = lines.map((l) => JSON.parse(l) as GenerationRecord);

  const outputPath = join(layout.runDirectory, "hallucinations.jsonl");
  writeFileSync(outputPath, "", "utf8");

  // Group by repo_id to share worktree
  const byRepo = new Map<string, GenerationRecord[]>();
  for (const r of records) {
    if (!r.patch_applied) continue;
    const list = byRepo.get(r.repo_id) ?? [];
    list.push(r);
    byRepo.set(r.repo_id, list);
  }

  for (const [repoId, repoRecords] of byRepo) {
    const repoDef = manifests.repos.repositories.find((r) => r.id === repoId);
    if (repoDef === undefined) {
      console.error(`repo ${repoId} not in manifest, skipping`);
      continue;
    }
    const repoPath = join(layout.reposDirectory, repoId);
    const tsconfig = getTsConfigForRepo(repoId, repoPath);
    if (tsconfig === null) {
      console.error(`no tsconfig found for ${repoId}, skipping ${repoRecords.length} records`);
      continue;
    }
    const notes: string[] = [];
    if (repoId === "rxjs") {
      notes.push("rxjs: usando src/tsconfig.esm.json; archivos fuera de src/internal/operators/ pueden no analizarse");
    }

    for (const rec of repoRecords) {
      const diffPath = isAbsolute(rec.artifact_paths.patch)
        ? rec.artifact_paths.patch
        : join(PROJECT_ROOT, rec.artifact_paths.patch);
      if (!existsSync(diffPath)) {
        console.error(`patch not found: ${diffPath}`);
        continue;
      }
      const diff = readFileSync(diffPath, "utf8");
      if (diff.length === 0) continue;

      const worktree = applyPatchInTempWorktree(repoPath, diff);
      if (worktree === null) {
        console.error(`failed to apply patch for ${rec.task_id} x ${rec.strategy_id} x ${rec.agent_id}`);
        continue;
      }

      try {
        const project = new Project({
          tsConfigFilePath: join(worktree, tsconfig.replace(`${repoPath}/`, "")),
          skipAddingFilesFromTsConfig: true,
        });
        // Add only the files from the diff
        const filesInDiff = parseDiffFiles(diff);
        for (const f of filesInDiff) {
          const abs = join(worktree, f);
          if (existsSync(abs)) {
            project.addSourceFileAtPath(abs);
          }
        }

        let invalid = 0;
        let unknown = 0;
        let analyzable = 0;
        const invalidSymbols: HallucinationRecord["invalid_symbols"] = [];

        for (const f of filesInDiff) {
          const result = analyzeFile(join(worktree, f), project);
          invalid += result.invalid;
          unknown += result.unknown;
          analyzable += result.analyzable;
          invalidSymbols.push(...result.invalidSymbols);
        }

        const hallRec: HallucinationRecord = {
          schema_version: HALLUCINATION_SCHEMA_VERSION,
          run_id: layout.runId,
          task_id: rec.task_id,
          repo_id: rec.repo_id,
          strategy_id: rec.strategy_id,
          agent_id: rec.agent_id,
          files_analyzed: filesInDiff,
          invalid_calls: invalid,
          analyzable_calls: analyzable,
          unknown_calls: unknown,
          invalid_symbols: invalidSymbols,
          notes,
        };
        appendFileSync(outputPath, `${JSON.stringify(hallRec)}\n`, "utf8");
        console.log(`  ${rec.task_id} x ${rec.strategy_id} x ${rec.agent_id}: invalid=${invalid} analyzable=${analyzable} unknown=${unknown} files=${filesInDiff.length}`);
      } finally {
        rmSync(worktree, { recursive: true, force: true });
      }
    }
  }

  console.log(`\nWrote ${outputPath}`);
}

if (isEntrypoint(import.meta.url)) {
  runHallucinationAnalysis().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
