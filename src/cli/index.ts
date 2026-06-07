#!/usr/bin/env node
/**
 * LaCoCo CLI — Recuperador de Contexto de Grandes Bases de Código
 *
 * Uso:
 *   lacoco watch <ruta-tsconfig>
 *   lacoco index <ruta-tsconfig>
 *   lacoco extract <ruta-tsconfig>
 *   lacoco retrieve "<query>"
 */

import { Command } from "commander";
import { Project } from "ts-morph";
import { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { DaemonManager } from "../extractor/daemon.js";
import { GraphExtractor } from "../extractor/graph-extractor.js";
import { AgentIntermediary1 } from "../retriever/utilities/mini-agents/agent-intermediary-1.js";
import { ContextAggregator } from "../retriever/utilities/filters/context-aggregator.js";
import { PromptInjector } from "../retriever/utilities/filters/prompt-injector.js";
import { BM25Strategy } from "../retriever/strategies/bm25-strategy.js";
import { BM25DimFilterStrategy } from "../retriever/strategies/bm25-dim-strategy.js";
import { HybridStrategy } from "../retriever/strategies/hybrid-strategy.js";
import { AgenticStrategy } from "../retriever/strategies/agentic-strategy.js";
import { AgenticStandaloneStrategy } from "../retriever/strategies/agentic-standalone-strategy.js";
import { IctdStrategy } from "../retriever/strategies/ictd-strategy.js";
import { ClcrStrategy } from "../retriever/strategies/clcr-strategy.js";
import { RprStrategy } from "../retriever/strategies/rpr-strategy.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { OllamaService } from "../slms/ollama-service.js";
import type { RecoveryStrategy } from "../retriever/models/strategies/types.js";
import { inspect, inspectQuery } from "./inspect.js";

// ─────────────────────────────────────────────────────────────────────────────
// Programa
// ─────────────────────────────────────────────────────────────────────────────

const program = new Command();

program
  .name("lacoco")
  .description("LaCoCo — Recuperador de Contexto de Grandes Bases de Código (RAG local)")
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
    const db = new LaCoCoDatabase(options.db);

    // ── 2. Construir el DaemonManager ────────────────────────────────────
    const daemon = new DaemonManager({
      tsConfigFilePath: rutaTsconfig,
      db,
      verbose: options.verbose,
      indexEmbeddings: true,
      lanceDbPath: "./lancedb",
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

// ─────────────────────────────────────────────────────────────────────────────
// Comando: index <ruta-tsconfig>
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("index <ruta-tsconfig>")
  .description(
    "Cold-start del extractor + generación de embeddings en LanceDB."
  )
  .option("-d, --db <path>", "Ruta al archivo SQLite", "tensor.sqlite")
  .option("-v, --verbose", "Imprime progreso detallado", false)
  .action(async (rutaTsconfig: string, options: { db: string; verbose: boolean }) => {
    console.log("\n[CLI] 📦 Indexando proyecto para RAG...\n");
    console.log(`  tsconfig : ${rutaTsconfig}`);
    console.log(`  sqlite   : ${options.db}\n`);

    const db = new LaCoCoDatabase(options.db);
    const daemon = new DaemonManager({
      tsConfigFilePath: rutaTsconfig,
      db,
      verbose: options.verbose,
      indexEmbeddings: true,
      lanceDbPath: "./lancedb",
    });

    // Cold start sincrónico (sin watcher, con embeddings)
    try {
      daemon.start();
      // Esperar a que los embeddings terminen antes de cerrar la BD
      console.log("\n[CLI] ⏳ Esperando generación de embeddings...");
      await daemon.awaitEmbeddings();
      await daemon.stop();
      console.log("\n[CLI] ✅ Indexación completada (grafo + embeddings).");
    } catch (err) {
      console.error("[CLI] ❌ Error durante indexación:", err instanceof Error ? err.message : err);
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Comando: extract <ruta-tsconfig>
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("extract <ruta-tsconfig>")
  .description(
    "Extrae solo el grafo estructural (sin embeddings ni watcher)."
  )
  .option("-d, --db <path>", "Ruta al archivo SQLite de salida", "tensor.sqlite")
  .option("-v, --verbose", "Imprime progreso detallado", false)
  .action((rutaTsconfig: string, options: { db: string; verbose: boolean }) => {
    console.log("\n[CLI] 🔨 Extrayendo grafo estructural...\n");
    console.log(`  tsconfig : ${rutaTsconfig}`);
    console.log(`  sqlite   : ${options.db}\n`);

    const db = new LaCoCoDatabase(options.db);
    const project = new Project({ tsConfigFilePath: rutaTsconfig });
    const extractor = new GraphExtractor(db.getRawDb());

    const sourceFiles = project.getSourceFiles();
    console.log(`[CLI] Archivos encontrados: ${sourceFiles.length}`);

    console.time("[CLI] Extracción");
    db.transaction(() => {
      for (const file of sourceFiles) {
        if (options.verbose) {
          console.log(`  ✍  ${file.getFilePath()}`);
        }
        try {
          extractor.processFile(file);
        } catch (err) {
          console.error(
            `  ⚠  Error analizando ${file.getFilePath()}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    });
    console.timeEnd("[CLI] Extracción");

    const { nodesWritten, edgesWritten } = extractor.getStats();
    console.log(`[CLI] ✅ Grafo — ${nodesWritten} nodos, ${edgesWritten} aristas.`);

    console.log(`[CLI] 🏷️  Poblando metadatos dimensionales...`);
    db.populateMetadata();

    db.close();
  });

// ─────────────────────────────────────────────────────────────────────────────
// Comando: retrieve <query>
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("retrieve <query>")
  .description("Ejecuta el pipeline RAG completo y muestra la respuesta del LLM.")
  .option("-d, --db <path>", "Ruta al archivo SQLite", "tensor.sqlite")
  .option("-s, --strategy <name>", "Estrategia de recuperación (bm25, bm25-dim, hybrid, agentic, agentic-standalone, ictd, clcr, rpr)", "hybrid")
  .option("--ollama <url>", "Endpoint de Ollama", "http://localhost:11434")
  .option("--no-llm", "Solo muestra chunks recuperados, no llama al LLM")
  .action(async (query: string, options: { db: string; strategy: string; ollama: string; llm: boolean }) => {
    console.log("\n[CLI] 🔍 Pipeline RAG completo\n");
    console.log(`  query    : ${query}`);
    console.log(`  strategy : ${options.strategy}`);
    console.log(`  sqlite   : ${options.db}\n`);

    const db = new LaCoCoDatabase(options.db);
    const ollama = new OllamaService(options.ollama);

    try {
      // 1. Agente Intermediario 1
      const intermediary = new AgentIntermediary1();
      const sanitized = intermediary.sanitize(query);

      console.log("[CLI] 📋 Resultado del intermediario:");
      console.log(`  route      : ${sanitized.route}`);
      console.log(`  intent     : ${sanitized.intent}`);
      console.log(`  confidence : ${sanitized.confidence.toFixed(2)}`);
      console.log(`  dimensions : ${sanitized.dimensions.join(", ") || "ninguna"}\n`);

      if (sanitized.route === "LLM_DIRECT") {
        if (options.llm && await ollama.isAvailable()) {
          console.log("[CLI] ➡️  Envío directo al LLM (sin RAG)...");
          const answer = await ollama.generate(query);
          console.log("\n🤖 Respuesta del LLM:\n" + answer);
        } else {
          console.log("[CLI] ➡️  El prompt no requiere RAG. Envío directo al LLM.");
        }
        db.close();
        return;
      }

      // 2. Strategy de recuperación (selector dinámico)
      let strategy: RecoveryStrategy;
      const needsLanceDb = ["hybrid", "agentic", "agentic-standalone"].includes(options.strategy);

      if (needsLanceDb) {
        const lanceDb = new LaCoCoLanceDb("./lancedb");
        await lanceDb.connect();

        switch (options.strategy) {
          case "hybrid":
            strategy = new HybridStrategy(db, lanceDb);
            break;
          case "agentic":
            strategy = new AgenticStrategy(db, options.ollama);
            break;
          case "agentic-standalone":
            strategy = new AgenticStandaloneStrategy(db, options.ollama);
            break;
          default:
            strategy = new HybridStrategy(db, lanceDb);
        }
      } else {
        switch (options.strategy) {
          case "bm25-dim":
            strategy = new BM25DimFilterStrategy(db);
            break;
          case "ictd":
            strategy = new IctdStrategy(db);
            break;
          case "clcr":
            strategy = new ClcrStrategy(db);
            break;
          case "rpr":
            strategy = new RprStrategy(db);
            break;
          case "bm25":
          default:
            strategy = new BM25Strategy(db);
        }
      }

      console.log(`[CLI] 🎯 Usando estrategia: ${options.strategy}`);
      const chunks = await strategy.retrieve(sanitized);

      // 3. Agregación
      const aggregator = new ContextAggregator();
      const aggregated = aggregator.aggregate(chunks);

      console.log(`[CLI] 📦 Chunks recuperados: ${aggregated.length}\n`);
      for (const chunk of aggregated.slice(0, 10)) {
        console.log(`  [${chunk.source}] score=${chunk.score.toFixed(4)} | ${chunk.nodeId}`);
      }

      const injector = new PromptInjector();
      console.log("[CLI] 📚 Contexto agregado:\n", injector.inject(query, aggregated));

      // 4. Inyección de contexto + LLM
      if (options.llm && aggregated.length > 0) {
        if (await ollama.isAvailable()) {
          console.log("\n[CLI] 🧠 Enviando prompt enriquecido al LLM...\n");
          const injector = new PromptInjector();
          console.log("[CLI] 📝 Prompt original:\n" + query + "\n");
          const enrichedPrompt = injector.inject(query, aggregated);
          console.log("[CLI] 📚 Contexto agregado:\n", enrichedPrompt);
          const answer = await ollama.generate(enrichedPrompt);
          console.log("🤖 Respuesta del LLM:\n" + answer);
        } else {
          console.warn("\n[CLI] ⚠️  Ollama no disponible. Mostrando solo chunks recuperados.");
        }
      } else if (!options.llm) {
        console.log("\n[CLI] 📝 Modo sin LLM (--no-llm). Mostrando chunks únicamente.");
      }

      console.log("\n[CLI] ✅ Pipeline RAG completado.");
      db.close();
    } catch (err) {
      console.error("[CLI] ❌ Error en pipeline RAG:", err instanceof Error ? err.message : err);
      db.close();
      process.exit(1);
    }
  });

// ─────────────────────────────────────────────────────────────────────────────
// Comando: inspect <root-node>
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("inspect <root-node>")
  .description(
    "Visualiza el subgrafo alrededor de un nodo usando expansión BFS con budget."
  )
  .option("-d, --db <path>", "Ruta al archivo SQLite", "tensor.sqlite")
  .option("-b, --budget <num>", "Máximo de nodos a expandir", "75")
  .option("-f, --focus <dim>", "Prioridad dimensional: SYS, CPG, DTG, ALL", "ALL")
  .option("-o, --output <path>", "Archivo HTML de salida", "inspect.html")
  .option("--cdn", "Usar CDN para Cytoscape.js en vez de embeberlo", false)
  .action(async (rootNode: string, opts: {
    db: string;
    budget: string;
    focus: string;
    output: string;
    cdn: boolean;
  }) => {
    const budget = parseInt(opts.budget, 10);
    if (isNaN(budget) || budget < 1) {
      console.error("[CLI] ❌ --budget debe ser un número positivo.");
      process.exit(1);
    }
    const focus = ["SYS", "CPG", "DTG", "ALL"].includes(opts.focus)
      ? (opts.focus as "SYS" | "CPG" | "DTG" | "ALL")
      : "ALL";
    await inspect({
      rootNode,
      db: opts.db,
      budget,
      focus,
      output: opts.output,
      cdn: opts.cdn,
    });
  });

// ─────────────────────────────────────────────────────────────────────────────
// Comando: inspect-query <prompt>
// ─────────────────────────────────────────────────────────────────────────────

program
  .command("inspect-query <prompt>")
  .description(
    "Pipeline RAG completo → visualización del subgrafo recuperado para un prompt."
  )
  .option("-d, --db <path>", "Ruta al archivo SQLite", "tensor.sqlite")
  .option("-b, --budget <num>", "Máximo de nodos a expandir", "75")
  .option("-s, --strategy <name>", "Estrategia de recuperación (bm25, bm25-dim, hybrid, agentic, agentic-standalone, ictd, clcr, rpr)", "hybrid")
  .option("-m, --mode <mode>", "Modo de visualización (default, tensor, scores)", "default")
  .option("-o, --output <path>", "Archivo HTML de salida", "inspect-query.html")
  .option("--cdn", "Usar CDN para Cytoscape.js en vez de embeberlo", false)
  .option("--ollama <url>", "Endpoint de Ollama", "http://localhost:11434")
  .action(async (prompt: string, opts: {
    db: string;
    budget: string;
    strategy: string;
    mode: string;
    output: string;
    cdn: boolean;
    ollama: string;
  }) => {
    const budget = parseInt(opts.budget, 10);
    if (isNaN(budget) || budget < 1) {
      console.error("[CLI] ❌ --budget debe ser un número positivo.");
      process.exit(1);
    }
    const mode = ["default", "tensor", "scores"].includes(opts.mode)
      ? (opts.mode as "default" | "tensor" | "scores")
      : "default";
    await inspectQuery({
      prompt,
      db: opts.db,
      budget,
      strategy: opts.strategy,
      mode,
      output: opts.output,
      cdn: opts.cdn,
      ollama: opts.ollama,
    });
  });

program.parse(process.argv);
