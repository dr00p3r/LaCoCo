# DEFERRED.md — Mejoras diferidas de LaCoCo

> Items identificados en la auditoría del 2026-06-26 que requieren refactors mayores,
> medición previa o cambios de arquitectura.

---

## Error handling

### D1. Colas de archivos/vectores tragan errores silenciosamente
- **Archivo:** `src/extractor/daemon.ts:436,452`
- **Problema:** `fileOperationChain` y `vectorOperationChain` usan `.catch()` que solo loguea. No hay contadores de fallos, reintentos ni propagación al estado del daemon.
- **Sugerido:** Rediseñar con emisor de eventos o callback `onError` que alimente `health()`.

### D2. `buildIndex()` falla silenciosamente
- **Archivo:** `src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.ts:78-83`
- **Problema:** Si HNSW falla, las búsquedas degradan a scan lineal sin alerta.
- **Sugerido:** Añadir métrica `indexBuilt: boolean` en `health()` de `LaCoCoLanceDb` o lanzar warning vía evento.

---

## Refactors de módulos grandes

### D3. `cli/inspect.ts` (828 líneas) — God module
- **Problema:** Mezcla BFS, SQL directo, generación HTML, caching de Cytoscape.
- **Sugerido:** Partir en `inspect/bfs.ts`, `inspect/data-loaders.ts`, `inspect/html-renderer.ts`, `inspect/cytoscape-cache.ts`.

### D4. `cli/index.ts` (1325 líneas) — God module
- **Problema:** Comandos, pipeline, watch, formatters en un solo archivo.
- **Sugerido:** Partir en `cli/commands/`, `cli/pipeline.ts`, `cli/formatters.ts`, `cli/watch.ts`.

---

## Violaciones de capas

### D5. `EmbeddingGenerator` en `retriever/utilities/`
- **Archivo:** `src/retriever/utilities/embeddings/embedding-generator.ts`
- **Problema:** Usado por `extractor/` e `indexer/` (capas inferiores dependen de capa superior).
- **Sugerido:** Mover a `src/embeddings/embedding-generator.ts`.

---

## Duplicación de lógica

### D6. `INTENT_WEIGHTS` duplicado
- **Archivos:** `src/retriever/strategies/ictd-strategy.ts:25-32`, `clcr-strategy.ts:37-44`
- **Problema:** Misma lógica de pesos por intención en dos archivos; divergencia garantizada.
- **Sugerido:** Extraer a `src/retriever/strategies/intent-weights.ts`.

### D7. BFS cuadruplicado
- **Archivos:** `rpr-strategy.ts`, `ictd-strategy.ts`, `clcr-strategy.ts`, `cli/inspect.ts`
- **Problema:** Cuatro implementaciones de BFS con variaciones sutiles.
- **Sugerido:** Crear `GraphTraversalService` en `src/retriever/utilities/graph-traversal.ts`.

---

## Contratos incompletos

### D8. `LlmClient` sin método `abort()`
- **Archivos:** `src/slms/llm-client.ts`, `src/slms/ollama-service.ts`
- **Problema:** Peticiones HTTP en vuelo no cancelables durante shutdown.
- **Sugerido:** Añadir `abort(): void` a `LlmClient`; implementar con `AbortController` compartido en `OllamaService`.

---

## Deuda en capa de persistencia

### D9. SQL directo en `inspect.ts` bypasea DAOs
- **Archivo:** `src/cli/inspect.ts:260-361` (expandBFS, findRootNodes, loadNodes, loadEdges)
- **Problema:** `rawDb.prepare()` en vez de usar `EdgeDao`/`NodeDao`.
- **Sugerido:** Añadir `EdgeDao.getBfsNeighbors()` y `NodeDao.loadNodesByIds()`.

### D10. `clearGraph()` usa SQL raw
- **Archivo:** `src/persistence/lacoco-graph-manager/lacoco-sqlite-service.ts:56`
- **Problema:** `this.db.exec("DELETE FROM edges; DELETE FROM nodes;")` en el service.
- **Sugerido:** Delegar a `EdgeDao.clearAll()` + `NodeDao.clearAll()`.

---

## Cobertura de tests

### D11. `lancedb-service.test.ts` — solo 1 test
- **Archivo:** `tests/retrieval/lancedb-service.test.ts`
- **Problema:** Sin cobertura de connect failure, filtros dimensionales, clear+buildIndex.
- **Sugerido:** Mock más completo de LanceDB o tests de integración con LanceDB real en temp dir.

---

## Tipos y casts inseguros

### D12. `Record<string, unknown>` en retornos
- **Archivos:** `src/cli/inspect.ts:699,732`, `src/cli/state/config-store.ts:17`
- **Problema:** Tipos genéricos donde existen interfaces específicas.
- **Sugerido:** Definir interfaces `CytoscapeNodeElement`, `CytoscapeEdgeElement`, `ConfigTreeNode`.

### D13. `process.exit()` inconsistente
- **Archivo:** `src/cli/index.ts:806,851,873`
- **Problema:** Mezcla `process.exit()` (mata async mid-flight) con `process.exitCode`.
- **Sugerido:** Unificar a `process.exitCode` en todos los casos menos shutdown handlers.

### D14. Casts ciegos en DAOs
- **Archivos:** `node-dao.ts`, `edge-dao.ts`, `search-dao.ts`
- **Problema:** `.all()` retorna `unknown[]`; casts a `GraphNode[]`/`GraphEdge[]` sin validación.
- **Sugerido:** Añadir runtime validation (zod) o tipos generados del schema SQLite.

---

## Configuración

### D15. `agent.model` no configurable
- **Archivos:** `cli/index.ts:420,759`, `cli/inspect.ts:155`, `ollama-service.ts:11`
- **Problema:** `"qwen2.5-coder:1.5b"` hardcodeado en 4 sitios.
- **Sugerido:** Añadir clave `agent.model` en `config-store.ts` con env var `LACOCO_AGENT_MODEL`.

---

## Diferidos del plan original (docs/plan-mejoras.md)

### B2. `replaceBatch` atómico
- **Archivo:** `src/persistence/lacoco-vectors-manager/dao/embedding-dao.ts:10-16`
- **Problema:** Delete + insert no atómico; requiere investigar si LanceDB soporta `mergeInsert`.
- **Estado:** Documentado como riesgo en `AGENTS.md`.

### B3. Pasada AST única
- **Archivo:** `src/extractor/daemon.ts:179,212`
- **Problema:** `CodeExtractor` se ejecuta dos veces (SQLite y LanceDB). Requiere medición previa.
- **Estado:** Diferido hasta tener benchmarks de latencia.
