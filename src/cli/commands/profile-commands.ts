import type { Command } from "commander";
import { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { OllamaService } from "../../slms/ollama-service.js";
import { DeterministicTermExtractor } from "../../semantic-profile/deterministic-term-extractor.js";
import { computeEvidenceRevision, SemanticProfileBuilder } from "../../semantic-profile/semantic-profile-builder.js";
import { SemanticProfileStore } from "../../semantic-profile/semantic-profile-store.js";
import { QueryGrounder } from "../../semantic-profile/query-grounder.js";
import { resolveDbPath } from "../storage-paths.js";
import { inspectProject } from "../state/project-registry.js";
import { resolveNumberConfig, resolveStringConfig } from "../config.js";
import { runCliCommand } from "./common.js";

interface JsonOptions { json: boolean; }
interface RebuildOptions extends JsonOptions { ollama?: string; }
interface GroundOptions extends JsonOptions { limit: number; }
interface StatusOptions extends JsonOptions { verify: boolean; }

export function registerProfileCommands(program: Command): void {
  const profile = program
    .command("profile")
    .description("Construye e inspecciona el Project Semantic Profile.");

  profile
    .command("rebuild [project]")
    .description("Reconstruye atómicamente el perfil semántico usando Ollama local.")
    .option("--ollama <url>", "Endpoint de Ollama; por defecto agent.endpoint")
    .option("--json", "Imprime JSON válido", false)
    .action((project: string | undefined, options: RebuildOptions) => {
      runCliCommand(() => rebuildProfile(project, options));
    });

  profile
    .command("ground [project] <query>")
    .description("Recupera candidatos semánticos sin ejecutar clasificación ni retrieval.")
    .option("--limit <number>", "Máximo de candidatos", parsePositiveInteger, 20)
    .option("--json", "Imprime JSON válido", false)
    .action((project: string | undefined, query: string, options: GroundOptions) => {
      runCliCommand(() => groundProfile(project, query, options));
    });

  profile
    .command("status [project]")
    .description("Muestra el estado del perfil semántico.")
    .option("--verify", "Recalcula el fingerprint de evidencias", false)
    .option("--json", "Imprime JSON válido", false)
    .action((project: string | undefined, options: StatusOptions) => {
      runCliCommand(() => profileStatus(project, options));
    });
}

async function rebuildProfile(project: string | undefined, options: RebuildOptions): Promise<void> {
  const projectPath = resolveProjectPath(project);
  const db = new LaCoCoDatabase(resolveDbPath(projectPath));
  const endpoint = options.ollama ?? resolveStringConfig("agent.endpoint");
  const model = resolveStringConfig("agent.model");
  const concurrency = resolveNumberConfig("profile.enrichConcurrency");
  // Bajo contención (K>1) una llamada puede tardar más que el default de 30s;
  // ponemos piso a 120s para no abortar por timeout. El default se mantiene para
  // el resto de chats interactivos (no tocamos timeout.ms global).
  const timeoutMs = concurrency > 1
    ? Math.max(resolveNumberConfig("timeout.ms"), 120_000)
    : resolveNumberConfig("timeout.ms");
  const ollama = new OllamaService(endpoint, model, timeoutMs);
  try {
    const result = await new SemanticProfileBuilder(db.getRawDb(), projectPath, ollama, model, concurrency).rebuild();
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ok: true, ...result }, null, 2)}\n`);
    } else {
      console.log(
        `Perfil semántico listo: ${result.termCount} términos, ${result.aliasCount} aliases ` +
        `(build ${result.buildId})`,
      );
    }
  } finally {
    ollama.abort();
    db.close();
  }
}

function groundProfile(project: string | undefined, query: string, options: GroundOptions): void {
  const projectPath = resolveProjectPath(project);
  const db = new LaCoCoDatabase(resolveDbPath(projectPath));
  try {
    const grounding = new QueryGrounder(new SemanticProfileStore(db.getRawDb())).ground(query, {
      topTerms: options.limit,
    });
    const result = { schemaVersion: 1, query, ...grounding };
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return;
    }
    console.log(`Grounding: ${grounding.candidates.length} candidatos (${grounding.durationMs.toFixed(1)} ms)`);
    for (const candidate of grounding.candidates) {
      const match = candidate.matchedAliases.length > 0
        ? ` <- ${candidate.matchedAliases.join(", ")}`
        : "";
      console.log(`- ${candidate.canonicalTerm}${match} [${candidate.domains.map(({ name }) => name).join(", ")}]`);
    }
  } finally {
    db.close();
  }
}

function profileStatus(project: string | undefined, options: StatusOptions): void {
  const projectPath = resolveProjectPath(project);
  const db = new LaCoCoDatabase(resolveDbPath(projectPath));
  try {
    const store = new SemanticProfileStore(db.getRawDb());
    if (options.verify) {
      const terms = new DeterministicTermExtractor(db.getRawDb(), projectPath).extract();
      const current = computeEvidenceRevision(terms.map(({ sourceHash }) => sourceHash));
      const state = store.getState();
      if (state.evidenceRevision !== current) store.markStale();
    }
    const state = store.getState();
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ schemaVersion: 1, ...state }, null, 2)}\n`);
    } else {
      console.log(`Project Semantic Profile: ${state.status}`);
      console.log(`Build: ${state.activeBuildId ?? "-"}`);
      console.log(`Actualizado: ${state.updatedAt}`);
      if (state.lastError) console.log(`Error: ${state.lastError}`);
    }
  } finally {
    db.close();
  }
}

function resolveProjectPath(project?: string): string {
  if (!project) return process.cwd();
  try {
    return inspectProject(project).path;
  } catch {
    return project;
  }
}

function parsePositiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error("--limit debe ser un entero positivo");
  return parsed;
}
