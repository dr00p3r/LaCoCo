---
lacoco_export_version: 1
context_id: "b79ed9fda285e438"
question: "modify the recovery chunks of the strategies based on hybrid to be only 20"
generated_at: "2026-06-27T23:19:58.752Z"
strategy: "clcr"
route: "RAG"
intent: "refactor"
confidence: 0.98
dimensions: ["SYS"]
chunks: 50
---
# LaCoCo Context Export

## Question

modify the recovery chunks of the strategies based on hybrid to be only 20

## Retrieval Metadata

| Field | Value |
|---|---|
| Context ID | `b79ed9fda285e438` |
| Generated at | 2026-06-27T23:19:58.752Z |
| Strategy | `clcr` |
| Route | `RAG` |
| Intent | `refactor` |
| Confidence | `0.98` |
| Dimensions | `SYS` |
| SQLite | `/home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/.lacoco/tensor.sqlite` |
| LanceDB | `/home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/.lacoco/lancedb` |

## Clean Query

```text
"modify the recovery chunks of the strategies based on hybrid to be only 20"
```

## Embedding Input

```text
Modificar los fragmentos recuperables de las estrategias basándolas en un modelo mixto a solo 20 chunks
```

## Enriched Prompt

```text
### Contexto del Proyecto (recuperado automáticamente)
Los siguientes fragmentos de código fueron recuperados del repositorio actual
como contexto para tu consulta. Úsalos como referencia absoluta de firmas,
tipos y dependencias locales, y sobre todo, como ubicación de archivos. 
No inventes símbolos que no aparezcan aquí.

[1] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/inspect.ts#inspectQuery
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

---

[2] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridStrategy
export class HybridStrategy extends AbstractAnchoredStrategy

---

[3] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/filters/context-aggregator.ts#ContextAggregator.aggregate
aggregate(chunks: ContextChunk[], maxTokens = 4000, minScore = 0): ContextChunk[] {

    // 1. Deduplicar por nodeId (quedarse con mayor score)
    const byNode = new Map<string, ContextChunk>();
    for (const chunk of chunks) {
      const existing = byNode.get(chunk.nodeId);
      if (!existing || chunk.score > existing.score) {
        byNode.set(chunk.nodeId, chunk);
      }
    }

    // 2. Filtrar por score mínimo (eliminar ruido de baja relevancia)
    const filtered = Array.from(byNode.values()).filter((c) => c.score >= minScore);

    // 3. Ordenar por score descendente
    const sorted = filtered.sort((a, b) => b.score - a.score);

    // 4. Truncar por tokens aproximados
    const result: ContextChunk[] = [];
    let tokensUsed = 0;

    for (const chunk of sorted) {

      const estimatedTokens = Math.ceil(
        chunk.text.split(/\s+/).length / WORDS_PER_TOKEN
      );

      if (tokensUsed + estimatedTokens > maxTokens) continue;

      result.push(chunk);
      tokensUsed += estimatedTokens;
    }

    return result;
  }

---

[4] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/composite-callbacks.ts#SourceNodeBuffer
export class SourceNodeBuffer implements ExtractionCallbacks

---

[5] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy
export class AgenticStrategy implements RecoveryStrategy

---

[6] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/abstract-anchored-strategy.ts#AbstractAnchoredStrategy
export abstract class AbstractAnchoredStrategy implements RecoveryStrategy

---

[7] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerRetrieve
function registerRetrieve(program: Command): void {
  program
    .command("retrieve [project] <query>")
    .description("Ejecuta el pipeline RAG completo y muestra la respuesta del LLM.")
    .option("-s, --strategy <name>", strategyHelp())
    .option("--ollama <url>", "Endpoint de Ollama; por defecto agent.endpoint")
    .option("--no-llm", "Solo muestra chunks recuperados, no llama al LLM")
    .option("-v, --verbose", "Imprime diagnóstico del pipeline en stderr", false)
    .action(async (project: string | undefined, query: string, options: RetrieveCliOptions) => {
      const exitCode = await runRetrieve(query, options, undefined, undefined, project);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}

---

[8] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#runRetrieve
export async function runRetrieve(
  query: string,
  options: RetrieveCliOptions,
  streams: CliStreams = { stdout: process.stdout, stderr: process.stderr },
  runtime: RetrieveRuntime = defaultRetrieveRuntime,
  project?: string,
): Promise<number> {
  const writeStdout = (message: string): void => {
    streams.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
  };
  const writeStderr = (message: string): void => {
    streams.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };

  try {
    const resolvedOptions = resolveRetrieveOptions(options, project);
    const context = await retrieveContext(query, resolvedOptions, streams, runtime);

    if (resolvedOptions.llm && context.chunks.length > 0 && context.sanitized.route === "RAG") {
      const ollama = runtime.createOllama(resolvedOptions.ollama);
      try {
        if (await ollama.isAvailable()) {
          const answer = await ollama.generate(context.enrichedPrompt);
          writeStdout(answer);
        } else {
          writeStderr("[CLI] Ollama no disponible para la respuesta final; se imprime el prompt enriquecido.");
          writeStdout(context.enrichedPrompt);
        }
      } finally {
        ollama.abort();
      }
    } else {
      writeStdout(context.enrichedPrompt);
    }

    if (resolvedOptions.verbose) writeStderr("[CLI] retrieve completado");
    return 0;
  } catch (err) {
    const stage = err instanceof PipelineStageError ? err.stage : "inicialización";
    writeStderr(`[CLI] Error en pipeline RAG (${stage}): ${formatError(err)}`);
    return 1;
  }
}

---

[9] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/hybrid-anchor-service.ts#HybridAnchor
export interface HybridAnchor {}

---

[10] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#runContextExport
export async function runContextExport(
  query: string,
  options: ContextExportCliOptions,
  streams: CliStreams = { stdout: process.stdout, stderr: process.stderr },
  runtime: RetrieveRuntime = defaultRetrieveRuntime,
  project?: string,
): Promise<number> {
  const writeStdout = (message: string): void => {
    streams.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
  };
  const writeStderr = (message: string): void => {
    streams.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };

  try {
    const resolvedOptions = resolveRetrieveOptions({ ...options, llm: false }, project);
    const context = await retrieveContext(query, resolvedOptions, streams, runtime);
    const markdown = renderContextMarkdown(context);
    const outputPath = path.resolve(options.output);
    writeTextFileAtomic(outputPath, markdown);

    if (options.json) {
      writeStdout(JSON.stringify({
        id: context.id,
        output: outputPath,
        query: context.originalQuery,
        strategy: context.options.strategy,
        chunks: context.chunks.length,
      }, null, 2));
    } else {
      writeStdout(`Contexto exportado: ${outputPath}`);
    }

    return 0;
  } catch (err) {
    const stage = err instanceof PipelineStageError ? err.stage : "exportación";
    writeStderr(`[CLI] Error exportando contexto (${stage}): ${formatError(err)}`);
    return 1;
  }
}

---

[11] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy.retrieve
async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    // Fase 1: recuperar símbolos semilla por BM25
    const seedResults = this.bm25.search(query.clean_query, 5);
    const collected = new Map<string, ContextChunk>();

    for (const hit of seedResults) {
      collected.set(hit.nodeId, {
        nodeId: hit.nodeId,
        score: hit.score,
        text: hit.text,
        source: "AGENTIC",
      });
    }

    // Fase 2: ciclo agente-executor con SLM (Ollama)
    if (await this.ollama.isAvailable()) {
      const contextHistory: string[] = [];

      for (let i = 0; i < this.maxIterations && collected.size < 50; i++) {
        const toolCall = await this.#planTool(query, Array.from(collected.keys()), contextHistory);
        if (!toolCall) break;

        const results = this.#executeTool(toolCall);
        if (results.length === 0) break;

        for (const chunk of results) {
          if (!collected.has(chunk.nodeId)) {
            collected.set(chunk.nodeId, chunk);
          }
        }

        contextHistory.push(`Tool: ${toolCall.name}(${JSON.stringify(toolCall.params)}) → ${results.length} resultados`);
      }
    } else {
      // Fallback determinístico: expansión por vecindad pura
      for (let i = 0; i < this.maxIterations && collected.size < 50; i++) {
        const currentIds = Array.from(collected.keys());
        const neighbors = this.#getNeighbors(currentIds);
        for (const n of neighbors) {
          if (!collected.has(n.nodeId)) {
            collected.set(n.nodeId, n);
          }
        }
      }
    }

    return Array.from(collected.values()).sort((a, b) => b.score - a.score);
  }

---

[12] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/inspect.ts#inspect
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

---

[13] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#createRetrievedContext
function createRetrievedContext(
  originalQuery: string,
  options: ResolvedRetrieveCliOptions,
  sanitized: SanitizerOutput,
  chunks: RetrievedContext["chunks"],
  enrichedPrompt: string,
): RetrievedContext {
  return {
    id: createContextId(originalQuery),
    generatedAt: new Date().toISOString(),
    originalQuery,
    options: {
      strategy: options.strategy,
      db: options.db,
      lancedb: options.lancedb,
      ollama: options.ollama,
    },
    sanitized,
    chunks,
    enrichedPrompt,
  };
}

---

[14] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/daemon.ts#DaemonManager.#coldStart
#coldStart(): void {
    console.log("\n[Daemon] Cold start — analizando proyecto completo...");
    console.time("[Daemon] Cold start");

    const sourceFiles = this.project.getSourceFiles();
    const total = sourceFiles.length;
    console.log(`[Daemon]    ${total} archivos TypeScript encontrados.`);

    this.sqliteCallbacks.nodesWritten = 0;
    this.sqliteCallbacks.edgesWritten = 0;

    this.db.transaction(() => {
      this.db.clearGraph();
      this.vectorNodeBuffer.clear();
      for (const file of sourceFiles) {
        if (this.verbose) {
          console.log(`[Daemon]    ✍  ${file.getFilePath()}`);
        }
        this.#safeProcessFile(file);
      }
    });
    this.db.populateMetadata();

    console.timeEnd("[Daemon] Cold start");
    console.log(
      `[Daemon] ✅ Grafo construido — ${this.sqliteCallbacks.nodesWritten} nodos, ${this.sqliteCallbacks.edgesWritten} aristas.`
    );

    if (this.indexVectors && this.sqliteCallbacks.nodesWritten > 0) {
      this.vectorsPromise = this.#generateEmbeddings();
    }
  }

---

[15] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/hybrid-anchor-service.ts#HybridAnchorService
export class HybridAnchorService

---

[16] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/ictd-strategy.ts#IctdStrategy.expand
protected async expand(anchorResults: HybridAnchor[], query: SanitizerOutput): Promise<ContextChunk[]> {
    const weights = getIntentWeights(query.intent, query.dimensions);

    const anchorIds = new Set<string>();
    const anchorHeat = new Map<string, number>();
    for (const r of anchorResults) {
      anchorHeat.set(r.nodeId, r.score);
      anchorIds.add(r.nodeId);
    }

    const { outAdj, inDeg } = this.#buildSubgraph(Array.from(anchorIds));

    if (outAdj.size === 0) {
      return anchorResults.map((anchor) =>
        this.toChunk(anchor, "ICTD", anchorHeat.get(anchor.nodeId) ?? 0.5)
      );
    }

    const allIds = Array.from(outAdj.keys());
    let heat = new Map<string, number>();
    const init = new Map<string, number>();
    for (const id of allIds) {
      init.set(id, anchorHeat.get(id) ?? 0);
      heat.set(id, anchorHeat.get(id) ?? 0);
    }

    const alpha = this.config.restartProb;
    for (let iter = 0; iter < this.config.maxIterations; iter++) {
      const next = new Map<string, number>();
      for (const id of allIds) next.set(id, 0);

      for (const [src, dims] of outAdj) {
        const hSrc = heat.get(src) ?? 0;
        for (const dim of ["SYS", "CPG", "DTG"] as Dim[]) {
          const tgts = dims[dim];
          if (tgts.length === 0) continue;
          const w = weights[dim];

          if (hSrc > 0) {
            const contrib = (hSrc * w) / tgts.length;
            for (const tgt of tgts) {
              next.set(tgt, (next.get(tgt) ?? 0) + contrib);
            }
          }

          for (const tgt of tgts) {
            const hTgt = heat.get(tgt) ?? 0;
            if (hTgt <= 0) continue;
            const deg = inDeg.get(tgt)?.[dim] ?? 1;
            const contrib = (hTgt * w) / deg;
            next.set(src, (next.get(src) ?? 0) + contrib);
          }
        }
      }

      for (const id of allIds) {
        const val = next.get(id) ?? 0;
        next.set(id, val * (1 - alpha) + (init.get(id) ?? 0) * alpha);
      }

      let maxDiff = 0;
      for (const id of allIds) {
        const diff = Math.abs((next.get(id) ?? 0) - (heat.get(id) ?? 0));
        if (diff > maxDiff) maxDiff = diff;
      }

      heat = next;
      if (maxDiff < this.config.epsilon) break;
    }

    const ranked = allIds
      .filter((id) => (heat.get(id) ?? 0) > 0.001)
      .sort((a, b) => (heat.get(b) ?? 0) - (heat.get(a) ?? 0))
      .slice(0, this.config.chunkLimit);

    const sigs = this.db.getNodeSignatures(ranked);

    return ranked.map((id) => ({
      nodeId: id,
      score: heat.get(id) ?? 0,
      text: sigs.get(id) ?? id,
      source: "ICTD",
    }));
  }

---

[17] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerInspectQuery
function registerInspectQuery(program: Command): void {
  program
    .command("inspect-query [project] <prompt>")
    .description("Pipeline RAG completo → visualización del subgrafo recuperado para un prompt.")
    .option("-b, --budget <num>", "Máximo de nodos a expandir", "75")
    .option("-s, --strategy <name>", strategyHelp())
    .option("-m, --mode <mode>", "Modo de visualización (default, tensor, scores)", "default")
    .option("-o, --output <path>", "Archivo HTML de salida", "inspect-query.html")
    .option("--cdn", "Usar CDN para Cytoscape.js en vez de embeberlo", false)
    .option("--ollama <url>", "Endpoint de Ollama; por defecto agent.endpoint")
    .action(async (project: string | undefined, prompt: string, options: InspectQueryCliOptions) => {
      const budget = parseBudget(options.budget);
      if (budget === null) return;
      const mode = ["default", "tensor", "scores"].includes(options.mode)
        ? options.mode as "default" | "tensor" | "scores"
        : "default";
      const ollamaEndpoint = options.ollama ?? resolveStringConfig("agent.endpoint");
      const projectPath = resolveInspectQueryProjectPath(project);
      await inspectQuery({
        prompt,
        db: resolveDbPath(projectPath),
        lancedb: resolveLanceDbPath(projectPath),
        budget,
        strategy: options.strategy ?? resolveStringConfig("strategy.default"),
        mode,
        output: options.output,
        cdn: options.cdn,
        ollama: ollamaEndpoint,
        model: resolveStringConfig("agent.model"),
        timeoutMs: resolveNumberConfig("timeout.ms"),
      });
    });
}

---

[18] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/callable-analysis.ts#consumesFromParam
function consumesFromParam(
  param: ParameterDeclaration,
  sourceId: string,
  cb: ExtractionCallbacks,
): void {
  const type = param.getType();

  if (type.isObject() && !type.isAny()) {
    const targetId = resolveTypeToId(type);
    if (targetId) cb.insertEdge(sourceId, targetId, "CONSUMES_DATA");
    return;
  }

  if (type.isArray()) {
    const elementType = type.getArrayElementType();
    if (elementType) {
      const targetId = resolveTypeToId(elementType);
      if (targetId) cb.insertEdge(sourceId, targetId, "CONSUMES_DATA");
    }
    return;
  }

  if (type.isIntersection()) {
    for (const member of type.getIntersectionTypes()) {
      const targetId = resolveTypeToId(member);
      if (targetId) cb.insertEdge(sourceId, targetId, "CONSUMES_DATA");
    }
    return;
  }

  if (type.isUnion()) {
    for (const member of type.getUnionTypes()) {
      if (!member.isNull() && !member.isUndefined()) {
        const targetId = resolveTypeToId(member);
        if (targetId) cb.insertEdge(sourceId, targetId, "CONSUMES_DATA");
      }
    }
  }
}

---

[19] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#strategyHelp
export function strategyHelp(): string {
  return `Estrategia de recuperación (${STRATEGY_NAMES.join(", ")}); por defecto strategy.default`;
}

---

[20] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy.#planTool
async #planTool(
    query: SanitizerOutput,
    currentIds: string[],
    history: string[]
  ): Promise<Tool | null> {
    const systemPrompt = `Eres un planificador de recuperación de código. Tienes estas herramientas:
- get_neighbors(node_id): recupera nodos conectados por aristas.
- get_node_by_symbol(name): busca un nodo por nombre de símbolo.
- get_dependencies(package, version): busca dependencias externas.

Usa herramientas solo cuando aporten contexto adicional concreto. Si los nodos actuales ya cubren la consulta,
responde {"done": true}. No inventes nombres de nodos, paquetes ni versiones.

Responde SOLO con un JSON de la forma: {"name": "...", "params": {...}}.
Si no necesitas más herramientas, responde: {"done": true}.`;

    const prompt = `Consulta: "${query.embedding_input}"\nNodos actuales: [${currentIds.join(", ")}]\nHistorial: ${history.join("; ") || "ninguno"}`;

    try {
      const response = await this.ollama.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ]
      );

      if (response.includes('"done"')) return null;

      // Extraer JSON de la respuesta (puede venir con markdown)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as { name: string; params: Record<string, unknown> };
      if (["get_neighbors", "get_node_by_symbol", "get_dependencies"].includes(parsed.name)) {
        return {
          name: parsed.name as Tool["name"],
          params: Object.fromEntries(
            Object.entries(parsed.params).map(([k, v]) => [k, String(v)])
          ),
        };
      }
    } catch (err) {
      console.warn(
        "[AgenticStrategy] ⚠️  SLM falló en planTool:",
        err instanceof Error ? err.message : String(err)
      );
    }
    return null;
  }

---

[21] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#renderContextMarkdown
function renderContextMarkdown(context: RetrievedContext): string {
  const frontMatter = [
    "---",
    "lacoco_export_version: 1",
    `context_id: ${yamlString(context.id)}`,
    `question: ${yamlString(context.originalQuery)}`,
    `generated_at: ${yamlString(context.generatedAt)}`,
    `strategy: ${yamlString(context.options.strategy)}`,
    `route: ${yamlString(context.sanitized.route)}`,
    `intent: ${yamlString(context.sanitized.intent)}`,
    `confidence: ${context.sanitized.confidence}`,
    `dimensions: [${context.sanitized.dimensions.map(yamlString).join(", ")}]`,
    `chunks: ${context.chunks.length}`,
    "---",
    "",
  ].join("\n");

  const chunkSections = context.chunks.length === 0
    ? "No se recuperaron chunks para esta consulta.\n"
    : context.chunks.map((chunk, index) => [
      `### ${index + 1}. ${chunk.nodeId}`,
      "",
      `- Source: \`${chunk.source}\``,
      `- Score: \`${chunk.score.toFixed(4)}\``,
      "",
      fencedBlock(chunk.text),
    ].join("\n")).join("\n\n");

  return `${frontMatter}# LaCoCo Context Export

## Question

${context.originalQuery}

## Retrieval Metadata

| Field | Value |
|---|---|
| Context ID | \`${context.id}\` |
| Generated at | ${context.generatedAt} |
| Strategy | \`${context.options.strategy}\` |
| Route | \`${context.sanitized.route}\` |
| Intent | \`${context.sanitized.intent}\` |
| Confidence | \`${context.sanitized.confidence.toFixed(2)}\` |
| Dimensions | ${context.sanitized.dimensions.length > 0 ? context.sanitized.dimensions.map((dim) => `\`${dim}\``).join(", ") : "-"} |
| SQLite | \`${context.options.db}\` |
| LanceDB | \`${context.options.lancedb}\` |

## Clean Query

${fencedBlock(context.sanitized.clean_query || "(empty)")}

## Embedding Input

${fencedBlock(context.sanitized.embedding_input)}

## Enriched Prompt

${fencedBlock(context.enrichedPrompt)}

## Retrieved Chunks

${chunkSections}
`;
}

---

[22] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid
hybrid: { ... }

---

[23] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/rpr-strategy.ts#RprStrategy.expand
protected async expand(anchorResults: HybridAnchor[], _query: SanitizerOutput): Promise<ContextChunk[]> {
    const anchorScores = new Map<string, number>();
    const anchorIds = new Set<string>();
    for (const r of anchorResults) {
      anchorScores.set(r.nodeId, r.score);
      anchorIds.add(r.nodeId);
    }

    const { outgoingEdges, nodeRelevance } = this.#buildSubgraph(
      Array.from(anchorIds),
      anchorScores
    );

    const allNodeIds = new Set(nodeRelevance.keys());
    for (const edges of outgoingEdges.values()) {
      for (const e of edges) allNodeIds.add(e.targetId);
    }

    const paths = this.#enumeratePaths(Array.from(anchorIds), outgoingEdges);

    if (paths.length === 0) {
      return anchorResults.map((anchor) =>
        this.toChunk(anchor, "RPR", anchorScores.get(anchor.nodeId) ?? 0.5)
      );
    }

    const scored = this.#scorePaths(paths, nodeRelevance);

    const seen = new Set<string>();
    const ranked = scored
      .sort((a, b) => b.score - a.score)
      .filter((p) => {
        if (seen.has(p.hash)) return false;
        seen.add(p.hash);
        return true;
      })
      .slice(0, this.config.chunkLimit);

    const sigNodes = new Set<string>();
    for (const p of ranked) for (const n of p.nodes) sigNodes.add(n);
    const idArr = Array.from(sigNodes) as string[];
    const sigs = this.db.getNodeSignatures(idArr);

    return ranked.map((p) => {
      const parts: string[] = [];
      for (let i = 0; i < p.nodes.length; i++) {
        const nid = p.nodes[i]!;
        parts.push(sigs.get(nid) ?? nid);
        if (i < p.relations.length) {
          parts.push(` --${p.relations[i]}--> `);
        }
      }
      const uniqueDims = [...new Set(p.dims)];
      const uniqueRels = [...new Set(p.relations)];
      const dimStr = uniqueDims.length > 0
        ? ` | dims: ${uniqueDims.join("\u2192")}`
        : "";
      const relStr = uniqueRels.length > 0
        ? ` | relations: ${uniqueRels.join(", ")}`
        : "";

      return {
        nodeId: p.nodes[p.nodes.length - 1]!,
        score: p.score,
        text: parts.join("") + dimStr + relStr,
        source: "RPR",
      };
    });
  }

---

[24] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#StrategyDeps
export interface StrategyDeps {}

---

[25] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/composite-callbacks.ts#SourceNodeBuffer.clear
clear(): void {
    this.rowsBySource.clear();
    this.currentSource = null;
  }

---

[26] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/variable-extraction.ts#extractVariableDeclarations
export function extractVariableDeclarations(
  sourceFile: SourceFile,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const varStmt = varDecl.getVariableStatement();
    if (!varStmt?.isExported()) continue;

    const varName = varDecl.getName();
    const initializer = varDecl.getInitializer();
    if (!initializer) continue;

    const nodeId = `${filePath}#${varName}`;

    if (Node.isArrowFunction(initializer)) {
      // export const calculateTaxes = (order: IOrder) => { ... }
      cb.insertNode({
        id: nodeId,
        kind: "ARROW_FUNCTION",
        name: varName,
        filepath: filePath,
        signature: buildArrowSignature(varName, initializer),
        isDeprecated: isDeprecated(varDecl.getSymbol()),
      });
      extractDataFlow(initializer, nodeId, cb);
      traverseAst(initializer, nodeId, cb);
    } else if (Node.isObjectLiteralExpression(initializer)) {
      // export const handlers = { create: (...) => {}, ... }
      cb.insertNode({
        id: nodeId,
        kind: "VARIABLE",
        name: varName,
        filepath: filePath,
        signature: `const ${varName} = { ... }`,
        isDeprecated: isDeprecated(varDecl.getSymbol()),
      });
      extractObjectLiteralMethods(initializer, nodeId, filePath, cb);
    }
  }
}

---

[27] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy.#getNeighbors
#getNeighbors(nodeIds: string[]): ContextChunk[] {
    if (nodeIds.length === 0) return [];

    const rows = this.db.edgeDao.getNeighborhood(nodeIds, { limit: 100 });

    const chunks: ContextChunk[] = [];
    const neighborIds = new Set<string>();
    for (const row of rows) {
      const otherId = nodeIds.includes(row.sourceId) ? row.targetId : row.sourceId;
      neighborIds.add(otherId);
    }

    const sigs = this.db.getNodeSignatures(Array.from(neighborIds));
    for (const id of neighborIds) {
      chunks.push({
        nodeId: id,
        score: 0.5,
        text: sigs.get(id) ?? id,
        source: "AGENTIC",
      });
    }
    return chunks;
  }

---

[28] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.ts#LaCoCoLanceDb
export class LaCoCoLanceDb

---

[29] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/slms/ollama-service.ts#OllamaService
export class OllamaService implements LlmClient

---

[30] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/slms/llm-client.ts#LlmClient
export interface LlmClient {}

---

[31] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/composite-callbacks.ts#CompositeCallbacks
export class CompositeCallbacks implements ExtractionCallbacks

---

[32] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid.create
const create = ({ db, lanceDb }) =>

---

[33] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/slms/ollama-service.ts#OllamaService.generate
async generate(prompt: string, system?: string): Promise<string> {
    const res = await this.#fetch(`${this.endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        system,
        stream: false,
      } as OllamaGenerateRequest),
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${text}`);
    }

    const data = JSON.parse(text) as Record<string, unknown>;
    if (typeof data.response !== "string") {
      throw new Error("Ollama generate no devolvió una respuesta válida");
    }
    return data.response.trim();
  }

---

[34] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/clcr-strategy.ts#ClcrStrategy
export class ClcrStrategy extends AbstractAnchoredStrategy

---

[35] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/ictd-strategy.ts#IctdStrategy
export class IctdStrategy extends AbstractAnchoredStrategy

---

[36] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/rpr-strategy.ts#RprStrategy
export class RprStrategy extends AbstractAnchoredStrategy

---

[37] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/models/strategies/types.ts#RecoveryStrategy
export interface RecoveryStrategy {}

---

[38] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.agentic.create
const create = ({ db, ollama }) =>

---

[39] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/composite-callbacks.ts#SourceNodeBuffer.end
end(): void {
    this.currentSource = null;
  }

---

[40] CLCR | lib#@lancedb/lancedb#whenMatchedUpdateAll
whenMatchedUpdateAll(options?: {
        where: string;
    }): MergeInsertBuilder;

---

[41] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/mini-agents/agent-intermediary/classifier.ts#SlmClassifier
export class SlmClassifier

---

[42] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/mini-agents/agent-intermediary/index.ts#AgentIntermediary1
export class AgentIntermediary1

---

[43] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/inspect/types.ts#InspectQueryOptions
export interface InspectQueryOptions {}

---

[44] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#RetrieveCliOptions
export interface RetrieveCliOptions {}

---

[45] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/abstract-anchored-strategy.ts#AbstractAnchoredStrategy.toChunk
protected toChunk(anchor: HybridAnchor, source: string, score = anchor.score): ContextChunk {
    return {
      nodeId: anchor.nodeId,
      score,
      text: anchor.text,
      source,
    };
  }

---

[46] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-graph-manager/lacoco-sqlite-service.ts#LaCoCoDatabase
export class LaCoCoDatabase

---

[47] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/types.ts#ExtractionCallbacks
export interface ExtractionCallbacks {}

---

[48] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#RetrievedContext
interface RetrievedContext {}

---

[49] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/models/utilities/types.ts#SanitizerOutput
export interface SanitizerOutput {}

---

[50] CLCR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#InspectQueryCliOptions
interface InspectQueryCliOptions {}

### Fin del Contexto

modify the recovery chunks of the strategies based on hybrid to be only 20
```

## Retrieved Chunks

### 1. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/inspect.ts#inspectQuery

- Source: `CLCR`
- Score: `0.0238`

```text
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
```

### 2. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridStrategy

- Source: `CLCR`
- Score: `0.0217`

```text
export class HybridStrategy extends AbstractAnchoredStrategy
```

### 3. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/filters/context-aggregator.ts#ContextAggregator.aggregate

- Source: `CLCR`
- Score: `0.0205`

```text
aggregate(chunks: ContextChunk[], maxTokens = 4000, minScore = 0): ContextChunk[] {

    // 1. Deduplicar por nodeId (quedarse con mayor score)
    const byNode = new Map<string, ContextChunk>();
    for (const chunk of chunks) {
      const existing = byNode.get(chunk.nodeId);
      if (!existing || chunk.score > existing.score) {
        byNode.set(chunk.nodeId, chunk);
      }
    }

    // 2. Filtrar por score mínimo (eliminar ruido de baja relevancia)
    const filtered = Array.from(byNode.values()).filter((c) => c.score >= minScore);

    // 3. Ordenar por score descendente
    const sorted = filtered.sort((a, b) => b.score - a.score);

    // 4. Truncar por tokens aproximados
    const result: ContextChunk[] = [];
    let tokensUsed = 0;

    for (const chunk of sorted) {

      const estimatedTokens = Math.ceil(
        chunk.text.split(/\s+/).length / WORDS_PER_TOKEN
      );

      if (tokensUsed + estimatedTokens > maxTokens) continue;

      result.push(chunk);
      tokensUsed += estimatedTokens;
    }

    return result;
  }
```

### 4. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/composite-callbacks.ts#SourceNodeBuffer

- Source: `CLCR`
- Score: `0.0202`

```text
export class SourceNodeBuffer implements ExtractionCallbacks
```

### 5. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy

- Source: `CLCR`
- Score: `0.0197`

```text
export class AgenticStrategy implements RecoveryStrategy
```

### 6. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/abstract-anchored-strategy.ts#AbstractAnchoredStrategy

- Source: `CLCR`
- Score: `0.0195`

```text
export abstract class AbstractAnchoredStrategy implements RecoveryStrategy
```

### 7. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerRetrieve

- Source: `CLCR`
- Score: `0.0192`

```text
function registerRetrieve(program: Command): void {
  program
    .command("retrieve [project] <query>")
    .description("Ejecuta el pipeline RAG completo y muestra la respuesta del LLM.")
    .option("-s, --strategy <name>", strategyHelp())
    .option("--ollama <url>", "Endpoint de Ollama; por defecto agent.endpoint")
    .option("--no-llm", "Solo muestra chunks recuperados, no llama al LLM")
    .option("-v, --verbose", "Imprime diagnóstico del pipeline en stderr", false)
    .action(async (project: string | undefined, query: string, options: RetrieveCliOptions) => {
      const exitCode = await runRetrieve(query, options, undefined, undefined, project);
      if (exitCode !== 0) process.exitCode = exitCode;
    });
}
```

### 8. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#runRetrieve

- Source: `CLCR`
- Score: `0.0187`

```text
export async function runRetrieve(
  query: string,
  options: RetrieveCliOptions,
  streams: CliStreams = { stdout: process.stdout, stderr: process.stderr },
  runtime: RetrieveRuntime = defaultRetrieveRuntime,
  project?: string,
): Promise<number> {
  const writeStdout = (message: string): void => {
    streams.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
  };
  const writeStderr = (message: string): void => {
    streams.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };

  try {
    const resolvedOptions = resolveRetrieveOptions(options, project);
    const context = await retrieveContext(query, resolvedOptions, streams, runtime);

    if (resolvedOptions.llm && context.chunks.length > 0 && context.sanitized.route === "RAG") {
      const ollama = runtime.createOllama(resolvedOptions.ollama);
      try {
        if (await ollama.isAvailable()) {
          const answer = await ollama.generate(context.enrichedPrompt);
          writeStdout(answer);
        } else {
          writeStderr("[CLI] Ollama no disponible para la respuesta final; se imprime el prompt enriquecido.");
          writeStdout(context.enrichedPrompt);
        }
      } finally {
        ollama.abort();
      }
    } else {
      writeStdout(context.enrichedPrompt);
    }

    if (resolvedOptions.verbose) writeStderr("[CLI] retrieve completado");
    return 0;
  } catch (err) {
    const stage = err instanceof PipelineStageError ? err.stage : "inicialización";
    writeStderr(`[CLI] Error en pipeline RAG (${stage}): ${formatError(err)}`);
    return 1;
  }
}
```

### 9. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/hybrid-anchor-service.ts#HybridAnchor

- Source: `CLCR`
- Score: `0.0179`

```text
export interface HybridAnchor {}
```

### 10. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#runContextExport

- Source: `CLCR`
- Score: `0.0176`

```text
export async function runContextExport(
  query: string,
  options: ContextExportCliOptions,
  streams: CliStreams = { stdout: process.stdout, stderr: process.stderr },
  runtime: RetrieveRuntime = defaultRetrieveRuntime,
  project?: string,
): Promise<number> {
  const writeStdout = (message: string): void => {
    streams.stdout.write(message.endsWith("\n") ? message : `${message}\n`);
  };
  const writeStderr = (message: string): void => {
    streams.stderr.write(message.endsWith("\n") ? message : `${message}\n`);
  };

  try {
    const resolvedOptions = resolveRetrieveOptions({ ...options, llm: false }, project);
    const context = await retrieveContext(query, resolvedOptions, streams, runtime);
    const markdown = renderContextMarkdown(context);
    const outputPath = path.resolve(options.output);
    writeTextFileAtomic(outputPath, markdown);

    if (options.json) {
      writeStdout(JSON.stringify({
        id: context.id,
        output: outputPath,
        query: context.originalQuery,
        strategy: context.options.strategy,
        chunks: context.chunks.length,
      }, null, 2));
    } else {
      writeStdout(`Contexto exportado: ${outputPath}`);
    }

    return 0;
  } catch (err) {
    const stage = err instanceof PipelineStageError ? err.stage : "exportación";
    writeStderr(`[CLI] Error exportando contexto (${stage}): ${formatError(err)}`);
    return 1;
  }
}
```

### 11. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy.retrieve

- Source: `CLCR`
- Score: `0.0171`

```text
async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    // Fase 1: recuperar símbolos semilla por BM25
    const seedResults = this.bm25.search(query.clean_query, 5);
    const collected = new Map<string, ContextChunk>();

    for (const hit of seedResults) {
      collected.set(hit.nodeId, {
        nodeId: hit.nodeId,
        score: hit.score,
        text: hit.text,
        source: "AGENTIC",
      });
    }

    // Fase 2: ciclo agente-executor con SLM (Ollama)
    if (await this.ollama.isAvailable()) {
      const contextHistory: string[] = [];

      for (let i = 0; i < this.maxIterations && collected.size < 50; i++) {
        const toolCall = await this.#planTool(query, Array.from(collected.keys()), contextHistory);
        if (!toolCall) break;

        const results = this.#executeTool(toolCall);
        if (results.length === 0) break;

        for (const chunk of results) {
          if (!collected.has(chunk.nodeId)) {
            collected.set(chunk.nodeId, chunk);
          }
        }

        contextHistory.push(`Tool: ${toolCall.name}(${JSON.stringify(toolCall.params)}) → ${results.length} resultados`);
      }
    } else {
      // Fallback determinístico: expansión por vecindad pura
      for (let i = 0; i < this.maxIterations && collected.size < 50; i++) {
        const currentIds = Array.from(collected.keys());
        const neighbors = this.#getNeighbors(currentIds);
        for (const n of neighbors) {
          if (!collected.has(n.nodeId)) {
            collected.set(n.nodeId, n);
          }
        }
      }
    }

    return Array.from(collected.values()).sort((a, b) => b.score - a.score);
  }
```

### 12. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/inspect.ts#inspect

- Source: `CLCR`
- Score: `0.0170`

```text
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
```

### 13. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#createRetrievedContext

- Source: `CLCR`
- Score: `0.0169`

```text
function createRetrievedContext(
  originalQuery: string,
  options: ResolvedRetrieveCliOptions,
  sanitized: SanitizerOutput,
  chunks: RetrievedContext["chunks"],
  enrichedPrompt: string,
): RetrievedContext {
  return {
    id: createContextId(originalQuery),
    generatedAt: new Date().toISOString(),
    originalQuery,
    options: {
      strategy: options.strategy,
      db: options.db,
      lancedb: options.lancedb,
      ollama: options.ollama,
    },
    sanitized,
    chunks,
    enrichedPrompt,
  };
}
```

### 14. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/daemon.ts#DaemonManager.#coldStart

- Source: `CLCR`
- Score: `0.0167`

```text
#coldStart(): void {
    console.log("\n[Daemon] Cold start — analizando proyecto completo...");
    console.time("[Daemon] Cold start");

    const sourceFiles = this.project.getSourceFiles();
    const total = sourceFiles.length;
    console.log(`[Daemon]    ${total} archivos TypeScript encontrados.`);

    this.sqliteCallbacks.nodesWritten = 0;
    this.sqliteCallbacks.edgesWritten = 0;

    this.db.transaction(() => {
      this.db.clearGraph();
      this.vectorNodeBuffer.clear();
      for (const file of sourceFiles) {
        if (this.verbose) {
          console.log(`[Daemon]    ✍  ${file.getFilePath()}`);
        }
        this.#safeProcessFile(file);
      }
    });
    this.db.populateMetadata();

    console.timeEnd("[Daemon] Cold start");
    console.log(
      `[Daemon] ✅ Grafo construido — ${this.sqliteCallbacks.nodesWritten} nodos, ${this.sqliteCallbacks.edgesWritten} aristas.`
    );

    if (this.indexVectors && this.sqliteCallbacks.nodesWritten > 0) {
      this.vectorsPromise = this.#generateEmbeddings();
    }
  }
```

### 15. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/hybrid-anchor-service.ts#HybridAnchorService

- Source: `CLCR`
- Score: `0.0162`

```text
export class HybridAnchorService
```

### 16. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/ictd-strategy.ts#IctdStrategy.expand

- Source: `CLCR`
- Score: `0.0158`

```text
protected async expand(anchorResults: HybridAnchor[], query: SanitizerOutput): Promise<ContextChunk[]> {
    const weights = getIntentWeights(query.intent, query.dimensions);

    const anchorIds = new Set<string>();
    const anchorHeat = new Map<string, number>();
    for (const r of anchorResults) {
      anchorHeat.set(r.nodeId, r.score);
      anchorIds.add(r.nodeId);
    }

    const { outAdj, inDeg } = this.#buildSubgraph(Array.from(anchorIds));

    if (outAdj.size === 0) {
      return anchorResults.map((anchor) =>
        this.toChunk(anchor, "ICTD", anchorHeat.get(anchor.nodeId) ?? 0.5)
      );
    }

    const allIds = Array.from(outAdj.keys());
    let heat = new Map<string, number>();
    const init = new Map<string, number>();
    for (const id of allIds) {
      init.set(id, anchorHeat.get(id) ?? 0);
      heat.set(id, anchorHeat.get(id) ?? 0);
    }

    const alpha = this.config.restartProb;
    for (let iter = 0; iter < this.config.maxIterations; iter++) {
      const next = new Map<string, number>();
      for (const id of allIds) next.set(id, 0);

      for (const [src, dims] of outAdj) {
        const hSrc = heat.get(src) ?? 0;
        for (const dim of ["SYS", "CPG", "DTG"] as Dim[]) {
          const tgts = dims[dim];
          if (tgts.length === 0) continue;
          const w = weights[dim];

          if (hSrc > 0) {
            const contrib = (hSrc * w) / tgts.length;
            for (const tgt of tgts) {
              next.set(tgt, (next.get(tgt) ?? 0) + contrib);
            }
          }

          for (const tgt of tgts) {
            const hTgt = heat.get(tgt) ?? 0;
            if (hTgt <= 0) continue;
            const deg = inDeg.get(tgt)?.[dim] ?? 1;
            const contrib = (hTgt * w) / deg;
            next.set(src, (next.get(src) ?? 0) + contrib);
          }
        }
      }

      for (const id of allIds) {
        const val = next.get(id) ?? 0;
        next.set(id, val * (1 - alpha) + (init.get(id) ?? 0) * alpha);
      }

      let maxDiff = 0;
      for (const id of allIds) {
        const diff = Math.abs((next.get(id) ?? 0) - (heat.get(id) ?? 0));
        if (diff > maxDiff) maxDiff = diff;
      }

      heat = next;
      if (maxDiff < this.config.epsilon) break;
    }

    const ranked = allIds
      .filter((id) => (heat.get(id) ?? 0) > 0.001)
      .sort((a, b) => (heat.get(b) ?? 0) - (heat.get(a) ?? 0))
      .slice(0, this.config.chunkLimit);

    const sigs = this.db.getNodeSignatures(ranked);

    return ranked.map((id) => ({
      nodeId: id,
      score: heat.get(id) ?? 0,
      text: sigs.get(id) ?? id,
      source: "ICTD",
    }));
  }
```

### 17. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerInspectQuery

- Source: `CLCR`
- Score: `0.0156`

```text
function registerInspectQuery(program: Command): void {
  program
    .command("inspect-query [project] <prompt>")
    .description("Pipeline RAG completo → visualización del subgrafo recuperado para un prompt.")
    .option("-b, --budget <num>", "Máximo de nodos a expandir", "75")
    .option("-s, --strategy <name>", strategyHelp())
    .option("-m, --mode <mode>", "Modo de visualización (default, tensor, scores)", "default")
    .option("-o, --output <path>", "Archivo HTML de salida", "inspect-query.html")
    .option("--cdn", "Usar CDN para Cytoscape.js en vez de embeberlo", false)
    .option("--ollama <url>", "Endpoint de Ollama; por defecto agent.endpoint")
    .action(async (project: string | undefined, prompt: string, options: InspectQueryCliOptions) => {
      const budget = parseBudget(options.budget);
      if (budget === null) return;
      const mode = ["default", "tensor", "scores"].includes(options.mode)
        ? options.mode as "default" | "tensor" | "scores"
        : "default";
      const ollamaEndpoint = options.ollama ?? resolveStringConfig("agent.endpoint");
      const projectPath = resolveInspectQueryProjectPath(project);
      await inspectQuery({
        prompt,
        db: resolveDbPath(projectPath),
        lancedb: resolveLanceDbPath(projectPath),
        budget,
        strategy: options.strategy ?? resolveStringConfig("strategy.default"),
        mode,
        output: options.output,
        cdn: options.cdn,
        ollama: ollamaEndpoint,
        model: resolveStringConfig("agent.model"),
        timeoutMs: resolveNumberConfig("timeout.ms"),
      });
    });
}
```

### 18. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/callable-analysis.ts#consumesFromParam

- Source: `CLCR`
- Score: `0.0154`

```text
function consumesFromParam(
  param: ParameterDeclaration,
  sourceId: string,
  cb: ExtractionCallbacks,
): void {
  const type = param.getType();

  if (type.isObject() && !type.isAny()) {
    const targetId = resolveTypeToId(type);
    if (targetId) cb.insertEdge(sourceId, targetId, "CONSUMES_DATA");
    return;
  }

  if (type.isArray()) {
    const elementType = type.getArrayElementType();
    if (elementType) {
      const targetId = resolveTypeToId(elementType);
      if (targetId) cb.insertEdge(sourceId, targetId, "CONSUMES_DATA");
    }
    return;
  }

  if (type.isIntersection()) {
    for (const member of type.getIntersectionTypes()) {
      const targetId = resolveTypeToId(member);
      if (targetId) cb.insertEdge(sourceId, targetId, "CONSUMES_DATA");
    }
    return;
  }

  if (type.isUnion()) {
    for (const member of type.getUnionTypes()) {
      if (!member.isNull() && !member.isUndefined()) {
        const targetId = resolveTypeToId(member);
        if (targetId) cb.insertEdge(sourceId, targetId, "CONSUMES_DATA");
      }
    }
  }
}
```

### 19. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#strategyHelp

- Source: `CLCR`
- Score: `0.0152`

```text
export function strategyHelp(): string {
  return `Estrategia de recuperación (${STRATEGY_NAMES.join(", ")}); por defecto strategy.default`;
}
```

### 20. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy.#planTool

- Source: `CLCR`
- Score: `0.0151`

```text
async #planTool(
    query: SanitizerOutput,
    currentIds: string[],
    history: string[]
  ): Promise<Tool | null> {
    const systemPrompt = `Eres un planificador de recuperación de código. Tienes estas herramientas:
- get_neighbors(node_id): recupera nodos conectados por aristas.
- get_node_by_symbol(name): busca un nodo por nombre de símbolo.
- get_dependencies(package, version): busca dependencias externas.

Usa herramientas solo cuando aporten contexto adicional concreto. Si los nodos actuales ya cubren la consulta,
responde {"done": true}. No inventes nombres de nodos, paquetes ni versiones.

Responde SOLO con un JSON de la forma: {"name": "...", "params": {...}}.
Si no necesitas más herramientas, responde: {"done": true}.`;

    const prompt = `Consulta: "${query.embedding_input}"\nNodos actuales: [${currentIds.join(", ")}]\nHistorial: ${history.join("; ") || "ninguno"}`;

    try {
      const response = await this.ollama.chat(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: prompt },
        ]
      );

      if (response.includes('"done"')) return null;

      // Extraer JSON de la respuesta (puede venir con markdown)
      const jsonMatch = response.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;

      const parsed = JSON.parse(jsonMatch[0]) as { name: string; params: Record<string, unknown> };
      if (["get_neighbors", "get_node_by_symbol", "get_dependencies"].includes(parsed.name)) {
        return {
          name: parsed.name as Tool["name"],
          params: Object.fromEntries(
            Object.entries(parsed.params).map(([k, v]) => [k, String(v)])
          ),
        };
      }
    } catch (err) {
      console.warn(
        "[AgenticStrategy] ⚠️  SLM falló en planTool:",
        err instanceof Error ? err.message : String(err)
      );
    }
    return null;
  }
```

### 21. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#renderContextMarkdown

- Source: `CLCR`
- Score: `0.0149`

```text
function renderContextMarkdown(context: RetrievedContext): string {
  const frontMatter = [
    "---",
    "lacoco_export_version: 1",
    `context_id: ${yamlString(context.id)}`,
    `question: ${yamlString(context.originalQuery)}`,
    `generated_at: ${yamlString(context.generatedAt)}`,
    `strategy: ${yamlString(context.options.strategy)}`,
    `route: ${yamlString(context.sanitized.route)}`,
    `intent: ${yamlString(context.sanitized.intent)}`,
    `confidence: ${context.sanitized.confidence}`,
    `dimensions: [${context.sanitized.dimensions.map(yamlString).join(", ")}]`,
    `chunks: ${context.chunks.length}`,
    "---",
    "",
  ].join("\n");

  const chunkSections = context.chunks.length === 0
    ? "No se recuperaron chunks para esta consulta.\n"
    : context.chunks.map((chunk, index) => [
      `### ${index + 1}. ${chunk.nodeId}`,
      "",
      `- Source: \`${chunk.source}\``,
      `- Score: \`${chunk.score.toFixed(4)}\``,
      "",
      fencedBlock(chunk.text),
    ].join("\n")).join("\n\n");

  return `${frontMatter}# LaCoCo Context Export

## Question

${context.originalQuery}

## Retrieval Metadata

| Field | Value |
|---|---|
| Context ID | \`${context.id}\` |
| Generated at | ${context.generatedAt} |
| Strategy | \`${context.options.strategy}\` |
| Route | \`${context.sanitized.route}\` |
| Intent | \`${context.sanitized.intent}\` |
| Confidence | \`${context.sanitized.confidence.toFixed(2)}\` |
| Dimensions | ${context.sanitized.dimensions.length > 0 ? context.sanitized.dimensions.map((dim) => `\`${dim}\``).join(", ") : "-"} |
| SQLite | \`${context.options.db}\` |
| LanceDB | \`${context.options.lancedb}\` |

## Clean Query

${fencedBlock(context.sanitized.clean_query || "(empty)")}

## Embedding Input

${fencedBlock(context.sanitized.embedding_input)}

## Enriched Prompt

${fencedBlock(context.enrichedPrompt)}

## Retrieved Chunks

${chunkSections}
`;
}
```

### 22. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid

- Source: `CLCR`
- Score: `0.0147`

```text
hybrid: { ... }
```

### 23. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/rpr-strategy.ts#RprStrategy.expand

- Source: `CLCR`
- Score: `0.0147`

```text
protected async expand(anchorResults: HybridAnchor[], _query: SanitizerOutput): Promise<ContextChunk[]> {
    const anchorScores = new Map<string, number>();
    const anchorIds = new Set<string>();
    for (const r of anchorResults) {
      anchorScores.set(r.nodeId, r.score);
      anchorIds.add(r.nodeId);
    }

    const { outgoingEdges, nodeRelevance } = this.#buildSubgraph(
      Array.from(anchorIds),
      anchorScores
    );

    const allNodeIds = new Set(nodeRelevance.keys());
    for (const edges of outgoingEdges.values()) {
      for (const e of edges) allNodeIds.add(e.targetId);
    }

    const paths = this.#enumeratePaths(Array.from(anchorIds), outgoingEdges);

    if (paths.length === 0) {
      return anchorResults.map((anchor) =>
        this.toChunk(anchor, "RPR", anchorScores.get(anchor.nodeId) ?? 0.5)
      );
    }

    const scored = this.#scorePaths(paths, nodeRelevance);

    const seen = new Set<string>();
    const ranked = scored
      .sort((a, b) => b.score - a.score)
      .filter((p) => {
        if (seen.has(p.hash)) return false;
        seen.add(p.hash);
        return true;
      })
      .slice(0, this.config.chunkLimit);

    const sigNodes = new Set<string>();
    for (const p of ranked) for (const n of p.nodes) sigNodes.add(n);
    const idArr = Array.from(sigNodes) as string[];
    const sigs = this.db.getNodeSignatures(idArr);

    return ranked.map((p) => {
      const parts: string[] = [];
      for (let i = 0; i < p.nodes.length; i++) {
        const nid = p.nodes[i]!;
        parts.push(sigs.get(nid) ?? nid);
        if (i < p.relations.length) {
          parts.push(` --${p.relations[i]}--> `);
        }
      }
      const uniqueDims = [...new Set(p.dims)];
      const uniqueRels = [...new Set(p.relations)];
      const dimStr = uniqueDims.length > 0
        ? ` | dims: ${uniqueDims.join("\u2192")}`
        : "";
      const relStr = uniqueRels.length > 0
        ? ` | relations: ${uniqueRels.join(", ")}`
        : "";

      return {
        nodeId: p.nodes[p.nodes.length - 1]!,
        score: p.score,
        text: parts.join("") + dimStr + relStr,
        source: "RPR",
      };
    });
  }
```

### 24. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#StrategyDeps

- Source: `CLCR`
- Score: `0.0144`

```text
export interface StrategyDeps {}
```

### 25. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/composite-callbacks.ts#SourceNodeBuffer.clear

- Source: `CLCR`
- Score: `0.0141`

```text
clear(): void {
    this.rowsBySource.clear();
    this.currentSource = null;
  }
```

### 26. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/variable-extraction.ts#extractVariableDeclarations

- Source: `CLCR`
- Score: `0.0139`

```text
export function extractVariableDeclarations(
  sourceFile: SourceFile,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const varStmt = varDecl.getVariableStatement();
    if (!varStmt?.isExported()) continue;

    const varName = varDecl.getName();
    const initializer = varDecl.getInitializer();
    if (!initializer) continue;

    const nodeId = `${filePath}#${varName}`;

    if (Node.isArrowFunction(initializer)) {
      // export const calculateTaxes = (order: IOrder) => { ... }
      cb.insertNode({
        id: nodeId,
        kind: "ARROW_FUNCTION",
        name: varName,
        filepath: filePath,
        signature: buildArrowSignature(varName, initializer),
        isDeprecated: isDeprecated(varDecl.getSymbol()),
      });
      extractDataFlow(initializer, nodeId, cb);
      traverseAst(initializer, nodeId, cb);
    } else if (Node.isObjectLiteralExpression(initializer)) {
      // export const handlers = { create: (...) => {}, ... }
      cb.insertNode({
        id: nodeId,
        kind: "VARIABLE",
        name: varName,
        filepath: filePath,
        signature: `const ${varName} = { ... }`,
        isDeprecated: isDeprecated(varDecl.getSymbol()),
      });
      extractObjectLiteralMethods(initializer, nodeId, filePath, cb);
    }
  }
}
```

### 27. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy.#getNeighbors

- Source: `CLCR`
- Score: `0.0139`

```text
#getNeighbors(nodeIds: string[]): ContextChunk[] {
    if (nodeIds.length === 0) return [];

    const rows = this.db.edgeDao.getNeighborhood(nodeIds, { limit: 100 });

    const chunks: ContextChunk[] = [];
    const neighborIds = new Set<string>();
    for (const row of rows) {
      const otherId = nodeIds.includes(row.sourceId) ? row.targetId : row.sourceId;
      neighborIds.add(otherId);
    }

    const sigs = this.db.getNodeSignatures(Array.from(neighborIds));
    for (const id of neighborIds) {
      chunks.push({
        nodeId: id,
        score: 0.5,
        text: sigs.get(id) ?? id,
        source: "AGENTIC",
      });
    }
    return chunks;
  }
```

### 28. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.ts#LaCoCoLanceDb

- Source: `CLCR`
- Score: `0.0139`

```text
export class LaCoCoLanceDb
```

### 29. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/slms/ollama-service.ts#OllamaService

- Source: `CLCR`
- Score: `0.0139`

```text
export class OllamaService implements LlmClient
```

### 30. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/slms/llm-client.ts#LlmClient

- Source: `CLCR`
- Score: `0.0138`

```text
export interface LlmClient {}
```

### 31. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/composite-callbacks.ts#CompositeCallbacks

- Source: `CLCR`
- Score: `0.0128`

```text
export class CompositeCallbacks implements ExtractionCallbacks
```

### 32. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid.create

- Source: `CLCR`
- Score: `0.0127`

```text
const create = ({ db, lanceDb }) =>
```

### 33. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/slms/ollama-service.ts#OllamaService.generate

- Source: `CLCR`
- Score: `0.0122`

```text
async generate(prompt: string, system?: string): Promise<string> {
    const res = await this.#fetch(`${this.endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        system,
        stream: false,
      } as OllamaGenerateRequest),
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${text}`);
    }

    const data = JSON.parse(text) as Record<string, unknown>;
    if (typeof data.response !== "string") {
      throw new Error("Ollama generate no devolvió una respuesta válida");
    }
    return data.response.trim();
  }
```

### 34. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/clcr-strategy.ts#ClcrStrategy

- Source: `CLCR`
- Score: `0.0117`

```text
export class ClcrStrategy extends AbstractAnchoredStrategy
```

### 35. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/ictd-strategy.ts#IctdStrategy

- Source: `CLCR`
- Score: `0.0117`

```text
export class IctdStrategy extends AbstractAnchoredStrategy
```

### 36. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/rpr-strategy.ts#RprStrategy

- Source: `CLCR`
- Score: `0.0117`

```text
export class RprStrategy extends AbstractAnchoredStrategy
```

### 37. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/models/strategies/types.ts#RecoveryStrategy

- Source: `CLCR`
- Score: `0.0116`

```text
export interface RecoveryStrategy {}
```

### 38. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.agentic.create

- Source: `CLCR`
- Score: `0.0115`

```text
const create = ({ db, ollama }) =>
```

### 39. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/composite-callbacks.ts#SourceNodeBuffer.end

- Source: `CLCR`
- Score: `0.0113`

```text
end(): void {
    this.currentSource = null;
  }
```

### 40. lib#@lancedb/lancedb#whenMatchedUpdateAll

- Source: `CLCR`
- Score: `0.0112`

```text
whenMatchedUpdateAll(options?: {
        where: string;
    }): MergeInsertBuilder;
```

### 41. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/mini-agents/agent-intermediary/classifier.ts#SlmClassifier

- Source: `CLCR`
- Score: `0.0111`

```text
export class SlmClassifier
```

### 42. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/mini-agents/agent-intermediary/index.ts#AgentIntermediary1

- Source: `CLCR`
- Score: `0.0111`

```text
export class AgentIntermediary1
```

### 43. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/inspect/types.ts#InspectQueryOptions

- Source: `CLCR`
- Score: `0.0111`

```text
export interface InspectQueryOptions {}
```

### 44. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#RetrieveCliOptions

- Source: `CLCR`
- Score: `0.0108`

```text
export interface RetrieveCliOptions {}
```

### 45. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/abstract-anchored-strategy.ts#AbstractAnchoredStrategy.toChunk

- Source: `CLCR`
- Score: `0.0100`

```text
protected toChunk(anchor: HybridAnchor, source: string, score = anchor.score): ContextChunk {
    return {
      nodeId: anchor.nodeId,
      score,
      text: anchor.text,
      source,
    };
  }
```

### 46. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-graph-manager/lacoco-sqlite-service.ts#LaCoCoDatabase

- Source: `CLCR`
- Score: `0.0099`

```text
export class LaCoCoDatabase
```

### 47. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/types.ts#ExtractionCallbacks

- Source: `CLCR`
- Score: `0.0096`

```text
export interface ExtractionCallbacks {}
```

### 48. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#RetrievedContext

- Source: `CLCR`
- Score: `0.0095`

```text
interface RetrievedContext {}
```

### 49. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/models/utilities/types.ts#SanitizerOutput

- Source: `CLCR`
- Score: `0.0095`

```text
export interface SanitizerOutput {}
```

### 50. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#InspectQueryCliOptions

- Source: `CLCR`
- Score: `0.0087`

```text
interface InspectQueryCliOptions {}
```
