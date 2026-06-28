import type { Command } from "commander";
import { GraphIndexer } from "../../indexer/graph-indexer.js";
import { VectorsIndexer } from "../../indexer/vectors-indexer.js";
import {
  configureProjectStorage,
  markProjectIndexStatus,
  registerCurrentProject,
} from "../state/project-registry.js";
import { projectPathFromTsconfig, resolveDbPath, resolveLanceDbPath } from "../storage-paths.js";

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
}
