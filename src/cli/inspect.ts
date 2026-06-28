import fs from "node:fs";
import { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { getStrategyEntry } from "../retriever/strategies/registry.js";
import { AgentIntermediary1 } from "../retriever/utilities/mini-agents/agent-intermediary/index.js";
import { SlmClassifier } from "../retriever/utilities/mini-agents/agent-intermediary/classifier.js";
import { OllamaService } from "../slms/ollama-service.js";
import { expandBfs } from "./inspect/bfs.js";
import { computeStats, findRootNodes, loadEdges, loadNodes } from "./inspect/data-loaders.js";
import { generateHtml } from "./inspect/html-renderer.js";
import { getCytoscapeTag } from "./inspect/cytoscape-cache.js";
import type { InspectOptions, InspectQueryOptions } from "./inspect/types.js";

export type { Focus, InspectMode, InspectOptions, InspectQueryOptions } from "./inspect/types.js";

export async function inspect(options: InspectOptions): Promise<void> {
  const db = new LaCoCoDatabase(options.db);
  try {
    const rootIds = findRootNodes(db, options.rootNode);
    if (rootIds.length === 0) {
      throw new Error(`Nodo "${options.rootNode}" no encontrado en la base de datos`);
    }
    if (rootIds.length > 1) {
      console.warn(`[inspect] "${options.rootNode}" coincide con ${rootIds.length} nodos.`);
    }

    const visited = expandBfs(db, rootIds, options.budget, options.focus);
    const nodes = loadNodes(db, visited);
    const edges = loadEdges(db, visited);
    const anchors = new Map<string, number>();
    const stats = computeStats(nodes, edges, anchors);
    const cytoscapeTag = await getCytoscapeTag(!options.cdn);
    const html = generateHtml({
      nodes,
      edges,
      anchors,
      stats,
      mode: "default",
      title: `LaCoCo: ${options.rootNode}`,
      cytoscapeTag,
    });
    fs.writeFileSync(options.output, html, "utf-8");
    console.log(`[inspect] HTML generado -> ${options.output}`);
  } finally {
    db.close();
  }
}

export async function inspectQuery(options: InspectQueryOptions): Promise<void> {
  const db = new LaCoCoDatabase(options.db);
  const ollama = new OllamaService(options.ollama, options.model, options.timeoutMs);
  let lanceDb: LaCoCoLanceDb | undefined;

  try {
    const sanitized = await new AgentIntermediary1(new SlmClassifier(ollama))
      .sanitize(options.prompt);
    if (sanitized.route === "LLM_DIRECT") {
      throw new Error("El prompt no requiere RAG; no hay subgrafo que visualizar");
    }

    const entry = getStrategyEntry(options.strategy);
    if (entry.needsLanceDb) {
      lanceDb = new LaCoCoLanceDb(options.lancedb);
      await lanceDb.connect();
    }
    const strategy = entry.create({
      db,
      ollamaEndpoint: options.ollama,
      ollama,
      ...(options.timeoutMs !== undefined ? { ollamaTimeoutMs: options.timeoutMs } : {}),
      ...(lanceDb ? { lanceDb } : {}),
    });
    const chunks = await strategy.retrieve(sanitized);
    if (chunks.length === 0) {
      throw new Error("La estrategia no recuperó ningún chunk");
    }

    const anchorScores = new Map<string, number>();
    for (const chunk of chunks) {
      anchorScores.set(
        chunk.nodeId,
        Math.max(anchorScores.get(chunk.nodeId) ?? 0, chunk.score),
      );
    }
    const visited = expandBfs(db, [...anchorScores.keys()], options.budget, "ALL");
    const nodes = loadNodes(db, visited);
    const edges = loadEdges(db, visited);
    const stats = computeStats(nodes, edges, anchorScores);
    const cytoscapeTag = await getCytoscapeTag(!options.cdn);
    const html = generateHtml({
      nodes,
      edges,
      anchors: anchorScores,
      stats,
      mode: options.mode,
      title: `LaCoCo: "${options.prompt.slice(0, 60)}"`,
      cytoscapeTag,
    });
    fs.writeFileSync(options.output, html, "utf-8");
    console.log(`[inspect-query] HTML generado -> ${options.output}`);
  } finally {
    ollama.abort();
    if (lanceDb) await lanceDb.close();
    db.close();
  }
}
