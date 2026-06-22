#!/usr/bin/env node

import { Command } from "commander";
import { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { DaemonManager } from "../extractor/daemon.js";
import { AgentIntermediary1 } from "../retriever/utilities/mini-agents/agent-intermediary/index.js";
import { SlmClassifier } from "../retriever/utilities/mini-agents/agent-intermediary/classifier.js";
import { ContextAggregator } from "../retriever/utilities/filters/context-aggregator.js";
import { PromptInjector } from "../retriever/utilities/filters/prompt-injector.js";
import { HybridStrategy } from "../retriever/strategies/hybrid-strategy.js";
import { AgenticStrategy } from "../retriever/strategies/agentic-strategy.js";
import { IctdStrategy } from "../retriever/strategies/ictd-strategy.js";
import { ClcrStrategy } from "../retriever/strategies/clcr-strategy.js";
import { RprStrategy } from "../retriever/strategies/rpr-strategy.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { VectorsIndexer } from "../indexer/vectors-indexer.js";
import { OllamaService } from "../slms/ollama-service.js";
import type { RecoveryStrategy } from "../retriever/models/strategies/types.js";
import { inspect, inspectQuery } from "./inspect.js";
import { GraphIndexer } from "../indexer/graph-indexer.js";



const program = new Command();
program
  .name("lacoco")
  .description("LaCoCo — Recuperador de Contexto de Grandes Bases de Código (RAG local)")
  .version("1.0.0");


program
  .command("watch <ruta-tsconfig>")
  .description(
    "Inicia el daemon: cold-start completo + watcher incremental en tiempo real."
  )
  .option("-d, --db <path>", "Ruta al archivo SQLite de salida", "tensor.sqlite")
  .option("-l, --lancedb <path>", "Ruta al directorio de LanceDB", "./lancedb")
  .option("-v, --verbose", "Imprime el path de cada archivo procesado", false)
  .action((rutaTsconfig: string, options: { db: string; lancedb: string; verbose: boolean }) => {

    printBanner(rutaTsconfig, options.db, options.lancedb);

    const db = new LaCoCoDatabase(options.db);

    const daemon = new DaemonManager({
      tsConfigFilePath: rutaTsconfig,
      db,
      verbose: options.verbose,
      indexEmbeddings: true,
      lanceDbPath: options.lancedb,
    });

    const shutdown = (): void => {
      console.log("\n[CLI] Señal de apagado recibida...");
      void daemon.stop().then(() => process.exit(0));
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);

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


program
  .command("index_graph <ruta-tsconfig>")
  .description(
    "Extrae solo el grafo estructural en SQLite (sin embeddings ni watcher)."
  )
  .option("-d, --db <path>", "Ruta al archivo SQLite de salida", "tensor.sqlite")
  .option("-v, --verbose", "Imprime progreso detallado", false)
  .action((rutaTsconfig: string, options: { db: string; verbose: boolean }) => {
   
    console.log("\n[CLI] Extrayendo grafo estructural...\n");
    console.log(`  tsconfig : ${rutaTsconfig}`);
    console.log(`  sqlite   : ${options.db}\n`);

    const indexer = new GraphIndexer(options.db, rutaTsconfig);
    indexer.index();

  });

program
  .command("index_vectors")
  .description(
    "Genera embeddings semánticos en LanceDB directamente desde el AST (sin dependencia de SQLite)."
  )
  .requiredOption("--tsconfig <path>", "Ruta al tsconfig.json del proyecto a analizar")
  .option("--lancedb <path>", "Ruta al directorio de LanceDB", "./lancedb")
  .option("-v, --verbose", "Imprime progreso detallado", false)
  .action(async (options: { tsconfig: string; lancedb: string; verbose: boolean }) => {
    
    console.log("\n[CLI] Indexando vectores semánticos...\n");
    console.log(`  tsconfig : ${options.tsconfig}`);
    console.log(`  lancedb  : ${options.lancedb}\n`);

    const indexer = new VectorsIndexer(options.lancedb, options.tsconfig);
    await indexer.index();

  });

program
  .command("retrieve <query>")
  .description("Ejecuta el pipeline RAG completo y muestra la respuesta del LLM.")
  .option("-d, --db <path>", "Ruta al archivo SQLite", "tensor.sqlite")
  .option("-l, --lancedb <path>", "Ruta al directorio de LanceDB", "./lancedb")
  .option("-s, --strategy <name>", "Estrategia de recuperación (hybrid, agentic, ictd, clcr, rpr)", "hybrid")
  .option("--ollama <url>", "Endpoint de Ollama", "http://localhost:11434")
  .option("--no-llm", "Solo muestra chunks recuperados, no llama al LLM")
  .action(async (query: string, options: { db: string; lancedb: string; strategy: string; ollama: string; llm: boolean }) => {
    
    console.log("\n[CLI] Pipeline RAG a ejecutar\n");
    console.log(`  query    : ${query}`);
    console.log(`  strategy : ${options.strategy}`);
    console.log(`  sqlite   : ${options.db}\n`);

    const db = new LaCoCoDatabase(options.db);
    const ollama = new OllamaService(options.ollama);
    let lanceDb: LaCoCoLanceDb | undefined;

    try {

      const intermediary = new AgentIntermediary1(new SlmClassifier(ollama));
      const sanitized = await intermediary.sanitize(query);

      console.log("[CLI] Resultado del intermediario:");
      console.log(`  route      : ${sanitized.route}`);
      console.log(`  intent     : ${sanitized.intent}`);
      console.log(`  confidence : ${sanitized.confidence.toFixed(2)}`);
      console.log(`  sanitized prompt : ${sanitized.clean_query}`);
      console.log(`  dimensions : ${sanitized.dimensions.join(", ") || "ninguna"}\n`);

      if (sanitized.route === "LLM_DIRECT") {
        console.log("-------SIMULANDO INTEGRACION DIRECTA CON LLM");
        db.close();
        return;
      }

      let strategy : RecoveryStrategy;
      const needsLanceDb = options.strategy === "hybrid";

      if (needsLanceDb) {
        lanceDb = new LaCoCoLanceDb(options.lancedb);
        await lanceDb.connect();

        switch (options.strategy) {
          case "hybrid":
            strategy = new HybridStrategy(db, lanceDb);
            break;
          default:
            throw new Error(`Estrategia no soportada: ${options.strategy}`);
        }
      } else {
        switch (options.strategy) {
          case "ictd":
            strategy = new IctdStrategy(db);
            break;
          case "clcr":
            strategy = new ClcrStrategy(db);
            break;
          case "rpr":
            strategy = new RprStrategy(db);
            break;
          case "agentic":
            strategy = new AgenticStrategy(db, options.ollama);
            break;
          default:
            throw new Error(`Estrategia no soportada: ${options.strategy}`);
        }
      }

      console.log(`[CLI] Usando estrategia: ${options.strategy}`);
      const chunks = await strategy.retrieve(sanitized);

      const aggregator = new ContextAggregator();
      const aggregated = aggregator.aggregate(chunks);

      console.log(`[CLI] 📦 Chunks recuperados: ${aggregated.length}\n`);
      for (const chunk of aggregated.slice(0, 10)) {
        console.log(`  [${chunk.source}] score=${chunk.score.toFixed(4)} | ${chunk.nodeId}`);
      }

      const injector = new PromptInjector();
      console.log("[CLI] Contexto agregado:\n", injector.inject(query, aggregated));

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
          console.warn("\n[CLI] ⚠️  Ollama no disponible.");
        }
      } else if (!options.llm) {
        console.log("\n[CLI] 📝 Modo sin LLM (--no-llm). Mostrando chunks únicamente.");
      }

      console.log("\n[CLI] ✅ Pipeline RAG completado.");
      if (lanceDb) await lanceDb.close();
      db.close();
    } catch (err) {
      console.error("[CLI] ❌ Error en pipeline RAG:", err instanceof Error ? err.message : err);
      if (lanceDb) await lanceDb.close();
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
  .option("-l, --lancedb <path>", "Ruta al directorio de LanceDB", "./lancedb")
  .option("-b, --budget <num>", "Máximo de nodos a expandir", "75")
  .option("-s, --strategy <name>", "Estrategia de recuperación (hybrid, agentic, ictd, clcr, rpr)", "hybrid")
  .option("-m, --mode <mode>", "Modo de visualización (default, tensor, scores)", "default")
  .option("-o, --output <path>", "Archivo HTML de salida", "inspect-query.html")
  .option("--cdn", "Usar CDN para Cytoscape.js en vez de embeberlo", false)
  .option("--ollama <url>", "Endpoint de Ollama", "http://localhost:11434")
  .action(async (prompt: string, opts: {
    db: string;
    lancedb: string;
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
      lancedb: opts.lancedb,
      budget,
      strategy: opts.strategy,
      mode,
      output: opts.output,
      cdn: opts.cdn,
      ollama: opts.ollama,
    });
  });

program.parse(process.argv);



// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function printBanner(tsconfig: string, dbPath: string, lanceDbPath: string): void {
  console.log("");
  console.log("┌──────────────────────────────────────────────────┐");
  console.log("│     tensor-extractor  ·  Grafo Multirrelacional   │");
  console.log("├──────────────────────────────────────────────────┤");
  console.log(`│  tsconfig : ${tsconfig.padEnd(37)}│`);
  console.log(`│  sqlite   : ${dbPath.padEnd(37)}│`);
  console.log(`│  lancedb  : ${lanceDbPath.padEnd(37)}│`);
  console.log("└──────────────────────────────────────────────────┘");
  console.log("");
}
