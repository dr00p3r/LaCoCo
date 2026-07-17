import type { Command } from "commander";
import { GraphIndexer } from "../../indexer/graph-indexer.js";
import { resolveIndexTarget, type IndexTarget } from "../../indexer/tsconfig-discovery.js";
import { VectorsIndexer } from "../../indexer/vectors-indexer.js";
import { PropositionsIndexer } from "../../indexer/propositions-indexer.js";
import { OllamaService } from "../../slms/ollama-service.js";
import {
  configureProjectStorage,
  markProjectIndexStatus,
  registerCurrentProject,
} from "../state/project-registry.js";
import { resolveDbPath, resolveLanceDbPath } from "../storage-paths.js";
import { resolveNumberConfig, resolveStringConfig } from "../config.js";
import { createIndexingHud, resolveHudEnabled, type IndexingHud } from "../banner/indexing-hud.js";
import type { IndexProgress } from "../../indexer/progress.js";

interface IndexCliOptions {
  db?: string;
  lancedb?: string;
  projectDir?: string;
  verbose: boolean;
  /** commander mapea `--no-animation` a `animation: false` (por defecto true). */
  animation?: boolean;
}

interface PropositionsCliOptions {
  lancedb?: string;
  ollama?: string;
  projectDir?: string;
}

export function registerIndexingCommands(program: Command): void {
  program
    .command("index_graph [ruta-tsconfig-o-proyecto]")
    .description("Extrae solo el grafo estructural en SQLite desde un tsconfig o repo multi-servicio.")
    .option("-d, --db <path>", "Ruta al archivo SQLite de salida; por defecto paths.data/tensor.sqlite del proyecto")
    .option("-p, --project-dir <path>", "Directorio raiz del proyecto multi-servicio a indexar")
    .option("-v, --verbose", "Imprime progreso detallado", false)
    .option("--no-animation", "Desactiva la animación del banner de indexación")
    .action(async (inputPath: string | undefined, options: IndexCliOptions) => {
      console.log("\n[CLI] Extrayendo grafo estructural...\n");
      const target = resolveCliIndexTarget(inputPath, options.projectDir);
      printTarget(target);
      const projectPath = target.projectPath;
      const dbPath = resolveDbPath(projectPath, options.db);
      console.log(`  sqlite   : ${dbPath}\n`);
      registerCurrentProject(projectPath);
      configureProjectStorage(projectPath, { dbPath });

      try {
        await withHud(options.animation === false, "Extrayendo grafo estructural…", (onProgress) => {
          new GraphIndexer(dbPath, target.tsconfigPaths, onProgress).index();
        });
        markProjectIndexStatus(projectPath, "completed");
      } catch (error) {
        markProjectIndexStatus(projectPath, "error");
        throw error;
      }
    });

  program
    .command("index_vectors [ruta-tsconfig-o-proyecto]")
    .description("Genera embeddings semánticos en LanceDB desde un tsconfig o repo multi-servicio.")
    .option("--lancedb <path>", "Ruta al directorio de LanceDB; por defecto paths.data/lancedb del proyecto")
    .option("-p, --project-dir <path>", "Directorio raiz del proyecto multi-servicio a indexar")
    .option("-v, --verbose", "Imprime progreso detallado", false)
    .option("--no-animation", "Desactiva la animación del banner de indexación")
    .action(async (inputPath: string | undefined, options: IndexCliOptions) => {
      console.log("\n[CLI] Indexando vectores semánticos...\n");
      const target = resolveCliIndexTarget(inputPath, options.projectDir);
      printTarget(target);
      const projectPath = target.projectPath;
      const lanceDbPath = resolveLanceDbPath(projectPath, options.lancedb);
      console.log(`  lancedb  : ${lanceDbPath}\n`);
      registerCurrentProject(projectPath);
      configureProjectStorage(projectPath, { lanceDbPath });

      try {
        await withHud(options.animation === false, "Indexando vectores semánticos…", (onProgress) =>
          new VectorsIndexer(lanceDbPath, target.tsconfigPaths, undefined, onProgress).index(),
        );
        markProjectIndexStatus(projectPath, "completed");
      } catch (error) {
        markProjectIndexStatus(projectPath, "error");
        throw error;
      }
    });

  program
    .command("index_propositions [ruta-tsconfig-o-proyecto]")
    .description("Canal doc-side C2: genera proposiciones (SLM) por nodo y las embebe en la tabla LanceDB node_propositions (opt-in; no toca node_embeddings).")
    .option("--lancedb <path>", "Ruta al directorio de LanceDB; por defecto paths.data/lancedb del proyecto")
    .option("--ollama <url>", "Endpoint de Ollama; por defecto agent.endpoint")
    .option("-p, --project-dir <path>", "Directorio raiz del proyecto multi-servicio a indexar")
    .action(async (inputPath: string | undefined, options: PropositionsCliOptions) => {
      console.log("\n[CLI] Indexando proposiciones (C2)...\n");
      const target = resolveCliIndexTarget(inputPath, options.projectDir);
      printTarget(target);
      const projectPath = target.projectPath;
      const lanceDbPath = resolveLanceDbPath(projectPath, options.lancedb);
      console.log(`  lancedb  : ${lanceDbPath}\n`);
      registerCurrentProject(projectPath);
      configureProjectStorage(projectPath, { lanceDbPath });

      const endpoint = options.ollama ?? resolveStringConfig("agent.endpoint");
      const model = resolveStringConfig("agent.model");
      const concurrency = resolveNumberConfig("profile.enrichConcurrency");
      const timeoutMs = concurrency > 1
        ? Math.max(resolveNumberConfig("timeout.ms"), 120_000)
        : resolveNumberConfig("timeout.ms");
      const ollama = new OllamaService(endpoint, model, timeoutMs);
      try {
        await new PropositionsIndexer(lanceDbPath, target.tsconfigPaths, ollama, concurrency).index();
      } finally {
        ollama.abort();
      }
    });
}

/**
 * Envuelve una fase de indexación con el HUD animado (perrito + "LaCoCo" +
 * barra de progreso). En salida no interactiva el HUD queda inerte y no emite
 * escapes. `hud.stop()` en el `finally` garantiza restaurar el cursor incluso
 * si la indexación lanza. El `onProgress` que recibe `run` alimenta la barra.
 */
async function withHud(
  noAnimation: boolean,
  phase: string,
  run: (onProgress: IndexProgress) => void | Promise<void>,
): Promise<void> {
  const hud: IndexingHud = createIndexingHud({
    enabled: resolveHudEnabled(noAnimation, process.stderr),
  });
  hud.start({ phase });
  try {
    await run((event) => hud.update(event));
  } finally {
    hud.stop();
  }
}

function resolveCliIndexTarget(inputPath: string | undefined, projectDir: string | undefined): IndexTarget {
  if (inputPath !== undefined && projectDir !== undefined) {
    throw new Error("Usa una sola ruta de indexacion: argumento posicional o --project-dir, no ambos.");
  }

  const targetPath = projectDir ?? inputPath;
  if (targetPath === undefined) {
    throw new Error("Debes indicar un tsconfig o un directorio de proyecto. Ej: lacoco index_graph --project-dir ./repo");
  }

  return resolveIndexTarget(targetPath);
}

function printTarget(target: IndexTarget): void {
  console.log(`  entrada   : ${target.inputPath}`);
  console.log(`  modo      : ${target.kind}`);
  console.log(`  tsconfigs : ${target.tsconfigPaths.length}`);
  for (const tsconfigPath of target.tsconfigPaths) {
    console.log(`    - ${tsconfigPath}`);
  }
}
