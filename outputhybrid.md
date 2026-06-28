---
lacoco_export_version: 1
context_id: "b79ed9fda285e438"
question: "modify the recovery chunks of the strategies based on hybrid to be only 20"
generated_at: "2026-06-27T23:22:22.386Z"
strategy: "hybrid"
route: "RAG"
intent: "refactor"
confidence: 0.96
dimensions: ["CPG"]
chunks: 20
---
# LaCoCo Context Export

## Question

modify the recovery chunks of the strategies based on hybrid to be only 20

## Retrieval Metadata

| Field | Value |
|---|---|
| Context ID | `b79ed9fda285e438` |
| Generated at | 2026-06-27T23:22:22.386Z |
| Strategy | `hybrid` |
| Route | `RAG` |
| Intent | `refactor` |
| Confidence | `0.96` |
| Dimensions | `CPG` |
| SQLite | `/home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/.lacoco/tensor.sqlite` |
| LanceDB | `/home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/.lacoco/lancedb` |

## Clean Query

```text
modify the recovery chunks of the strategies based on hybrid to be only 20
```

## Embedding Input

```text
Modificar los segmentos de recuperación de las estrategias basándose en un mixto para que sean solo 20
```

## Enriched Prompt

```text
### Contexto del Proyecto (recuperado automáticamente)
Los siguientes fragmentos de código fueron recuperados del repositorio actual
como contexto para tu consulta. Úsalos como referencia absoluta de firmas,
tipos y dependencias locales, y sobre todo, como ubicación de archivos. 
No inventes símbolos que no aparezcan aquí.

[1] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#strategyHelp
export function strategyHelp(): string {
  return `Estrategia de recuperación (${STRATEGY_NAMES.join(", ")}); por defecto strategy.default`;
}

---

[2] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/filters/context-aggregator.ts#ContextAggregator.aggregate
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

[3] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/ictd-strategy.ts#IctdStrategy
export class IctdStrategy extends AbstractAnchoredStrategy

---

[4] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/hybrid-anchor-service.ts#HybridAnchor
export interface HybridAnchor {}

---

[5] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#StrategyDeps
export interface StrategyDeps {}

---

[6] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/abstract-anchored-strategy.ts#AbstractAnchoredStrategy
export abstract class AbstractAnchoredStrategy implements RecoveryStrategy

---

[7] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerRetrieve
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

[8] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/bm25-service.ts#normalizeBm25Score
export function normalizeBm25Score(
  rawScore: number,
  rank: number,
  total: number
): number {
  if (total <= 0) return 0;

  const rankScore = (total - rank + 1) / total;
  if (!Number.isFinite(rawScore)) return rankScore;

  return Math.max(0, Math.min(1, rankScore));
}

---

[9] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid
hybrid: { ... }

---

[10] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerInspect
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

[11] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#parseBudget
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

[12] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/hybrid-anchor-service.ts#HybridAnchorService
export class HybridAnchorService

---

[13] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerInspectQuery
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

[14] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#getStrategyEntry
export function getStrategyEntry(strategyName: string): StrategyEntry {
  if (!isStrategyName(strategyName)) {
    throw new Error(`Estrategia no soportada: ${strategyName}`);
  }
  return STRATEGY_REGISTRY[strategyName];
}

---

[15] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridStrategy
export class HybridStrategy extends AbstractAnchoredStrategy

---

[16] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#StrategyEntry
export interface StrategyEntry {}

---

[17] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy.retrieve
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

[18] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/strategy-names.ts#StrategyName
export type StrategyName = (typeof STRATEGY_NAMES)[number];

---

[19] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/helpers/graph-traversal.ts#prioritizedBreadthFirstTraversal
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

[20] RRF | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/strategy-names.ts#isStrategyName
export function isStrategyName(value: string): value is StrategyName {
  return (STRATEGY_NAMES as readonly string[]).includes(value);
}

### Fin del Contexto

modify the recovery chunks of the strategies based on hybrid to be only 20
```

## Retrieved Chunks

### 1. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/pipeline.ts#strategyHelp

- Source: `RRF`
- Score: `0.0164`

```text
export function strategyHelp(): string {
  return `Estrategia de recuperación (${STRATEGY_NAMES.join(", ")}); por defecto strategy.default`;
}
```

### 2. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/filters/context-aggregator.ts#ContextAggregator.aggregate

- Source: `RRF`
- Score: `0.0161`

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

### 3. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/ictd-strategy.ts#IctdStrategy

- Source: `RRF`
- Score: `0.0159`

```text
export class IctdStrategy extends AbstractAnchoredStrategy
```

### 4. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/hybrid-anchor-service.ts#HybridAnchor

- Source: `RRF`
- Score: `0.0156`

```text
export interface HybridAnchor {}
```

### 5. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#StrategyDeps

- Source: `RRF`
- Score: `0.0154`

```text
export interface StrategyDeps {}
```

### 6. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/abstract-anchored-strategy.ts#AbstractAnchoredStrategy

- Source: `RRF`
- Score: `0.0152`

```text
export abstract class AbstractAnchoredStrategy implements RecoveryStrategy
```

### 7. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerRetrieve

- Source: `RRF`
- Score: `0.0149`

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

### 8. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/bm25-service.ts#normalizeBm25Score

- Source: `RRF`
- Score: `0.0147`

```text
export function normalizeBm25Score(
  rawScore: number,
  rank: number,
  total: number
): number {
  if (total <= 0) return 0;

  const rankScore = (total - rank + 1) / total;
  if (!Number.isFinite(rawScore)) return rankScore;

  return Math.max(0, Math.min(1, rankScore));
}
```

### 9. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#STRATEGY_REGISTRY.hybrid

- Source: `RRF`
- Score: `0.0145`

```text
hybrid: { ... }
```

### 10. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerInspect

- Source: `RRF`
- Score: `0.0143`

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

### 11. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#parseBudget

- Source: `RRF`
- Score: `0.0141`

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

### 12. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/utilities/search/hybrid-anchor-service.ts#HybridAnchorService

- Source: `RRF`
- Score: `0.0139`

```text
export class HybridAnchorService
```

### 13. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/cli/commands/retrieval-commands.ts#registerInspectQuery

- Source: `RRF`
- Score: `0.0137`

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

### 14. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#getStrategyEntry

- Source: `RRF`
- Score: `0.0135`

```text
export function getStrategyEntry(strategyName: string): StrategyEntry {
  if (!isStrategyName(strategyName)) {
    throw new Error(`Estrategia no soportada: ${strategyName}`);
  }
  return STRATEGY_REGISTRY[strategyName];
}
```

### 15. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/hybrid-strategy.ts#HybridStrategy

- Source: `RRF`
- Score: `0.0133`

```text
export class HybridStrategy extends AbstractAnchoredStrategy
```

### 16. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#StrategyEntry

- Source: `RRF`
- Score: `0.0132`

```text
export interface StrategyEntry {}
```

### 17. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/agentic-strategy.ts#AgenticStrategy.retrieve

- Source: `RRF`
- Score: `0.0130`

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

### 18. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/strategy-names.ts#StrategyName

- Source: `RRF`
- Score: `0.0128`

```text
export type StrategyName = (typeof STRATEGY_NAMES)[number];
```

### 19. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/helpers/graph-traversal.ts#prioritizedBreadthFirstTraversal

- Source: `RRF`
- Score: `0.0127`

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

### 20. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/strategy-names.ts#isStrategyName

- Source: `RRF`
- Score: `0.0125`

```text
export function isStrategyName(value: string): value is StrategyName {
  return (STRATEGY_NAMES as readonly string[]).includes(value);
}
```
