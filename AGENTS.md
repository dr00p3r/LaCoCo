# AGENTS.md - LaCoCo

Este documento es la fuente de verdad operativa para agentes que modifiquen este repositorio. Debe actualizarse cuando cambien la arquitectura, las estrategias o los comandos.

## Objetivo

LaCoCo es un reforzador contextual local para proyectos TypeScript. Indexa estructura, relaciones y embeddings del proyecto; después recupera contexto relevante para enriquecer el prompt que consumirá un agente de codificación externo.

Pipeline de consulta:

```text
prompt original
  -> AgentIntermediary1
     (el SLM genera route, clean_query, embedding_input, intent,
      dimensions y confidence)
  -> RecoveryStrategy
  -> ContextAggregator
  -> PromptInjector
  -> LLM o agente de codificación
```

`AgentIntermediary1` es el único filtro dimensional. No existe ni debe añadirse un componente `DimensionalFilter` separado. Toda transformación semántica del prompt pertenece al SLM: no usar stopwords, extracción de keywords, reglas heurísticas ni fallbacks locales. Si Ollama falla o devuelve un contrato inválido, la consulta debe fallar explícitamente.

`SlmClassifier` solicita un esquema JSON estructurado a Ollama con temperatura
cero y semilla fija. Toda propuesta `LLM_DIRECT` se somete a una segunda
verificación del propio SLM antes de omitir retrieval; el código local valida el
contrato, pero no reemplaza ni corrige semánticamente la decisión.

## Grafo

El grafo contiene tres dimensiones:

- `SYS`: ecosistema y contratos, por ejemplo `EXTENDS`, `IMPLEMENTS`, `IMPORTS_EXTERNAL`.
- `CPG`: estructura y ejecución, por ejemplo `INJECTS`, `CALLS`, `INSTANTIATES`.
- `DTG`: flujo y mutación de datos, por ejemplo `CONSUMES_DATA`, `PRODUCES`, `MUTATES_STATE`.

Los metadatos dimensionales consideran relaciones entrantes y salientes.

## Estructura

```text
src/
  cli/                 composición de comandos, pipeline, watch e inspect
    commands/          registro de comandos por dominio y utilidades compartidas
    inspect/           BFS, carga DAO, tipos, caché y render HTML
  domain/              tipos canónicos del dominio (dimensiones SYS/CPG/DTG)
  embeddings/          generación local de embeddings
  extractor/           análisis AST con ts-morph y callbacks de persistencia
  indexer/             indexación independiente de grafo y vectores
  persistence/
    lacoco-graph-manager/    SQLite, FTS5, nodos, aristas y metadata
    lacoco-vectors-manager/  LanceDB y búsqueda ANN
  retriever/
    models/             contratos de estrategias y utilidades
    strategies/         implementaciones seleccionables y clase base AbstractAnchoredStrategy
      helpers/          pesos por intent y recorridos de grafo compartidos
    utilities/
      filters/          agregación e inyección de contexto
      mini-agents/      AgentIntermediary1
      search/           servicios internos de búsqueda
  slms/                 cliente local de Ollama e interfaz LlmClient
tests/retrieval/        pruebas Vitest del pipeline de retrieval
```

## Persistencia e indexación

- SQLite mediante `better-sqlite3`: grafo, metadata y búsqueda FTS5.
- LanceDB: registros vectoriales con campo `embedding` de 384 dimensiones y metadata para filtros pre-ANN.
- `GraphIndexer` analiza el AST y escribe nodos/aristas en SQLite.
- `VectorsIndexer` analiza el AST de forma independiente, genera embeddings por lotes y los escribe en LanceDB.
- El daemon usa una sola pasada de `CodeExtractor` con `CompositeCallbacks`: persiste el grafo y conserva los nodos que alimentan la indexación vectorial.
- `VectorCallbacks.flush()` debe esperar todas las escrituras programadas; no se permiten lotes fire-and-forget.
- `EmbeddingDao.replaceBatch()` usa `mergeInsert` por `node_id`; no reintroducir el ciclo no atómico delete + insert.
- `LaCoCoLanceDb.health()` expone conexión, estado del índice HNSW y el último error de construcción.
- LanceDB ejecuta `optimize()` tras 20 operaciones de escritura, 100000 filas
  modificadas, 20 fragmentos pequeños o 100000 filas sin indexar. Conserva
  versiones de los últimos 7 días y nunca activa `deleteUnverified`.
  `health().maintenance` expone contadores, necesidad de mantenimiento y el
  último resultado; `optimizeIfNeeded(true)` permite ejecución explícita.

El modelo de embeddings es `all-MiniLM-L6-v2` mediante `@xenova/transformers`. La primera ejecución puede requerir descargar el modelo.

## Retrieval

BM25 es una utilidad interna, no una `RecoveryStrategy` seleccionable. Toda reutilización debe pasar por `Bm25Service`, que centraliza FTS5, normalización y firmas.

Estrategias CLI válidas:

| Nombre | Mecanismo |
|---|---|
| `hybrid` | BM25 + ANN + Reciprocal Rank Fusion; deliberadamente ignora dimensiones |
| `agentic` | Semillas BM25 + planificación local Ollama estructurada, máximo 3 iteraciones, sin fallback |
| `ictd` | Anclas híbridas + difusión tensorial guiada por intent y dimensión |
| `clcr` | Anclas híbridas + recuperación por etapas entre capas |
| `rpr` | Anclas híbridas + enumeración y puntuación de caminos relacionales |

`hybrid` es la estrategia predeterminada. `hybrid`, `ictd`, `clcr` y `rpr` requieren LanceDB durante retrieval porque comparten el anclaje BM25 + ANN + RRF, centralizado en `AbstractAnchoredStrategy`. Cada subclase solo implementa `expand()` con su lógica de difusión específica. No reintroducir `bm25`, `bm25-dim` ni `agentic-standalone` como opciones CLI.

Los pesos por intent y los recorridos BFS compartidos por estrategias viven en
`src/retriever/strategies/helpers/`; no son estrategias ni utilidades globales
del retriever.

`AgenticStrategy` y cualquier consumidor de Ollama deben depender de la interfaz
`LlmClient` (`src/slms/llm-client.ts`), no de la clase concreta `OllamaService`.
`OllamaService` solo se instancia en puntos de composición (CLI, `inspect.ts`).
Todo `LlmClient` debe implementar `abort()` para cancelar solicitudes activas.
Agentic usa un esquema JSON discriminado y validación exacta por herramienta,
permite como máximo 3 iteraciones y 2 intentos por decisión, y aplica siempre
el límite final de chunks. No tiene fallback cuando Ollama falla.

CLCR propaga score por salto: `child = parent * decay`, con `primaryDecay=0.5`
y `cascadeDecay=0.7`; `lambda=0.25` solo controla el boost cross-layer. RPR
identifica cada evidencia mediante `chunkId=RPR:<path-hash>` y conserva el
camino estructurado, aunque varios caminos terminen en el mismo `nodeId`.

## Comandos

```bash
npm run typecheck
npm test
npm run build
npm run dev -- init
npm run dev -- status
npm run dev -- config list
npm run dev -- config get <clave>
npm run dev -- config set <clave> <valor> --local
npm run dev -- config set <clave> <valor> --global
npm run dev -- project list
npm run dev -- project inspect <proyecto>
npm run dev -- project remove <proyecto>
npm run dev -- context export [proyecto] "<consulta>" --output contexto.md --strategy hybrid
npm run dev -- watch start [proyecto]
npm run dev -- watch stop [proyecto]
npm run dev -- watch restart [proyecto]
npm run dev -- watch status [proyecto]
npm run dev -- watch list
npm run dev -- index_graph <ruta-tsconfig>
npm run dev -- index_vectors <ruta-tsconfig>
npm run dev -- retrieve [proyecto] "<consulta>" --strategy hybrid
npm run dev -- retrieve [proyecto] "<consulta>" --strategy hybrid --json
npm run dev -- inspect-query [proyecto] "<consulta>" --strategy hybrid
```

`retrieve` y `context export` aceptan `--chunks <entero>` y
`--max-tokens <entero>`. `inspect-query` acepta `--chunks`. El primer flag
controla `anchorLimit` para `hybrid` y `chunkLimit` para las demás estrategias;
el segundo controla el presupuesto de `ContextAggregator`.

Consulta `npm run dev -- --help` para el contrato completo y opciones vigentes.
Cuando `retrieve`, `context export` o `inspect-query` omiten `--strategy` u
`--ollama`, la CLI resuelve `strategy.default`, `agent.endpoint` y `agent.model` desde la
configuración persistente, respetando la precedencia env > local > global >
default. Los flags explícitos siempre tienen prioridad.
Cuando se omiten `--db` o `--lancedb`, la CLI usa rutas por proyecto bajo
`paths.data`: `tensor.sqlite` para SQLite y `lancedb` para LanceDB. Las rutas
explícitas se normalizan a absolutas; las rutas resueltas se guardan en el
registro de proyectos como `storage.dbPath` y `storage.lanceDbPath`.

`retrieve`, `context export` e `inspect-query` aceptan un argumento `[proyecto]`
opcional que resuelve el proyecto desde el registro (por nombre, id o ruta). Si
se omite, usan `process.cwd()`. Las rutas de almacenamiento (`db` y `lancedb`)
se resuelven siempre desde el proyecto registrado; no aceptan flags explícitos.

`retrieve --json` reserva stdout para un unico documento con
`schemaVersion: 1`. El resultado incluye clasificacion, chunks, parámetros
efectivos de estrategia, presupuesto del agregador, prompt
enriquecido y metadatos de almacenamiento; los errores usan `ok: false` y exit
code no cero. Logs y diagnosticos deben permanecer en stderr para no romper
hooks. `retrieve` no genera respuestas finales: su salida está destinada a un
agente externo.

Los watchers administrados por CLI registran PID, comando y rutas en el registro
de proyectos, usan locks atómicos por proyecto bajo el estado de LaCoCo y marcan
`stale` cuando el PID registrado no existe o, en Linux, cuando `/proc/<pid>/cmdline`
no coincide con el comando watcher esperado.
`DaemonManager.health()` incluye contadores por ámbito y el último error; los
consumidores que necesiten observabilidad inmediata pueden pasar `onError`.

## Convenciones

- Node.js 20 o superior, TypeScript estricto, ESM y resolución `NodeNext`.
- Los imports relativos TypeScript usan extensión `.js`.
- Preferir DAOs y servicios existentes; SQL directo solo cuando una estrategia necesita una consulta especializada. Las consultas de vecindad deben usar `EdgeDao.getNeighborhood()` e `EdgeDao.getIncidentRelations()`.
- Las implementaciones públicas de `RecoveryStrategy.retrieve` deben incluir JSDoc.
- Mantener el código y comentarios en ASCII salvo que el archivo ya requiera otro juego de caracteres.
- No realizar llamadas a modelos remotos durante análisis o retrieval. Ollama es local.
- Una estrategia nueva debe registrarse en `src/retriever/strategies/registry.ts`;
  los nombres válidos viven en `src/retriever/strategies/strategy-names.ts` y
  alimentan CLI, `inspect-query`, configuración, esta tabla y sus pruebas.

## Verificación mínima

Antes de cerrar cambios de comportamiento:

1. Ejecutar `npm run typecheck`.
2. Ejecutar `npm test`.
3. Ejecutar `npm run build` si se modificó CLI, configuración o contratos públicos.
4. Buscar imports, opciones y documentación obsoletos con `rg`.

La suite incluye una prueba E2E del binario CLI que crea un proyecto temporal,
ejecuta `init`, `index_graph` e `index_vectors`, y verifica SQLite + LanceDB
reales bajo almacenamiento por proyecto. Usa `LACOCO_TEST_EMBEDDINGS=1` para
evitar descargas de modelos durante tests. Si el runner bloquea `spawnSync`, la
prueba se omite explícitamente.

## Riesgos conocidos

- El intermediario depende obligatoriamente de Ollama; no existe fallback local cuando el modelo no está disponible.
- La prueba end-to-end del binario CLI se omite en runners que bloquean `spawnSync`.
- Faltan benchmarks comparables de precisión, latencia y consumo entre estrategias.
