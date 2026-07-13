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

`AgentIntermediary1` es el único filtro dimensional. No existe ni debe añadirse un componente `DimensionalFilter` separado. Toda transformación semántica del prompt pertenece al SLM: no usar stopwords, extracción de keywords, reglas heurísticas ni fallbacks locales. `QueryGrounder` puede tokenizar léxicamente el prompt completo, sin descartar stopwords ni inferir significado, únicamente para recuperar evidencias del Project Semantic Profile. Si Ollama falla o devuelve un contrato inválido, la consulta debe fallar explícitamente.

`SlmClassifier` solicita un esquema JSON estructurado a Ollama con temperatura
cero y semilla fija. Toda propuesta `LLM_DIRECT` se somete a una segunda
verificación del propio SLM antes de omitir retrieval; el código local valida el
contrato, pero no reemplaza ni corrige semánticamente la decisión.

## Grafo

El grafo contiene tres dimensiones:

- `SYS`: ecosistema y contratos, por ejemplo `EXTENDS`, `IMPLEMENTS`, `IMPORTS_EXTERNAL`.
- `CPG`: estructura y ejecución, por ejemplo `INJECTS`, `CALLS`, `INSTANTIATES`, `DECLARES`.
- `DTG`: flujo y mutación de datos, por ejemplo `CONSUMES_DATA`, `PRODUCES`, `MUTATES_STATE`, `REFERENCES`.

Los metadatos dimensionales consideran relaciones entrantes y salientes.
`DECLARES` conecta clases, enums y objetos exportados con sus miembros.
`REFERENCES` conserva dependencias estáticas de tipos y valores que no son
llamadas. Los aliases importados deben resolverse hasta su declaración original
y las llamadas a métodos deben apuntar al ID canónico `#Clase.metodo`.

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
  semantic-profile/    inventario, enriquecimiento SLM, persistencia y grounding
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

El Project Semantic Profile vive en tablas SQLite separadas del grafo. Sus
alias, dominios y descripciones nunca son nodos SYS/CPG/DTG. `profile rebuild`
extrae evidencias determinísticas, reutiliza términos sin cambios por hash,
enriquece lotes con `LlmClient` y promueve el build atómicamente. Reindexar el
grafo invalida el perfil. El watcher solo mantiene un perfil ya construido.

El modelo de embeddings es `all-MiniLM-L6-v2` mediante `@xenova/transformers`. La primera ejecución puede requerir descargar el modelo.

## Modelo de build del Project Semantic Profile

- **Modelo permanente**: `qwen3:4b-instruct` (4B instruct, cuantizado Q4_K_M, ~2.5 GB).
  Adoptado tras el A/B `2026-07-08-grounding-ab-svelte728-7b-vs-4b.md`:
  2.74× más rápido que `qwen2.5:7b-instruct` (31 min vs 85 min en svelte-728)
  con métricas de retrieval idénticas.
- **Concurrencia por defecto**: 4 (`profile.enrichConcurrency`, ver `src/cli/state/config-store.ts`).
  Alinear con `OLLAMA_NUM_PARALLEL` del server para no saturar los slots.
- **VRAM típica**: 5998 MB / 8188 MB con `num_ctx: 8192` (deja ~2.2 GB libres).
- **No usar** `qwen2.5-coder:1.5b` para el perfil: entra en bucle de repetición
  e ignora IDs (ver `build-grounding-profiles.ts:123-125`).
- **No usar** `qwen2.5:7b-instruct` para builds grandes (>1000 términos): el
  contexto de 4096 tokens causa prompt cache thrashing por batch
  (`memory_seq_rm [208, end)` en cada llamada) y el modelo no paraleliza en
  8 GB de VRAM con la KV cache del 7B.

## Modelo del intermediario (default `agent.model`)

- **Default**: `qwen3:4b-instruct`. El 4B es la línea base vigente del
  intermediario SLM (clasificador de query). Es el mismo modelo del build de
  perfil — valida con `temp: 0, seed: 42` y produce JSON estructurado
  consistente en prompts de retrieval (REPL, gist, URLs), a diferencia del
  1.5B que entraba en bucle de repetición.
- **Override**: `LACOCO_AGENT_MODEL` (env) o `pnpm run dev -- config set agent.model <name> --local`.
- **Para pruebas A/B**: setear `LACOCO_INTERMEDIARY_MODEL` por separado
  (p. ej. `qwen2.5:7b-instruct`) sin tocar `agent.model`. El intermediario del
  eval runner (`run-retrieval.ts:freezeSlmQuery`) honra `intermediary.model`
  con su propio `keep_alive` y `num_ctx`.

### Defaults del enriquecedor (Fase 0, `SEMANTIC_ENRICHMENT_PROMPT_VERSION: 2`)

| Parámetro | Valor | Razón |
|---|---|---|
| `BATCH_SIZE` | 3 | Prompts <1500 tokens, caben en `num_ctx: 8192` sin truncamiento |
| `MAX_ALIASES` | 4 | El 4B produce 1-5 aliases naturalmente; 4 cubre el 90%+. Fallback a 6 si la cobertura cae. |
| `MAX_DOMAINS` | 2 | El 4B produce 1-2 dominios típicamente |
| `MAX_DESCRIPTION_LENGTH` | 240 | El 4B produce descripciones de 130-180 chars; 240 deja holgura. `coerceDescription` aplica el cap duro en storage. |
| `format` | `ENRICHMENT_SCHEMA` | El schema refleja la salida natural del 4B (aliases como strings, `domain` key). `format: "json"` sin schema lo desvía a un formato compacto que requiere más parsing. |
| `num_predict` | 2048 | Output típico: 800-1500 tokens. 2048 cubre el peor caso. |
| `num_ctx` | 8192 | Con 4B (~2.5 GB), deja 2+ GB para KV cache 8K → elimina `memory_seq_rm` por batch. |

### Robustez ante variaciones del modelo

El 4B con `temp: 0, seed: 42` produce el schema correctamente la mayoría de las
veces, pero rechaza ocasionalmente con HTTP 500 (`peg-native format error`):
trailing commas, descripciones ligeramente sobre el cap, o alias que exceden
el cap. El enriquecedor maneja esto con:

- **Retry en `#enrichBatch`**: 3 intentos con backoff (200ms × attempt). El 4B
  suele recuperarse en retry 2-3; las causas son estocásticas entre batches
  (carga de slots, estado de cache), no deterministas per-call.
- **Degradación controlada**: tras 3 fallos, el batch entero cae a
  `minimalEnrichment` (sin aliases/dominios, con `canonical_term` como
  description). El build **no aborta**: el perfil sigue adelante, los términos
  faltantes quedan disponibles para grounding por su forma canónica.
- **Parser tolerante**: `parseAliases` acepta tanto `["str1", "str2"]` (4B)
  como `[{value, language, confidence}]` (formato verboso, por compat con
  otras SLMs). `parseDomains` acepta `domain` (4B) o `name` (verboso).
- **Match por índice posicional**: si el LLM omite el `id` (la 4B a veces
  lo hace), se usa la posición en el array como fallback. Solo aplica cuando
  el id está ausente; si el id está presente pero no matchea, se ignora
  (la SLM está mintiendo sobre qué término enriquece).

### Métricas de build (svelte-728, 1121 términos)

| Build | Wall | Speedup vs 7B | Aliases | A/B retrieval |
|---|---:|---:|---:|---|
| 7B (`qwen2.5:7b-instruct`, prompt v1) | 85 min | 1× | 5307 | baseline |
| 4B (`qwen3:4b-instruct`, prompt v1) | 31 min | 2.74× | 3558 | M3-M5 idéntico |
| 4B Fase 0 (prompt v2 + retry + schema 4B) | 17 min | **5×** | 2933 | M3-M5 idéntico |

El schema tightening (MAX_ALIASES=4 vs 8, MAX_DOMAINS=2 vs 3, drop term-level
confidence) **no degrada las métricas M3-M5 del A/B** — más aliases ≠ mejor
grounding. La reducción de 17% en aliases (3558→2933) refleja el cap más
estricto, no pérdida de calidad.

- **Aislamiento**: el modelo del build no afecta la query en tiempo de
  retrieval — el `QueryGrounder` es determinista (alias exact + FTS5). El A/B
  es válido con cualquier intermediario (incluido el 7B).
- **Invariante**: `promptVersion` y `model` se persisten en
  `semantic_profile_builds`. Bumpear `SEMANTIC_ENRICHMENT_PROMPT_VERSION`
  invalida el caché por cambio de contrato, no por cambio de modelo.

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
| `consensus` | Anclas híbridas + consenso estructural de vecinos señalados por varias anclas |
| `repograph` | Anclas híbridas + ego-graph plano como baseline estructural |
| `ppr` | Anclas híbridas + PageRank personalizado sobre subgrafo inducido |
| `connector` | Anclas híbridas + confluencia tipada entre anclas |

`hybrid` es la estrategia predeterminada. Todas las estrategias excepto
`agentic` requieren LanceDB durante retrieval porque comparten el anclaje BM25 +
ANN + RRF, centralizado en `AbstractAnchoredStrategy`. Cada subclase implementa
`expand()` con su lógica específica. No reintroducir `bm25`, `bm25-dim` ni
`agentic-standalone` como opciones CLI.

## Benchmarks

**Único benchmark production**: `eval/manifests/swe-polybench/` (svelte por ahora; el plan es extender a otros repos más adelante). Es la fuente de verdad para M1–M7. El gold se deriva de `AmazonScience/SWE-PolyBench_Verified` (CST `modified_nodes` → node-ids LaCoCo vía `swe-polybench-nodes.ts`); el multihop se deriva automáticamente con BFS-2 filtrado por CALLS+REFERENCES+DECLARES vía `multihop-translator.ts` cuando se corre `import-swe-polybench --enable-multihop --run-id <id>`.

M1 (pass_rate legacy): `test_exit_code === 0 && patch_applied && !timeout`. M1_regression_pass@1 (citable) NO es medible desde swe-polybench porque el loader no emite `regression:` blocks — el estado roto se materializa vía `base_commit` no vía `broken_patch` anotado a mano.

M6 (multi-hop): multihop gold se deriva de BFS-2 con `multihop_status: "auto"`. Tareas donde el traductor no encontró alcanzables quedan con `multihop_status: "auto"` y `multihop_nodes: []`; en `compute-retrieval-metrics` esto produce `MetricStatus: "auto_empty"` (la tarea se excluye de M6 pero no es un fallo de harness).

**LEGACY (NO usar para reports)**: `zod-{001,002}`, `inversify-{001,002}`, `rxjs-{001,002}` en `eval/manifests/tasks.yaml` están marcadas con `status: legacy`. Su gold dependía de `broken_patch` + `baseline_failing_tests` anotados a mano (frágil, costoso de mantener, y produjo 3/4 NO_PATCH en `2026-07-06-regression-pilot`). Los informes `2026-07-05-*`, `2026-07-06-regression-pilot`, `2026-07-07-grounding-ab-zod` son históricos. Las tareas legacy se conservan en tasks.yaml solo para reproducibilidad de esos informes y para los tests del harness (`metrics.test.ts`, `gold.test.ts`).

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
identifica cada evidencia mediante `chunkId=RPR:<path-hash>` y conserva el mejor
camino estructurado por `nodeId` terminal. Deduplica por `nodeId` antes de
aplicar `chunkLimit` y expone en `diagnostics.duplicateCount` cuantos caminos
alternativos fueron descartados.

## Directorio de manifests (eval)

Todos los scripts de `pnpm run eval:*` resuelven el directorio de manifests en
tres niveles de precedencia (`eval/scripts/lib/paths.ts:resolveManifestsDir`):

1. Flag `--manifests-dir <path>` (mayor precedencia — override por comando)
2. Env var `LACOCO_EVAL_MANIFESTS_DIR=<path>` (se setea una vez por sesión)
3. Default `eval/manifests` (canónico)

Para apuntar toda la pipeline (`prepare`, `index`, `retrieval`, `generation`,
`hallucination`, `metrics:retrieval`, `metrics:generation`,
`compare:strategies`) a un dir no-canónico como `eval/manifests/swe-polybench`,
setear la env var UNA vez en el shell:

```bash
export LACOCO_EVAL_MANIFESTS_DIR=eval/manifests/swe-polybench
```

Esto evita pasar `--manifests-dir` en cada uno de los ~8 comandos del run.
El flag sigue funcionando como override por comando si se necesita mezclar dirs.

## Comandos

```bash
pnpm run typecheck
pnpm test
pnpm run build
pnpm run dev -- init
pnpm run dev -- status
pnpm run dev -- config list
pnpm run dev -- config get <clave>
pnpm run dev -- config set <clave> <valor> --local
pnpm run dev -- config set <clave> <valor> --global
pnpm run dev -- project list
pnpm run dev -- project inspect <proyecto>
pnpm run dev -- project remove <proyecto>
pnpm run dev -- context export [proyecto] "<consulta>" --output contexto.md --strategy hybrid
pnpm run dev -- watch start [proyecto]
pnpm run dev -- watch stop [proyecto]
pnpm run dev -- watch restart [proyecto]
pnpm run dev -- watch status [proyecto]
pnpm run dev -- watch list
pnpm run dev -- index_graph <ruta-tsconfig>
pnpm run dev -- index_vectors <ruta-tsconfig>
pnpm run dev -- index_propositions <ruta-tsconfig>
pnpm run dev -- profile rebuild [proyecto] --json
pnpm run dev -- profile ground [proyecto] "<consulta>" --json
pnpm run dev -- profile status [proyecto] --verify --json
pnpm run dev -- retrieve [proyecto] "<consulta>" --strategy hybrid
pnpm run dev -- retrieve [proyecto] "<consulta>" --strategy hybrid --json
pnpm run dev -- inspect-query [proyecto] "<consulta>" --strategy hybrid
```

`retrieve` y `context export` aceptan `--chunks <entero>` y
`--max-tokens <entero>`. `inspect-query` acepta `--chunks`. El primer flag
controla `anchorLimit` para `hybrid` y `chunkLimit` para las demás estrategias;
el segundo controla el presupuesto de `ContextAggregator`.

Consulta `pnpm run dev -- --help` para el contrato completo y opciones vigentes.
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

El grounding es experimental y está desactivado por defecto. `retrieve`,
`context export` e `inspect-query` aceptan `--grounding` y `--no-grounding`; la
configuración persistente es `profile.groundingEnabled`. Si se solicita y el
perfil no está `ready`, la consulta falla explícitamente.

`retrieve --json` reserva stdout para un unico documento con
`schemaVersion: 2`. El resultado incluye clasificacion, grounding, chunks, parámetros
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

En benchmarks con `eval:retrieval -- --use-slm`, el intermediario se ejecuta
una sola vez por tarea y variante. Su contrato completo se persiste y se
reutiliza en todas las estrategias; `sanitizer_variant` debe identificar
`agent_intermediary`, no `deterministic`. Retrieval y generación usan raíces de
artefactos separadas. Antes de generar, el runner valida todos los
`context.json` requeridos y falla sin truncar `generation.jsonl` si falta alguno;
solo `no_context` puede usar el placeholder explícito sin contexto.
`GenerationRecord` schema v2 persiste el modelo efectivo en `model_id`; no se
debe reconstruir esa procedencia desde `command.log`. También persiste el costo
reportado por el proveedor en `cost_usd`. `eval:generation -- --resume` debe
preservar y omitir celdas ya registradas; los límites de tamaño/número de
archivos del patch se aplican antes de ejecutar pruebas.

## Verificación mínima

Antes de cerrar cambios de comportamiento:

1. Ejecutar `pnpm run typecheck`.
2. Ejecutar `pnpm test`.
3. Ejecutar `pnpm run build` si se modificó CLI, configuración o contratos públicos.
4. Buscar imports, opciones y documentación obsoletos con `rg`.

La suite incluye una prueba E2E del binario CLI que crea un proyecto temporal,
ejecuta `init`, `index_graph` e `index_vectors`, y verifica SQLite + LanceDB
reales bajo almacenamiento por proyecto. Usa `LACOCO_TEST_EMBEDDINGS=1` para
evitar descargas de modelos durante tests. Si el runner bloquea `spawnSync`, la
prueba se omite explícitamente.

## Riesgos conocidos

- El intermediario depende obligatoriamente de Ollama; no existe fallback local cuando el modelo no está disponible.
- El Project Semantic Profile requiere construcción explícita y permanece opt-in hasta revisar su benchmark A/B.
- La prueba end-to-end del binario CLI se omite en runners que bloquean `spawnSync`.
- Faltan benchmarks comparables de precisión, latencia y consumo entre estrategias.
