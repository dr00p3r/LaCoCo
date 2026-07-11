# AGENTS.md - LaCoCo

Este documento es la fuente de verdad operativa para agentes que modifiquen este repositorio. Debe actualizarse cuando cambien la arquitectura, las estrategias o los comandos.

## Objetivo

LaCoCo es un reforzador contextual local para proyectos TypeScript. Indexa estructura, relaciones y embeddings del proyecto; después recupera contexto relevante para enriquecer el prompt que consumirá un agente de codificación externo.

Pipeline de consulta:

```text
prompt original
  -> skill instalada en el agente
     (el agente genera clean_query, embedding_input, intent,
      dimensions y confidence)
  -> JSON estructurado por stdin
  -> RecoveryStrategy
  -> ContextAggregator
  -> contextBlock JSON
  -> agente de codificación usa el contexto como evidencia
```

LaCoCo no debe limpiar, reescribir ni clasificar semanticamente el prompt dentro
del core antes de retrieval. Esa responsabilidad pertenece al agente externo,
guiado por `.lacoco/skill.md`. La CLI valida el contrato estructurado recibido
por stdin y falla explicitamente si falta informacion obligatoria; no debe
inferir dimensiones, keywords ni rutas RAG mediante reglas locales.

`AgentIntermediary1`, `SlmClassifier`, `QueryGrounder` y `semantic-profile`
quedan como codigo legacy/eval mientras se decide su eliminacion definitiva. No
deben volver a conectarse al flujo activo de `retrieve`, `context export`,
`inspect-query`, watcher o comandos principales.

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
      mini-agents/      legacy AgentIntermediary1 para eval/histórico
      search/           servicios internos de búsqueda
  semantic-profile/    legacy Project Semantic Profile para eval/histórico
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

## Skill de retrieval

`lacoco skill update [proyecto]` genera `.lacoco/skill.md` desde el grafo
indexado. Ese archivo es el snapshot canonico de LaCoCo para el proyecto.

`lacoco skill install [proyecto] --agent <codex|claude|opencode|all>` instala un
paquete `SKILL.md` en el agente destino. `skill update --install <agents>`
genera el snapshot y sincroniza los agentes en un solo paso. La skill instalada
debe indicar que, ante tareas que dependan del codigo del repositorio, el agente
primero construye el JSON estructurado, llama a `lacoco retrieve` por stdin,
usa `contextBlock` como evidencia y recien despues responde o edita.

Targets actuales:

- `codex`: `${CODEX_HOME:-~/.codex}/skills/lacoco-<project>/SKILL.md`
- `claude`: `${CLAUDE_HOME:-~/.claude}/skills/lacoco-<project>/SKILL.md`
- `opencode`: `${XDG_CONFIG_HOME:-~/.config}/opencode/skills/lacoco-<project>/SKILL.md` y `opencode.jsonc.skills.paths`

El watcher actualiza grafo y vectores, pero no reescribe la skill. Si cambia una
parte arquitectonica importante, ejecutar manualmente `skill update --install
<agents>` despues de reindexar. No reintroducir actualizacion automatica de
skills dentro del daemon sin una decision explicita de producto.

## Modelo de agente local

`agent.model` y `agent.endpoint` solo aplican a consumidores que aun llaman a
Ollama, principalmente la estrategia `agentic` y scripts legacy/eval. El flujo
normal de `retrieve` no instancia un intermediario SLM ni requiere Ollama.

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

Todos los scripts de `npm run eval:*` resuelven el directorio de manifests en
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
pnpm run dev -- watch start [proyecto]
pnpm run dev -- watch stop [proyecto]
pnpm run dev -- watch restart [proyecto]
pnpm run dev -- watch status [proyecto]
pnpm run dev -- watch list
pnpm run dev -- index_graph <ruta-tsconfig-o-proyecto>
pnpm run dev -- index_vectors <ruta-tsconfig-o-proyecto>
pnpm run dev -- skill update [proyecto] --json
pnpm run dev -- skill update [proyecto] --install codex,claude,opencode --json
pnpm run dev -- skill install [proyecto] --agent all --json
printf '%s' '<json>' | pnpm run dev -- retrieve [proyecto] --strategy hybrid
printf '%s' '<json>' | pnpm run dev -- retrieve [proyecto] --strategy hybrid --json
printf '%s' '<json>' | pnpm run dev -- context export [proyecto] --output contexto.md --strategy hybrid
printf '%s' '<json>' | pnpm run dev -- inspect-query [proyecto] --strategy hybrid
```

`retrieve` y `context export` aceptan `--chunks <entero>` y
`--max-tokens <entero>`. `inspect-query` acepta `--chunks`. El primer flag
controla `anchorLimit` para `hybrid` y `chunkLimit` para las demás estrategias;
el segundo controla el presupuesto de `ContextAggregator`.

Consulta `npm run dev -- --help` para el contrato completo y opciones vigentes.
Cuando `retrieve`, `context export` o `inspect-query` omiten `--strategy`, la CLI
resuelve `strategy.default` desde la configuración persistente, respetando la
precedencia env > local > global > default. Los flags explícitos siempre tienen
prioridad. `agent.endpoint` y `agent.model` solo se usan cuando la estrategia o
un script legacy necesita Ollama.
Cuando se omiten `--db` o `--lancedb`, la CLI usa rutas por proyecto bajo
`paths.data`: `tensor.sqlite` para SQLite y `lancedb` para LanceDB. Las rutas
explícitas se normalizan a absolutas; las rutas resueltas se guardan en el
registro de proyectos como `storage.dbPath` y `storage.lanceDbPath`.

`retrieve`, `context export` e `inspect-query` aceptan un argumento `[proyecto]`
opcional que resuelve el proyecto desde el registro (por nombre, id o ruta). Si
se omite, usan `process.cwd()`. Las rutas de almacenamiento (`db` y `lancedb`)
se resuelven siempre desde el proyecto registrado; no aceptan flags explícitos.

Los tres comandos leen el contrato estructurado desde stdin:

```json
{
  "schemaVersion": 1,
  "originalPrompt": "Prompt original del usuario",
  "clean_query": "\"OrderService\" OR \"sales container\"",
  "embedding_input": "Modificar el contenedor que coordina ventas",
  "intent": "refactor",
  "dimensions": ["CPG", "DTG"],
  "confidence": 0.9,
  "strategy": "hybrid",
  "chunks": 20,
  "maxTokens": 4000
}
```

`retrieve --json` reserva stdout para un unico documento con
`schemaVersion: 3`. El resultado incluye clasificacion, chunks, parametros
efectivos de estrategia, presupuesto del agregador, `contextBlock` y metadatos
de almacenamiento; los errores usan `ok: false` y exit code no cero. Logs y
diagnosticos deben permanecer en stderr. `retrieve` no genera respuestas
finales ni prompts enriquecidos: su salida es contexto para un agente externo.

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

En benchmarks legacy con `eval:retrieval -- --use-slm`, el intermediario se
ejecuta una sola vez por tarea y variante. Su contrato completo se persiste y se
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

- El codigo legacy del intermediario y Project Semantic Profile sigue existiendo para reproducibilidad de evals historicos, pero no forma parte del flujo activo.
- La prueba end-to-end del binario CLI se omite en runners que bloquean `spawnSync`.
- Faltan benchmarks comparables de precisión, latencia y consumo entre estrategias.
