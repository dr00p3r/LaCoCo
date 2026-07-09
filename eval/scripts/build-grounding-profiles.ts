/**
 * Frente A — setup del A/B de grounding (semantic_profile_ab).
 *
 * Cierra el "gap crítico" del plan, pero con la corrección de diagnóstico hecha
 * en esta sesión (2026-07-06):
 *
 *   El plan asumía que había que indexar el grafo *in-place* en `.lacoco` antes
 *   de `profile rebuild`. FALSO en el estado actual: el registro de proyectos
 *   (`~/.local/state/lacoco/projects.json`) ya redirige `resolveDbPath(repoPath)`
 *   de cada repo a su índice del eval, y esos índices YA tienen el grafo
 *   (nodes>0). Lo que falta es que NADIE ha corrido `profile rebuild`, así que
 *   `semantic_terms=0` y `state=missing` → el `QueryGrounder` sale vacío y
 *   `grounded ≈ baseline` en silencio.
 *
 * Este script, para cada repo del lock indicado:
 *   1. Resuelve el db vía `resolveDbPath(repoPath)` (mismo que usa el grounder).
 *   2. Verifica que el grafo existe (nodes>0); si no, aborta con instrucción.
 *   3. Corre `SemanticProfileBuilder.rebuild()` (usa Ollama = agent.model).
 *   4. Verifica `semantic_terms>0` y `state=ready`.
 *   5. Smoke-test: corre `QueryGrounder.ground(prompt)` con el prompt real de una
 *      tarea del A/B y exige `candidates>0` (prueba de que grounded NO será igual
 *      a baseline).
 *
 * El perfil es text-based e independiente del embedding: NO requiere env de Jina.
 * Jina solo afecta el índice de *ranking* (lancedb), ya construido.
 *
 * Uso (correr con `!` si el classifier bloquea; es un job largo con Ollama):
 *   npm run eval:grounding:profiles -- --lock 2026-07-05-jina-code
 *   npm run eval:grounding:profiles -- --lock 2026-07-05-jina-code --repo-id zod
 *   npm run eval:grounding:profiles -- --lock 2026-07-05-jina-code --verify-only
 *
 * El enriquecedor es una tarea SEMÁNTICA (alias/dominios/descripción), no de
 * código: qwen2.5-coder:1.5b (agent.model) entra en bucle e ignora IDs. Usar un
 * instruct 7B+ vía --model (solo afecta la construcción offline del perfil):
 *   npm run eval:grounding:profiles -- --lock 2026-07-05-jina-code --repo-id zod --model qwen2.5:7b-instruct
 */
import { existsSync } from "node:fs";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { OllamaService } from "../../src/slms/ollama-service.js";
import { SemanticProfileBuilder } from "../../src/semantic-profile/semantic-profile-builder.js";
import { SemanticProfileStore } from "../../src/semantic-profile/semantic-profile-store.js";
import { QueryGrounder } from "../../src/semantic-profile/query-grounder.js";
import { resolveDbPath } from "../../src/cli/storage-paths.js";
import { resolveNumberConfig, resolveStringConfig } from "../../src/cli/config.js";
import { readRepositoriesLock } from "./lib/repo-lock.js";
import { loadManifests } from "./lib/load-manifests.js";
import { resolveEvalLayout } from "./lib/layout.js";
import { resolveManifestsDir } from "./lib/paths.js";
import { resolveGroundingProfile } from "./lib/grounding-profile.js";
import { isEntrypoint } from "./lib/cli.js";
import type { TaskDefinition } from "./lib/types.js";

interface Options {
  lockRunId: string;
  repoId?: string;
  verifyOnly: boolean;
  model?: string;
  concurrency?: number;
  manifestsDir?: string;
}

function parseOptions(argv: string[]): Options {
  let lockRunId: string | undefined;
  let repoId: string | undefined;
  let verifyOnly = false;
  let model: string | undefined;
  let concurrency: number | undefined;
  let manifestsDir: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--lock" || arg === "--lock-run-id") { lockRunId = argv[++i]; continue; }
    if (arg === "--repo-id") { repoId = argv[++i]; continue; }
    if (arg === "--model") { model = argv[++i]; continue; }
    if (arg === "--manifests-dir") { manifestsDir = argv[++i]; continue; }
    if (arg === "--concurrency") {
      concurrency = Number(argv[++i]);
      if (!Number.isInteger(concurrency) || concurrency <= 0) {
        throw new Error("--concurrency debe ser un entero positivo");
      }
      continue;
    }
    if (arg === "--verify-only") { verifyOnly = true; continue; }
    throw new Error(`unknown argument: ${String(arg)}`);
  }
  if (!lockRunId) throw new Error("required: --lock <run-id> (p.ej. 2026-07-05-jina-code)");
  return {
    lockRunId,
    ...(repoId ? { repoId } : {}),
    verifyOnly,
    ...(model ? { model } : {}),
    ...(concurrency ? { concurrency } : {}),
    ...(manifestsDir ? { manifestsDir } : {}),
  };
}

function countNodes(db: LaCoCoDatabase): number {
  return (db.getRawDb().prepare("SELECT count(*) AS c FROM nodes").get() as { c: number }).c;
}

function countSemanticTerms(db: LaCoCoDatabase): number {
  try {
    return (db.getRawDb().prepare("SELECT count(*) AS c FROM semantic_terms").get() as { c: number }).c;
  } catch {
    return 0;
  }
}

/** Primer prompt de una tarea A/B para el repo, como carga real del smoke-test. */
function sampleTaskPrompt(tasks: TaskDefinition[], repoId: string): string | undefined {
  const task = tasks.find((t) => t.repo_id === repoId && t.gold?.status === "ready");
  return task?.prompt;
}

export async function buildGroundingProfiles(argv = process.argv.slice(2)): Promise<void> {
  const options = parseOptions(argv);
  const manifests = loadManifests(resolveManifestsDir(options.manifestsDir));
  const layout = resolveEvalLayout(manifests.run, options.lockRunId);
  if (!existsSync(layout.lockFile)) {
    throw new Error(`lock no existe: ${layout.lockFile}`);
  }
  const lock = readRepositoriesLock(layout.lockFile);
  const repos = lock.repositories.filter((r) => !options.repoId || r.id === options.repoId);
  if (repos.length === 0) throw new Error(`el lock no tiene repos que coincidan con ${String(options.repoId)}`);

  const tasks = (manifests.tasks.tasks ?? []) as TaskDefinition[];
  const endpoint = resolveStringConfig("agent.endpoint");
  // El enriquecedor produce vocabulario de búsqueda (alias es/en, dominios,
  // descripción) — tarea SEMÁNTICA, no de código. qwen2.5-coder:1.5b (agent.model)
  // entra en bucle de repetición e ignora los IDs; un instruct 7B+ lo hace bien.
  // Este modelo SOLO afecta la construcción offline del perfil; el QueryGrounder en
  // tiempo de consulta es determinista, así que el A/B de retrieval no se ve alterado.
  const model = options.model ?? resolveStringConfig("agent.model");
  // Concurrencia de lotes de enriquecimiento. --concurrency pisa el run.yaml.
  // Requiere OLLAMA_NUM_PARALLEL>=este valor en el server; solo acelera el build,
  // no altera la salida del perfil.
  const enrichConcurrency = options.concurrency ?? resolveGroundingProfile(manifests.run).enrichConcurrency;
  // El enriquecedor genera JSON estructurado en CPU; una sola llamada de lote
  // puede tardar minutos. El timeout interactivo por defecto (30s) la aborta
  // ("This operation was aborted"). Piso generoso para el batch, respetando un
  // override mayor vía LACOCO_TIMEOUT_MS.
  const timeoutMs = Math.max(resolveNumberConfig("timeout.ms"), 600_000);

  console.log(`Lock: ${layout.lockFile} (runId=${lock.runId})`);
  console.log(`Modo: ${options.verifyOnly ? "verify-only" : "rebuild + verify"}`);
  console.log(`Ollama: ${endpoint} model=${model} concurrency=${enrichConcurrency}`);
  console.log(`Repos: ${repos.map((r) => r.id).join(", ")}\n`);

  const results: Array<{ id: string; nodes: number; terms: number; state: string; groundCandidates: number | "—" }> = [];
  const failures: string[] = [];

  for (const repo of repos) {
    const dbPath = resolveDbPath(repo.repoPath);
    console.log(`\n=== ${repo.id} ===`);
    console.log(`  repoPath: ${repo.repoPath}`);
    console.log(`  db (resolveDbPath): ${dbPath}`);
    if (!existsSync(dbPath)) {
      failures.push(`${repo.id}: db no existe (${dbPath}); corre eval:index para este lock primero`);
      console.error(`  ✗ db no existe`);
      continue;
    }

    const db = new LaCoCoDatabase(dbPath);
    try {
      const nodes = countNodes(db);
      console.log(`  nodes en grafo: ${nodes}`);
      if (nodes === 0) {
        failures.push(`${repo.id}: grafo vacío (nodes=0) en ${dbPath}; corre index_graph/eval:index antes de rebuild`);
        console.error(`  ✗ grafo vacío — no se puede construir el perfil`);
        continue;
      }

      if (!options.verifyOnly) {
        const ollama = new OllamaService(endpoint, model, timeoutMs);
        try {
          if (!(await ollama.isAvailable())) {
            throw new Error(`Ollama no disponible en ${endpoint}`);
          }
          console.log(`  construyendo perfil (Ollama, puede tardar)...`);
          const started = performance.now();
          const result = await new SemanticProfileBuilder(db.getRawDb(), repo.repoPath, ollama, model, enrichConcurrency).rebuild();
          const secs = ((performance.now() - started) / 1000).toFixed(1);
          console.log(`  ✓ rebuild: ${result.termCount} términos, ${result.aliasCount} aliases (${secs}s)`);
        } finally {
          ollama.abort();
        }
      }

      // Verificación de validez (el gate que evita grounded≈baseline en silencio).
      const terms = countSemanticTerms(db);
      const store = new SemanticProfileStore(db.getRawDb());
      const state = store.getState();
      console.log(`  semantic_terms=${terms} state=${state.status}`);

      let groundCandidates: number | "—" = "—";
      const prompt = sampleTaskPrompt(tasks, repo.id);
      if (terms > 0 && state.status === "ready" && prompt) {
        try {
          const grounding = new QueryGrounder(store).ground(prompt);
          groundCandidates = grounding.candidates.length;
          console.log(`  smoke ground("${prompt.slice(0, 48)}…"): ${groundCandidates} candidatos`);
          if (groundCandidates === 0) {
            failures.push(`${repo.id}: grounding devolvió 0 candidatos con un prompt real → grounded≈baseline`);
          }
        } catch (error) {
          failures.push(`${repo.id}: ground() lanzó ${error instanceof Error ? error.message : String(error)}`);
        }
      } else if (terms === 0 || state.status !== "ready") {
        failures.push(`${repo.id}: perfil no listo (terms=${terms}, state=${state.status})`);
      }

      results.push({ id: repo.id, nodes, terms, state: state.status, groundCandidates });
    } finally {
      db.close();
    }
  }

  console.log(`\n===== RESUMEN grounding profiles =====`);
  console.log(`${"repo".padEnd(12)} ${"nodes".padStart(6)} ${"terms".padStart(6)} ${"state".padEnd(9)} ground`);
  for (const r of results) {
    console.log(`${r.id.padEnd(12)} ${String(r.nodes).padStart(6)} ${String(r.terms).padStart(6)} ${r.state.padEnd(9)} ${r.groundCandidates}`);
  }
  if (failures.length > 0) {
    console.error(`\n✗ ${failures.length} problema(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    throw new Error("setup de grounding incompleto — ver arriba");
  }
  console.log(`\n✓ Perfiles listos y verificados. El split semantic_profile_ab ya puede correr grounded != baseline.`);
}

if (isEntrypoint(import.meta.url)) {
  buildGroundingProfiles().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
