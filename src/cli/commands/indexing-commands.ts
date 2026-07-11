import type { Command } from "commander";
import { GraphIndexer } from "../../indexer/graph-indexer.js";
import { VectorsIndexer } from "../../indexer/vectors-indexer.js";
import { PropositionsIndexer } from "../../indexer/propositions-indexer.js";
import { OllamaService } from "../../slms/ollama-service.js";
import {
  configureProjectStorage,
  markProjectIndexStatus,
  registerCurrentProject,
} from "../state/project-registry.js";
import { projectPathFromTsconfig, resolveDbPath, resolveLanceDbPath } from "../storage-paths.js";
import { resolveNumberConfig, resolveStringConfig } from "../config.js";

export function registerIndexingCommands(program: Command): void {
  program
    .command("index_graph <ruta-tsconfig>")
    .description("Extrae solo el grafo estructural en SQLite (sin embeddings ni watcher).")
    .option("-d, --db <path>", "Ruta al archivo SQLite de salida; por defecto paths.data/tensor.sqlite del proyecto")
    .option("-v, --verbose", "Imprime progreso detallado", false)
    .action((rutaTsconfig: string, options: { db?: string; verbose: boolean }) => {
      console.log("\n[CLI] Extrayendo grafo estructural...\n");
      console.log(`  tsconfig : ${rutaTsconfig}`);
      const projectPath = projectPathFromTsconfig(rutaTsconfig);
      const dbPath = resolveDbPath(projectPath, options.db);
      console.log(`  sqlite   : ${dbPath}\n`);
      registerCurrentProject(projectPath);
      configureProjectStorage(projectPath, { dbPath });

      try {
        new GraphIndexer(dbPath, rutaTsconfig).index();
        markProjectIndexStatus(projectPath, "completed");
      } catch (error) {
        markProjectIndexStatus(projectPath, "error");
        throw error;
      }
    });

  program
    .command("index_vectors <ruta-tsconfig>")
    .description("Genera embeddings semánticos en LanceDB directamente desde el AST (sin dependencia de SQLite).")
    .option("--lancedb <path>", "Ruta al directorio de LanceDB; por defecto paths.data/lancedb del proyecto")
    .option("-v, --verbose", "Imprime progreso detallado", false)
    .action(async (rutaTsconfig: string, options: { lancedb?: string; verbose: boolean }) => {
      console.log("\n[CLI] Indexando vectores semánticos...\n");
      console.log(`  tsconfig : ${rutaTsconfig}`);
      const projectPath = projectPathFromTsconfig(rutaTsconfig);
      const lanceDbPath = resolveLanceDbPath(projectPath, options.lancedb);
      console.log(`  lancedb  : ${lanceDbPath}\n`);
      registerCurrentProject(projectPath);
      configureProjectStorage(projectPath, { lanceDbPath });

      try {
        await new VectorsIndexer(lanceDbPath, rutaTsconfig).index();
        markProjectIndexStatus(projectPath, "completed");
      } catch (error) {
        markProjectIndexStatus(projectPath, "error");
        throw error;
      }
    });

  program
    .command("index_propositions <ruta-tsconfig>")
    .description("Canal doc-side C2: genera proposiciones (SLM) por nodo y las embebe en la tabla LanceDB node_propositions (opt-in; no toca node_embeddings).")
    .option("--lancedb <path>", "Ruta al directorio de LanceDB; por defecto paths.data/lancedb del proyecto")
    .option("--ollama <url>", "Endpoint de Ollama; por defecto agent.endpoint")
    .action(async (rutaTsconfig: string, options: { lancedb?: string; ollama?: string }) => {
      console.log("\n[CLI] Indexando proposiciones (C2)...\n");
      console.log(`  tsconfig : ${rutaTsconfig}`);
      const projectPath = projectPathFromTsconfig(rutaTsconfig);
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
        await new PropositionsIndexer(lanceDbPath, rutaTsconfig, ollama, concurrency).index();
      } finally {
        ollama.abort();
      }
    });
}
