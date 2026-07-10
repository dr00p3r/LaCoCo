import type { Command } from "commander";
import { GraphIndexer } from "../../indexer/graph-indexer.js";
import { resolveIndexTarget } from "../../indexer/tsconfig-discovery.js";
import { VectorsIndexer } from "../../indexer/vectors-indexer.js";
import {
  configureProjectStorage,
  markProjectIndexStatus,
  registerCurrentProject,
} from "../state/project-registry.js";
import { resolveDbPath, resolveLanceDbPath } from "../storage-paths.js";

export function registerIndexingCommands(program: Command): void {
  program
    .command("index_graph <ruta-tsconfig-o-proyecto>")
    .description("Extrae el grafo estructural en SQLite desde un tsconfig o repo multi-servicio.")
    .option("-d, --db <path>", "Ruta al archivo SQLite de salida; por defecto paths.data/tensor.sqlite del proyecto")
    .option("-v, --verbose", "Imprime progreso detallado", false)
    .action((rutaTsconfigOProyecto: string, options: { db?: string; verbose: boolean }) => {
      console.log("\n[CLI] Extrayendo grafo estructural...\n");
      const target = resolveIndexTarget(rutaTsconfigOProyecto);
      console.log(`  entrada   : ${target.inputPath}`);
      console.log(`  modo      : ${target.kind}`);
      console.log(`  tsconfigs : ${target.tsconfigPaths.length}`);
      for (const tsconfigPath of target.tsconfigPaths) console.log(`    - ${tsconfigPath}`);
      const projectPath = target.projectPath;
      const dbPath = resolveDbPath(projectPath, options.db);
      console.log(`  sqlite   : ${dbPath}\n`);
      registerCurrentProject(projectPath);
      configureProjectStorage(projectPath, { dbPath });

      try {
        new GraphIndexer(dbPath, target.tsconfigPaths).index();
        markProjectIndexStatus(projectPath, "completed");
      } catch (error) {
        markProjectIndexStatus(projectPath, "error");
        throw error;
      }
    });

  program
    .command("index_vectors <ruta-tsconfig-o-proyecto>")
    .description("Genera embeddings en LanceDB desde un tsconfig o repo multi-servicio.")
    .option("--lancedb <path>", "Ruta al directorio de LanceDB; por defecto paths.data/lancedb del proyecto")
    .option("-v, --verbose", "Imprime progreso detallado", false)
    .action(async (rutaTsconfigOProyecto: string, options: { lancedb?: string; verbose: boolean }) => {
      console.log("\n[CLI] Indexando vectores semánticos...\n");
      const target = resolveIndexTarget(rutaTsconfigOProyecto);
      console.log(`  entrada   : ${target.inputPath}`);
      console.log(`  modo      : ${target.kind}`);
      console.log(`  tsconfigs : ${target.tsconfigPaths.length}`);
      for (const tsconfigPath of target.tsconfigPaths) console.log(`    - ${tsconfigPath}`);
      const projectPath = target.projectPath;
      const lanceDbPath = resolveLanceDbPath(projectPath, options.lancedb);
      console.log(`  lancedb  : ${lanceDbPath}\n`);
      registerCurrentProject(projectPath);
      configureProjectStorage(projectPath, { lanceDbPath });

      try {
        await new VectorsIndexer(lanceDbPath, target.tsconfigPaths).index();
        markProjectIndexStatus(projectPath, "completed");
      } catch (error) {
        markProjectIndexStatus(projectPath, "error");
        throw error;
      }
    });
}
