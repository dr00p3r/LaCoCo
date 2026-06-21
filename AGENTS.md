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

## Grafo

El grafo contiene tres dimensiones:

- `SYS`: ecosistema y contratos, por ejemplo `EXTENDS`, `IMPLEMENTS`, `IMPORTS_EXTERNAL`.
- `CPG`: estructura y ejecución, por ejemplo `INJECTS`, `CALLS`, `INSTANTIATES`.
- `DTG`: flujo y mutación de datos, por ejemplo `CONSUMES_DATA`, `PRODUCES`, `MUTATES_STATE`.

Los metadatos dimensionales consideran relaciones entrantes y salientes.

## Estructura

```text
src/
  cli/                 comandos y visualización de consultas
  extractor/           análisis AST con ts-morph y callbacks de persistencia
  indexer/             indexación independiente de grafo y vectores
  persistence/
    lacoco-graph-manager/    SQLite, FTS5, nodos, aristas y metadata
    lacoco-vectors-manager/  LanceDB y búsqueda ANN
  retriever/
    models/             contratos de estrategias y utilidades
    strategies/         implementaciones seleccionables
    utilities/
      embeddings/       generación local de embeddings
      filters/          agregación e inyección de contexto
      mini-agents/      AgentIntermediary1
      search/           servicios internos de búsqueda
  slms/                 cliente local de Ollama
tests/retrieval/        pruebas Vitest del pipeline de retrieval
```

## Persistencia e indexación

- SQLite mediante `better-sqlite3`: grafo, metadata y búsqueda FTS5.
- LanceDB: registros vectoriales con campo `embedding` de 384 dimensiones y metadata para filtros pre-ANN.
- `GraphIndexer` analiza el AST y escribe nodos/aristas en SQLite.
- `VectorsIndexer` analiza el AST de forma independiente, genera embeddings por lotes y los escribe en LanceDB.
- `VectorCallbacks.flush()` debe esperar todas las escrituras programadas; no se permiten lotes fire-and-forget.

El modelo de embeddings es `all-MiniLM-L6-v2` mediante `@xenova/transformers`. La primera ejecución puede requerir descargar el modelo.

## Retrieval

BM25 es una utilidad interna, no una `RecoveryStrategy` seleccionable. Toda reutilización debe pasar por `Bm25Service`, que centraliza FTS5, normalización y firmas.

Estrategias CLI válidas:

| Nombre | Mecanismo |
|---|---|
| `hybrid` | BM25 + ANN + Reciprocal Rank Fusion; usa filtro dimensional pre-ANN |
| `agentic` | Semillas BM25 + planificación local Ollama, máximo 3 iteraciones, con fallback determinístico |
| `ictd` | Difusión tensorial guiada por intent y dimensión |
| `clcr` | Recuperación por etapas entre capas |
| `rpr` | Enumeración y puntuación de caminos relacionales |

`hybrid` es la estrategia predeterminada y la única que requiere LanceDB durante retrieval. No reintroducir `bm25`, `bm25-dim` ni `agentic-standalone` como opciones CLI.

## Comandos

```bash
npm run typecheck
npm test
npm run build
npm run dev -- watch <tsconfig> --db <sqlite> --lancedb <directorio>
npm run dev -- index_graph <tsconfig>
npm run dev -- index_vectors --tsconfig <tsconfig>
npm run dev -- retrieve "<consulta>" --strategy hybrid
npm run dev -- inspect-query "<consulta>" --strategy hybrid
```

Consulta `npm run dev -- --help` para el contrato completo y opciones vigentes.

## Convenciones

- Node.js 20 o superior, TypeScript estricto, ESM y resolución `NodeNext`.
- Los imports relativos TypeScript usan extensión `.js`.
- Preferir DAOs y servicios existentes; SQL directo solo cuando una estrategia necesita una consulta especializada.
- Las implementaciones públicas de `RecoveryStrategy.retrieve` deben incluir JSDoc.
- Mantener el código y comentarios en ASCII salvo que el archivo ya requiera otro juego de caracteres.
- No realizar llamadas a modelos remotos durante análisis o retrieval. Ollama es local.
- Una estrategia nueva debe registrarse en `src/cli/index.ts`, `src/cli/inspect.ts`, esta tabla y sus pruebas.

## Verificación mínima

Antes de cerrar cambios de comportamiento:

1. Ejecutar `npm run typecheck`.
2. Ejecutar `npm test`.
3. Ejecutar `npm run build` si se modificó CLI, configuración o contratos públicos.
4. Buscar imports, opciones y documentación obsoletos con `rg`.

## Riesgos conocidos

- El intermediario depende obligatoriamente de Ollama; no existe fallback local cuando el modelo no está disponible.
- No hay todavía pruebas end-to-end del binario CLI contra SQLite y LanceDB reales.
- La reindexación vectorial necesita una política explícita de reemplazo para evitar registros duplicados.
- Faltan benchmarks comparables de precisión, latencia y consumo entre estrategias.
- `natural` permanece como dependencia aunque ya no define una estrategia BM25.
