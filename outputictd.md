---
lacoco_export_version: 1
context_id: "b79ed9fda285e438"
question: "modify the recovery chunks of the strategies based on hybrid to be only 20"
generated_at: "2026-06-27T23:19:00.364Z"
strategy: "ictd"
route: "RAG"
intent: "refactor"
confidence: 0.98
dimensions: ["CPG", "DTG"]
chunks: 38
---
# LaCoCo Context Export

## Question

modify the recovery chunks of the strategies based on hybrid to be only 20

## Retrieval Metadata

| Field | Value |
|---|---|
| Context ID | `b79ed9fda285e438` |
| Generated at | 2026-06-27T23:19:00.364Z |
| Strategy | `ictd` |
| Route | `RAG` |
| Intent | `refactor` |
| Confidence | `0.98` |
| Dimensions | `CPG`, `DTG` |
| SQLite | `/home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/.lacoco/tensor.sqlite` |
| LanceDB | `/home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/.lacoco/lancedb` |

## Clean Query

```text
strategies recovery chunks hybrid modify only 20
```

## Embedding Input

```text
Modificar los píechos de recuperación de estrategias basándome en el hybrid para que sean solo 20
```

## Enriched Prompt

```text
### Contexto del Proyecto (recuperado automáticamente)
Los siguientes fragmentos de código fueron recuperados del repositorio actual
como contexto para tu consulta. Úsalos como referencia absoluta de firmas,
tipos y dependencias locales, y sobre todo, como ubicación de archivos. 
No inventes símbolos que no aparezcan aquí.

[1] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/abstract-anchored-strategy.ts#AbstractAnchoredStrategy
export abstract class AbstractAnchoredStrategy implements RecoveryStrategy

---

[2] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-graph-manager/lacoco-sqlite-service.ts#LaCoCoDatabase
export class LaCoCoDatabase

---

[3] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridStrategy
export class HybridStrategy extends AbstractAnchoredStrategy

---

[4] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/ictd-strategy.ts#IctdStrategy
export class IctdStrategy extends AbstractAnchoredStrategy

---

[5] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.ts#LaCoCoLanceDb
export class LaCoCoLanceDb

---

[6] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#StrategyDeps
export interface StrategyDeps {}

---

[7] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/hybrid-anchor-service.ts#HybridAnchorService
export class HybridAnchorService

---

[8] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/hybrid-anchor-service.ts#HybridAnchor
export interface HybridAnchor {}

---

[9] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid
hybrid: { ... }

---

[10] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#getStrategyEntry
export function getStrategyEntry(strategyName: string): StrategyEntry {
  if (!isStrategyName(strategyName)) {
    throw new Error(`Estrategia no soportada: ${strategyName}`);
  }
  return STRATEGY_REGISTRY[strategyName];
}

---

[11] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid.create
const create = ({ db, lanceDb }) =>

---

[12] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/daemon.ts#DaemonManager.#handleFileChange
async #handleFileChange(
    filePath: string,
    event: "change" | "add"
  ): Promise<void> {
    const label = `[Daemon] 🔥 Hot reload [${event}] ${path.relative(process.cwd(), filePath)}`;
    console.time(label);

    try {
      // ── Step 1: Obtener / refrescar el SourceFile en ts-morph ────────────
      const existing = this.project.getSourceFile(filePath);
      let sourceFile: SourceFile;

      if (event === "add" || !existing) {
        sourceFile = this.project.addSourceFileAtPath(filePath);
        console.log(`[Daemon]    ➕ Nuevo archivo incorporado al proyecto.`);
      } else {
        // Recarga el AST del archivo modificado desde el sistema de archivos
        existing.refreshFromFileSystemSync();
        sourceFile = existing;
      }

      // ── Step 2 (F7): Archivos que importan el archivo modificado ─────────
      // Cuando los tipos de un archivo cambian, los archivos que lo importan
      // pueden tener firmas y aristas desactualizadas en la DB.
      // getReferencingSourceFiles() usa el grafo de importaciones de ts-morph.
      const referencingFiles = sourceFile
        .getReferencingSourceFiles()
        .filter((f) => !f.getFilePath().includes("node_modules"));

      if (referencingFiles.length > 0 && this.verbose) {
        console.log(
          `[Daemon]    🔗 ${referencingFiles.length} archivo(s) dependiente(s) detectados para propagación.`
        );
      }

      // Cap: si hay demasiados dependientes (p.ej. un módulo barrel muy importado),
      // limitamos la propagación para no bloquear el event-loop.
      const MAX_PROPAGATION = 50;
      const filesToPropagate = referencingFiles.slice(0, MAX_PROPAGATION);
      if (referencingFiles.length > MAX_PROPAGATION) {
        console.warn(
          `[Daemon] ⚠  ${referencingFiles.length} dependientes detectados; ` +
            `solo se re-procesarán ${MAX_PROPAGATION}. ` +
            `El grafo puede estar parcialmente desactualizado hasta el próximo cold-start.`
        );
      }

      // ── Steps 3–5 (F2): Purge + reprocess en UNA transacción atómica ─────
      // Al ser atómica: si falla en mitad del re-proceso, el grafo vuelve
      // al estado anterior (rollback automático de SQLite).
      this.sqliteCallbacks.nodesWritten = 0;
      this.sqliteCallbacks.edgesWritten = 0;

      let allPurgedIds: string[] = [];

      this.db.transaction(() => {
        // 3. Purgar el archivo modificado y re-procesarlo con el AST fresco
        const purgedIds = this.#purgeFile(filePath);
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

      console.log(
        `[Daemon]    ↳ ${this.sqliteCallbacks.nodesWritten} nodos, ${this.sqliteCallbacks.edgesWritten} aristas actualizados` +
          (filesToPropagate.length > 0
            ? ` (+ ${filesToPropagate.length} archivo(s) propagados).`
            : ".")
      );

      // Hot-reload de vectores (LanceDB)
      if (this.indexVectors) {
        this.#enqueueVectorUpdates([
          filePath,
          ...filesToPropagate.map((dep) => dep.getFilePath()),
        ]);
      }
    } catch (err) {
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  }

---

[13] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#strategyHelp
export function strategyHelp(): string {
  return `Estrategia de recuperación (${STRATEGY_NAMES.join(", ")}); por defecto strategy.default`;
}

---

[14] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/inspect.ts#inspectQuery
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

[15] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridConfig
export interface HybridConfig {}

---

[16] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridStrategy::config
private readonly config: HybridConfig;

---

[17] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#StrategyEntry
export interface StrategyEntry {}

---

[18] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerInspect
function registerInspect(program: Command): void {
  program
    .command("inspect <root-node>")
    .description("Visualiza el subgrafo alrededor de un nodo usando expansión BFS con budget.")
    .option("-b, --budget <num>", "Máximo de nodos a expandir", "75")
    .option("-f, --focus <dim>", "Prioridad dimensional: SYS, CPG, DTG, ALL", "ALL")
    .option("-o, --output <path>", "Archivo HTML de salida", "inspect.html")
    .option("--cdn", "Usar CDN para Cytoscape.js en vez de embeberlo", false)
    .action(async (rootNode: string, options: InspectCliOptions) => {
      const budget = parseBudget(options.budget);
      if (budget === null) return;
      const focus = ["SYS", "CPG", "DTG", "ALL"].includes(options.focus)
        ? options.focus as "SYS" | "CPG" | "DTG" | "ALL"
        : "ALL";
      await inspect({
        rootNode,
        db: resolveDbPath(process.cwd()),
        budget,
        focus,
        output: options.output,
        cdn: options.cdn,
      });
    });
}

---

[19] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerInspectQuery
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

[20] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.ictd.create
const create = ({ db, lanceDb }) =>

---

[21] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/filters/context-aggregator.ts#ContextAggregator.aggregate
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

[22] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/inspect.ts#inspect
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

[23] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#parseBudget
function parseBudget(value: string): number | null {
  const budget = Number.parseInt(value, 10);
  if (Number.isNaN(budget) || budget < 1) {
    console.error("[CLI] ❌ --budget debe ser un número positivo.");
    process.exitCode = 1;
    return null;
  }
  return budget;
}

---

[24] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy.#planTool
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

[25] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerRetrieve
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

[26] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-graph-manager/lacoco-sqlite-service.ts#LaCoCoDatabase::searchDao
readonly searchDao: SearchDao;

---

[27] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/state-commands.ts#registerConfigCommands
function registerConfigCommands(program: Command): void {
  const command = program
    .command("config")
    .description("Consulta y modifica configuración de LaCoCo.");

  command
    .command("list")
    .description("Lista las claves de configuración resueltas y su origen.")
    .option("--json", "Imprime JSON válido", false)
    .action((options: JsonOption) => {
      runCliCommand(() => {
        const entries = listConfig();
        if (options.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }
        console.log(formatTable(["KEY", "VALUE", "SOURCE"], entries.map((entry) => [
          entry.key,
          String(entry.value),
          entry.source,
        ])));
      });
    });

  command
    .command("get <key>")
    .description("Muestra una clave de configuración resuelta.")
    .option("--json", "Imprime JSON válido", false)
    .action((key: string, options: JsonOption) => {
      runCliCommand(() => {
        const entry = resolveConfig(key);
        console.log(options.json ? JSON.stringify(entry, null, 2) : `${entry.value} (${entry.source})`);
      });
    });

  command
    .command("set <key> <value>")
    .description("Guarda una clave de configuración en el alcance seleccionado.")
    .option("--global", "Escribe en la configuración global del usuario", false)
    .option("--local", "Escribe en la configuración local del proyecto", false)
    .option("--json", "Imprime JSON válido", false)
    .action((key: string, value: string, options: ConfigScopeOptions) => {
      runCliCommand(() => {
        const scope = resolveWritableScope(options);
        setConfig(key, value, scope);
        const entry = resolveConfig(key);
        console.log(options.json
          ? JSON.stringify({ scope, entry }, null, 2)
          : `${key}=${entry.value} escrito en ${scope}`);
      });
    });

  command
    .command("unset <key>")
    .description("Elimina una clave de configuración del alcance seleccionado.")
    .option("--global", "Elimina desde la configuración global del usuario", false)
    .option("--local", "Elimina desde la configuración local del proyecto", false)
    .option("--json", "Imprime JSON válido", false)
    .action((key: string, options: ConfigScopeOptions) => {
      runCliCommand(() => {
        const scope = resolveWritableScope(options);
        unsetConfig(key, scope);
        console.log(options.json
          ? JSON.stringify({ key, scope, unset: true }, null, 2)
          : `${key} eliminado de ${scope}`);
      });
    });

  command
    .command("path")
    .description("Muestra la ruta de archivo para configuración global o local.")
    .option("--global", "Muestra la ruta global", false)
    .option("--local", "Muestra la ruta local", false)
    .option("--json", "Imprime JSON válido", false)
    .action((options: ConfigScopeOptions) => {
      runCliCommand(() => {
        const scope = resolveWritableScope(options);
        const filePath = getConfigPath(scope);
        console.log(options.json
          ? JSON.stringify({ scope, path: filePath }, null, 2)
          : filePath);
      });
    });

  command
    .command("keys")
    .description("Lista las claves de configuración válidas.")
    .action(() => runCliCommand(() => console.log(configKeys().join("\n"))));
}

---

[28] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/strategy-names.ts#isStrategyName
export function isStrategyName(value: string): value is StrategyName {
  return (STRATEGY_NAMES as readonly string[]).includes(value);
}

---

[29] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/helpers/graph-traversal.ts#prioritizedBreadthFirstTraversal
export function prioritizedBreadthFirstTraversal(
  roots: readonly string[],
  getNeighbors: (nodeId: string) => string[],
  options: PrioritizedBfsOptions,
): Set<string> {
  const visited = new Set(roots);
  const frontier = new Map<string, number>();
  const add = (nodeId: string) => {
    if (!visited.has(nodeId)) frontier.set(nodeId, (frontier.get(nodeId) ?? 0) + 1);
  };

  for (const root of roots) for (const neighbor of getNeighbors(root)) add(neighbor);

  while (visited.size < options.budget && frontier.size > 0) {
    let bestId = "";
    let bestPriority = -Infinity;
    for (const [nodeId, edgeCount] of frontier) {
      const priority = options.priority(nodeId, edgeCount);
      if (priority > bestPriority) {
        bestPriority = priority;
        bestId = nodeId;
      }
    }
    frontier.delete(bestId);
    visited.add(bestId);
    for (const neighbor of getNeighbors(bestId)) add(neighbor);
  }
  return visited;
}

---

[30] ICTD | lib#@lancedb/lancedb#whenMatchedUpdateAll
whenMatchedUpdateAll(options?: {
        where: string;
    }): MergeInsertBuilder;

---

[31] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy.retrieve
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

[32] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.ictd
ictd: { ... }

---

[33] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/strategy-names.ts#StrategyName
export type StrategyName = (typeof STRATEGY_NAMES)[number];

---

[34] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/state/project-registry.ts#markWatcherRunning
export function markWatcherRunning(
  selector: string,
  pid: number,
  command: string[],
): ProjectRecord {
  const now = new Date().toISOString();
  return updateWatcher(selector, {
    status: "running",
    pid,
    command,
    startedAt: now,
    updatedAt: now,
  });
}

---

[35] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/models/strategies/types.ts#RecoveryStrategy
export interface RecoveryStrategy {}

---

[36] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/clcr-strategy.ts#ClcrStrategy
export class ClcrStrategy extends AbstractAnchoredStrategy

---

[37] ICTD | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/rpr-strategy.ts#RprStrategy
export class RprStrategy extends AbstractAnchoredStrategy

---

[38] ICTD | lib#typescript#includes
includes(searchElement:T,fromIndex?:number):boolean;

### Fin del Contexto

modify the recovery chunks of the strategies based on hybrid to be only 20
```

## Retrieved Chunks

### 1. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/abstract-anchored-strategy.ts#AbstractAnchoredStrategy

- Source: `ICTD`
- Score: `0.0065`

```text
export abstract class AbstractAnchoredStrategy implements RecoveryStrategy
```

### 2. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-graph-manager/lacoco-sqlite-service.ts#LaCoCoDatabase

- Source: `ICTD`
- Score: `0.0062`

```text
export class LaCoCoDatabase
```

### 3. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridStrategy

- Source: `ICTD`
- Score: `0.0055`

```text
export class HybridStrategy extends AbstractAnchoredStrategy
```

### 4. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/ictd-strategy.ts#IctdStrategy

- Source: `ICTD`
- Score: `0.0051`

```text
export class IctdStrategy extends AbstractAnchoredStrategy
```

### 5. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.ts#LaCoCoLanceDb

- Source: `ICTD`
- Score: `0.0049`

```text
export class LaCoCoLanceDb
```

### 6. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#StrategyDeps

- Source: `ICTD`
- Score: `0.0037`

```text
export interface StrategyDeps {}
```

### 7. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/hybrid-anchor-service.ts#HybridAnchorService

- Source: `ICTD`
- Score: `0.0035`

```text
export class HybridAnchorService
```

### 8. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/hybrid-anchor-service.ts#HybridAnchor

- Source: `ICTD`
- Score: `0.0033`

```text
export interface HybridAnchor {}
```

### 9. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid

- Source: `ICTD`
- Score: `0.0033`

```text
hybrid: { ... }
```

### 10. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#getStrategyEntry

- Source: `ICTD`
- Score: `0.0032`

```text
export function getStrategyEntry(strategyName: string): StrategyEntry {
  if (!isStrategyName(strategyName)) {
    throw new Error(`Estrategia no soportada: ${strategyName}`);
  }
  return STRATEGY_REGISTRY[strategyName];
}
```

### 11. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid.create

- Source: `ICTD`
- Score: `0.0031`

```text
const create = ({ db, lanceDb }) =>
```

### 12. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/daemon.ts#DaemonManager.#handleFileChange

- Source: `ICTD`
- Score: `0.0031`

```text
async #handleFileChange(
    filePath: string,
    event: "change" | "add"
  ): Promise<void> {
    const label = `[Daemon] 🔥 Hot reload [${event}] ${path.relative(process.cwd(), filePath)}`;
    console.time(label);

    try {
      // ── Step 1: Obtener / refrescar el SourceFile en ts-morph ────────────
      const existing = this.project.getSourceFile(filePath);
      let sourceFile: SourceFile;

      if (event === "add" || !existing) {
        sourceFile = this.project.addSourceFileAtPath(filePath);
        console.log(`[Daemon]    ➕ Nuevo archivo incorporado al proyecto.`);
      } else {
        // Recarga el AST del archivo modificado desde el sistema de archivos
        existing.refreshFromFileSystemSync();
        sourceFile = existing;
      }

      // ── Step 2 (F7): Archivos que importan el archivo modificado ─────────
      // Cuando los tipos de un archivo cambian, los archivos que lo importan
      // pueden tener firmas y aristas desactualizadas en la DB.
      // getReferencingSourceFiles() usa el grafo de importaciones de ts-morph.
      const referencingFiles = sourceFile
        .getReferencingSourceFiles()
        .filter((f) => !f.getFilePath().includes("node_modules"));

      if (referencingFiles.length > 0 && this.verbose) {
        console.log(
          `[Daemon]    🔗 ${referencingFiles.length} archivo(s) dependiente(s) detectados para propagación.`
        );
      }

      // Cap: si hay demasiados dependientes (p.ej. un módulo barrel muy importado),
      // limitamos la propagación para no bloquear el event-loop.
      const MAX_PROPAGATION = 50;
      const filesToPropagate = referencingFiles.slice(0, MAX_PROPAGATION);
      if (referencingFiles.length > MAX_PROPAGATION) {
        console.warn(
          `[Daemon] ⚠  ${referencingFiles.length} dependientes detectados; ` +
            `solo se re-procesarán ${MAX_PROPAGATION}. ` +
            `El grafo puede estar parcialmente desactualizado hasta el próximo cold-start.`
        );
      }

      // ── Steps 3–5 (F2): Purge + reprocess en UNA transacción atómica ─────
      // Al ser atómica: si falla en mitad del re-proceso, el grafo vuelve
      // al estado anterior (rollback automático de SQLite).
      this.sqliteCallbacks.nodesWritten = 0;
      this.sqliteCallbacks.edgesWritten = 0;

      let allPurgedIds: string[] = [];

      this.db.transaction(() => {
        // 3. Purgar el archivo modificado y re-procesarlo con el AST fresco
        const purgedIds = this.#purgeFile(filePath);
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

      console.log(
        `[Daemon]    ↳ ${this.sqliteCallbacks.nodesWritten} nodos, ${this.sqliteCallbacks.edgesWritten} aristas actualizados` +
          (filesToPropagate.length > 0
            ? ` (+ ${filesToPropagate.length} archivo(s) propagados).`
            : ".")
      );

      // Hot-reload de vectores (LanceDB)
      if (this.indexVectors) {
        this.#enqueueVectorUpdates([
          filePath,
          ...filesToPropagate.map((dep) => dep.getFilePath()),
        ]);
      }
    } catch (err) {
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  }
```

### 13. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#strategyHelp

- Source: `ICTD`
- Score: `0.0031`

```text
export function strategyHelp(): string {
  return `Estrategia de recuperación (${STRATEGY_NAMES.join(", ")}); por defecto strategy.default`;
}
```

### 14. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/inspect.ts#inspectQuery

- Source: `ICTD`
- Score: `0.0031`

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

### 15. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridConfig

- Source: `ICTD`
- Score: `0.0030`

```text
export interface HybridConfig {}
```

### 16. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridStrategy::config

- Source: `ICTD`
- Score: `0.0030`

```text
private readonly config: HybridConfig;
```

### 17. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#StrategyEntry

- Source: `ICTD`
- Score: `0.0030`

```text
export interface StrategyEntry {}
```

### 18. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerInspect

- Source: `ICTD`
- Score: `0.0030`

```text
function registerInspect(program: Command): void {
  program
    .command("inspect <root-node>")
    .description("Visualiza el subgrafo alrededor de un nodo usando expansión BFS con budget.")
    .option("-b, --budget <num>", "Máximo de nodos a expandir", "75")
    .option("-f, --focus <dim>", "Prioridad dimensional: SYS, CPG, DTG, ALL", "ALL")
    .option("-o, --output <path>", "Archivo HTML de salida", "inspect.html")
    .option("--cdn", "Usar CDN para Cytoscape.js en vez de embeberlo", false)
    .action(async (rootNode: string, options: InspectCliOptions) => {
      const budget = parseBudget(options.budget);
      if (budget === null) return;
      const focus = ["SYS", "CPG", "DTG", "ALL"].includes(options.focus)
        ? options.focus as "SYS" | "CPG" | "DTG" | "ALL"
        : "ALL";
      await inspect({
        rootNode,
        db: resolveDbPath(process.cwd()),
        budget,
        focus,
        output: options.output,
        cdn: options.cdn,
      });
    });
}
```

### 19. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerInspectQuery

- Source: `ICTD`
- Score: `0.0029`

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

### 20. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.ictd.create

- Source: `ICTD`
- Score: `0.0029`

```text
const create = ({ db, lanceDb }) =>
```

### 21. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/filters/context-aggregator.ts#ContextAggregator.aggregate

- Source: `ICTD`
- Score: `0.0028`

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

### 22. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/inspect.ts#inspect

- Source: `ICTD`
- Score: `0.0028`

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

### 23. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#parseBudget

- Source: `ICTD`
- Score: `0.0028`

```text
function parseBudget(value: string): number | null {
  const budget = Number.parseInt(value, 10);
  if (Number.isNaN(budget) || budget < 1) {
    console.error("[CLI] ❌ --budget debe ser un número positivo.");
    process.exitCode = 1;
    return null;
  }
  return budget;
}
```

### 24. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy.#planTool

- Source: `ICTD`
- Score: `0.0027`

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

### 25. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerRetrieve

- Source: `ICTD`
- Score: `0.0026`

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

### 26. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-graph-manager/lacoco-sqlite-service.ts#LaCoCoDatabase::searchDao

- Source: `ICTD`
- Score: `0.0026`

```text
readonly searchDao: SearchDao;
```

### 27. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/state-commands.ts#registerConfigCommands

- Source: `ICTD`
- Score: `0.0026`

```text
function registerConfigCommands(program: Command): void {
  const command = program
    .command("config")
    .description("Consulta y modifica configuración de LaCoCo.");

  command
    .command("list")
    .description("Lista las claves de configuración resueltas y su origen.")
    .option("--json", "Imprime JSON válido", false)
    .action((options: JsonOption) => {
      runCliCommand(() => {
        const entries = listConfig();
        if (options.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }
        console.log(formatTable(["KEY", "VALUE", "SOURCE"], entries.map((entry) => [
          entry.key,
          String(entry.value),
          entry.source,
        ])));
      });
    });

  command
    .command("get <key>")
    .description("Muestra una clave de configuración resuelta.")
    .option("--json", "Imprime JSON válido", false)
    .action((key: string, options: JsonOption) => {
      runCliCommand(() => {
        const entry = resolveConfig(key);
        console.log(options.json ? JSON.stringify(entry, null, 2) : `${entry.value} (${entry.source})`);
      });
    });

  command
    .command("set <key> <value>")
    .description("Guarda una clave de configuración en el alcance seleccionado.")
    .option("--global", "Escribe en la configuración global del usuario", false)
    .option("--local", "Escribe en la configuración local del proyecto", false)
    .option("--json", "Imprime JSON válido", false)
    .action((key: string, value: string, options: ConfigScopeOptions) => {
      runCliCommand(() => {
        const scope = resolveWritableScope(options);
        setConfig(key, value, scope);
        const entry = resolveConfig(key);
        console.log(options.json
          ? JSON.stringify({ scope, entry }, null, 2)
          : `${key}=${entry.value} escrito en ${scope}`);
      });
    });

  command
    .command("unset <key>")
    .description("Elimina una clave de configuración del alcance seleccionado.")
    .option("--global", "Elimina desde la configuración global del usuario", false)
    .option("--local", "Elimina desde la configuración local del proyecto", false)
    .option("--json", "Imprime JSON válido", false)
    .action((key: string, options: ConfigScopeOptions) => {
      runCliCommand(() => {
        const scope = resolveWritableScope(options);
        unsetConfig(key, scope);
        console.log(options.json
          ? JSON.stringify({ key, scope, unset: true }, null, 2)
          : `${key} eliminado de ${scope}`);
      });
    });

  command
    .command("path")
    .description("Muestra la ruta de archivo para configuración global o local.")
    .option("--global", "Muestra la ruta global", false)
    .option("--local", "Muestra la ruta local", false)
    .option("--json", "Imprime JSON válido", false)
    .action((options: ConfigScopeOptions) => {
      runCliCommand(() => {
        const scope = resolveWritableScope(options);
        const filePath = getConfigPath(scope);
        console.log(options.json
          ? JSON.stringify({ scope, path: filePath }, null, 2)
          : filePath);
      });
    });

  command
    .command("keys")
    .description("Lista las claves de configuración válidas.")
    .action(() => runCliCommand(() => console.log(configKeys().join("\n"))));
}
```

### 28. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/strategy-names.ts#isStrategyName

- Source: `ICTD`
- Score: `0.0025`

```text
export function isStrategyName(value: string): value is StrategyName {
  return (STRATEGY_NAMES as readonly string[]).includes(value);
}
```

### 29. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/helpers/graph-traversal.ts#prioritizedBreadthFirstTraversal

- Source: `ICTD`
- Score: `0.0025`

```text
export function prioritizedBreadthFirstTraversal(
  roots: readonly string[],
  getNeighbors: (nodeId: string) => string[],
  options: PrioritizedBfsOptions,
): Set<string> {
  const visited = new Set(roots);
  const frontier = new Map<string, number>();
  const add = (nodeId: string) => {
    if (!visited.has(nodeId)) frontier.set(nodeId, (frontier.get(nodeId) ?? 0) + 1);
  };

  for (const root of roots) for (const neighbor of getNeighbors(root)) add(neighbor);

  while (visited.size < options.budget && frontier.size > 0) {
    let bestId = "";
    let bestPriority = -Infinity;
    for (const [nodeId, edgeCount] of frontier) {
      const priority = options.priority(nodeId, edgeCount);
      if (priority > bestPriority) {
        bestPriority = priority;
        bestId = nodeId;
      }
    }
    frontier.delete(bestId);
    visited.add(bestId);
    for (const neighbor of getNeighbors(bestId)) add(neighbor);
  }
  return visited;
}
```

### 30. lib#@lancedb/lancedb#whenMatchedUpdateAll

- Source: `ICTD`
- Score: `0.0024`

```text
whenMatchedUpdateAll(options?: {
        where: string;
    }): MergeInsertBuilder;
```

### 31. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy.retrieve

- Source: `ICTD`
- Score: `0.0024`

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

### 32. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.ictd

- Source: `ICTD`
- Score: `0.0023`

```text
ictd: { ... }
```

### 33. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/strategy-names.ts#StrategyName

- Source: `ICTD`
- Score: `0.0023`

```text
export type StrategyName = (typeof STRATEGY_NAMES)[number];
```

### 34. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/state/project-registry.ts#markWatcherRunning

- Source: `ICTD`
- Score: `0.0023`

```text
export function markWatcherRunning(
  selector: string,
  pid: number,
  command: string[],
): ProjectRecord {
  const now = new Date().toISOString();
  return updateWatcher(selector, {
    status: "running",
    pid,
    command,
    startedAt: now,
    updatedAt: now,
  });
}
```

### 35. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/models/strategies/types.ts#RecoveryStrategy

- Source: `ICTD`
- Score: `0.0018`

```text
export interface RecoveryStrategy {}
```

### 36. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/clcr-strategy.ts#ClcrStrategy

- Source: `ICTD`
- Score: `0.0012`

```text
export class ClcrStrategy extends AbstractAnchoredStrategy
```

### 37. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/rpr-strategy.ts#RprStrategy

- Source: `ICTD`
- Score: `0.0012`

```text
export class RprStrategy extends AbstractAnchoredStrategy
```

### 38. lib#typescript#includes

- Source: `ICTD`
- Score: `0.0010`

```text
includes(searchElement:T,fromIndex?:number):boolean;
```
