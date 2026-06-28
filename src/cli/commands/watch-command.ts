import type { Command } from "commander";
import {
  noopWatchLock,
  runWatchCommand,
  startForegroundWatcher,
  type WatchCliOptions,
  type WatchForegroundOptions,
} from "../watch.js";
import { runCliCommand } from "./common.js";

export function registerWatchCommands(program: Command): void {
  program
    .command("_watch-foreground <ruta-tsconfig>", { hidden: true })
    .option("-d, --db <path>", "Ruta al archivo SQLite de salida")
    .option("-l, --lancedb <path>", "Ruta al directorio de LanceDB")
    .option("-v, --verbose", "Imprime el path de cada archivo procesado", false)
    .action((rutaTsconfig: string, options: WatchForegroundOptions) => {
      startForegroundWatcher(
        rutaTsconfig,
        options,
        process.env.LACOCO_WATCH_PROJECT_ID,
        process.env.LACOCO_WATCH_SKIP_LOCK === "1" ? noopWatchLock() : undefined,
      );
    });

  program
    .command("watch [action] [project]")
    .description("Administra watchers de proyectos registrados.")
    .option("-v, --verbose", "Imprime el path de cada archivo procesado", false)
    .option("--foreground", "Ejecuta el watcher en primer plano", false)
    .option("--json", "Imprime JSON válido", false)
    .action((action: string | undefined, project: string | undefined, options: WatchCliOptions) => {
      runCliCommand(() => runWatchCommand(action, project, options));
    });
}
