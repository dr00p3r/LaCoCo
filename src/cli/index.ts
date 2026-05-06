#!/usr/bin/env node
/**
 * tensor-extractor — CLI entry point
 *
 * Uso:
 *   tensor-extractor watch <ruta-tsconfig>
 *   tensor-extractor watch ./tsconfig.json --db ./tensor.sqlite --verbose
 */

import { Command } from "commander";
import { SqliteManager } from "../db/sqlite-manager.js";
import { DaemonManager } from "../extractor/daemon.js";

// ─────────────────────────────────────────────────────────────────────────────
// Programa
// ─────────────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("tensor-extractor")
  .description("Análisis estático TypeScript → Grafo Multirrelacional en SQLite")
  .version("1.0.0");

// ─────────────────────────────────────────────────────────────────────────────
// Comando: watch <ruta-tsconfig>
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("watch <ruta-tsconfig>")
  .description(
    "Inicia el daemon: cold-start completo + watcher incremental en tiempo real."
  )
  .option("-d, --db <path>", "Ruta al archivo SQLite de salida", "tensor.sqlite")
  .option("-v, --verbose", "Imprime el path de cada archivo procesado", false)
  .action((rutaTsconfig: string, options: { db: string; verbose: boolean }) => {
    printBanner(rutaTsconfig, options.db);

    // ── 1. Inicializar la base de datos ──────────────────────────────────
    const db = new SqliteManager(options.db);

    // ── 2. Construir el DaemonManager ────────────────────────────────────
    const daemon = new DaemonManager({
      tsConfigFilePath: rutaTsconfig,
      db,
      verbose: options.verbose,
    });

    // ── 3. Shutdown graceful ─────────────────────────────────────────────
    //    Registrar antes de start() para capturar Ctrl+C durante el cold start
    const shutdown = (): void => {
      console.log("\n[CLI] 🛑 Señal de apagado recibida...");
      void daemon.stop().then(() => process.exit(0));
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

    // ── 4. Arrancar (cold start sincrónico + watcher) ────────────────────
    try {
      daemon.start();
    } catch (err) {
      console.error(
        "[CLI] ❌ Error fatal durante el arranque:",
        err instanceof Error ? err.message : err
      );
      void daemon.stop().then(() => process.exit(1));
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function printBanner(tsconfig: string, dbPath: string): void {
  console.log("");
  console.log("┌──────────────────────────────────────────────────┐");
  console.log("│     tensor-extractor  ·  Grafo Multirrelacional   │");
  console.log("├──────────────────────────────────────────────────┤");
  console.log(`│  tsconfig : ${tsconfig.padEnd(37)}│`);
  console.log(`│  sqlite   : ${dbPath.padEnd(37)}│`);
  console.log("└──────────────────────────────────────────────────┘");
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Parseo de argumentos
// ─────────────────────────────────────────────────────────────────────────────

program.parse(process.argv);
