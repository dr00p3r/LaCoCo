# AGENTS.md — LaCoCo: Recuperador de Contexto de Grandes Bases de Código

> Este documento es la fuente de verdad para agentes de código que trabajen sobre
> este repositorio. Si modificas arquitectura, dependencias o convenciones,
> actualiza este archivo.

---

## Parte I — Arquitectura y Decisiones de Diseño

### 1. Visión del Proyecto

LaCoCo es un agente de refuerzo contextual local que opera sobre bases de código
Node.js/TypeScript. Construye un grafo multirrelacional del proyecto y, ante un
prompt del usuario, recupera el contexto semántico y estructural relevante para
inyectarlo en un LLM, eliminando alucinaciones sintácticas por falta de contexto.

Flujo de alto nivel:

```
[PROMPT USUARIO]
       │
       ▼
┌─────────────────────┐
│ Agente Intermediario 1│  ← Clasifica RAG vs directo; sanitiza
│  (Clasificador +      │     Emite: query, dimensiones, intent, confianza
│   Sanitizador)        │
└─────────────────────┘
       │
       ▼ (si RAG)
┌─────────────────────┐
│  DimensionalFilter  │  ← Heurísticas → Clasificador liviano → SLM fallback
│  (Filtro por capa)  │
└─────────────────────┘
       │
       ▼
┌─────────────────────┐
│ RecoveryStrategy    │  ← Strategy Pattern: 5 implementaciones
│ (Strategy Pattern)    │
└─────────────────────┘
       │
       ▼
┌─────────────────────┐
│  ContextAggregator  │  ← Deduplica, ordena, trunca
└─────────────────────┘
       │
       ▼
┌─────────────────────┐
│  PromptInjector     │  ← Inyecta en prompt template versionado
└─────────────────────┘
       │
       ▼
[LLM CON CONTEXTO ENRIQUECIDO]
```

### 2. Grafo Multirrelacional de 3 Capas

El extractor genera nodos y aristas en tres dimensiones semánticas:

```
┌─────────────────────────────────────────────────────────────────┐
│  SYS  (Ecosistema del Sistema)                                  │
│     EXTENDS  ·  IMPLEMENTS  ·  IMPORTS_EXTERNAL                 │
│  Ejemplo: class OrderService extends BaseService implements      │
│           ICommandHandler<T>                                     │
├─────────────────────────────────────────────────────────────────┤
│  CPG  (Control & Program Graph — Estructura)                    │
│     INJECTS  ·  CALLS  ·  INSTANTIATES                         │
│  Ejemplo: constructor(orderRepo: OrderRepo) → INJECTS → OrderRepo│
│           this.orderRepo.save()    → CALLS   → OrderRepo.save   │
│           new OrderEntity()        → INSTANTIATES → OrderEntity │
├─────────────────────────────────────────────────────────────────┤
│  DTG  (Data-flow Graph — Flujo de Datos)                       │
│     CONSUMES_DATA  ·  PRODUCES  ·  MUTATES_STATE               │
│  Ejemplo: process(dto: CreateOrderDto) → CONSUMES_DATA → Dto   │
│           return Result<Order>         → PRODUCES      → Order │
│           this.order.status = x        → MUTATES_STATE → Order  │
└─────────────────────────────────────────────────────────────────┘
```

Nodos: CLASS, METHOD, FUNCTION, ARROW_FUNCTION, VARIABLE, INTERFACE, TYPE,
ENUM, ENUM_MEMBER, PROPERTY, ACCESSOR, EXTERNAL_LIB.

### 3. Estructura de Directorios

```
src/
├── cli/
│   └── index.ts                 ← Punto de entrada: watch, index, retrieve
│
├── extractor/                   ← Módulo de análisis estático
│   ├── daemon.ts                ← Orquestador cold-start + watcher + embeddings
│   └── graph-extractor.ts       ← Núcleo AST (ts-morph → SQLite)
│
├── retriever/                   ← Módulo de recuperación contextual (RAG)
│   ├── models/
│   │   ├── strategies/types.ts  ← RecoveryStrategy interface + ContextChunk
│   │   └── utilities/types.ts   ← SanitizerOutput + IntentTag
│   ├── strategies/
│   │   ├── bm25-strategy.ts              ← 2.1 BM25 puro
│   │   ├── bm25-dim-strategy.ts          ← 2.2 BM25 + filtro dimensional
│   │   ├── agentic-strategy.ts           ← 2.3 SLM planificador + executor
│   │   ├── hybrid-strategy.ts            ← 2.4 BM25 + ANN + RRF (default)
│   │   └── agentic-standalone-strategy.ts ← 2.5 Agente sin filtro (baseline)
│   └── utilities/
│       ├── mini-agents/
│       │   └── agent-intermediary-1.ts   ← Clasificador + Sanitizador
│       ├── filters/
│       │   ├── dimensional-filter.ts     ← Pipeline 3 niveles (heurísticas → placeholder → SLM)
│       │   ├── context-aggregator.ts     ← Deduplica, ordena, trunca
│       │   └── prompt-injector.ts        ← Template versionado de inyección
│       └── embeddings/
│           ├── embedding-generator.ts    ← all-MiniLM-L6-v2 vía transformers.js
│           └── embedding-indexer.ts      ← Genera embeddings post-extracción
│
├── persistence/                 ← Capa de persistencia
│   ├── lacoco-graph-manager/    ← SQLite layer
│   │   ├── lacoco-sqlite-service.ts     ← Facade: LaCoCoDatabase
│   │   ├── model/types.ts               ← GraphNode, GraphEdge
│   │   ├── dao/
│   │   │   ├── node-dao.ts, edge-dao.ts, search-dao.ts,
│   │   │   ├── migration-dao.ts, connection-dao.ts
│   │   └── migrations/
│   │       ├── 001_add_fts5.sql         ← FTS5 + triggers
│   │       └── 002_add_metadata.sql     ← node_metadata para dimensiones
│   └── lacoco-vectors-manager/  ← LanceDB layer
│       ├── lacoco-lancedb-service.ts    ← Facade: LaCoCoLanceDb
│       ├── model/types.ts               ← NodeEmbeddingRecord
│       └── dao/
│           ├── connection-dao.ts, embedding-dao.ts, search-dao.ts
│
└── slms/                        ← Modelos de lenguaje locales
    ├── ollama-service.ts        ← Cliente HTTP para Ollama
    └── model/types.ts           ← Tipos request/response

tests/                           ← Tests Vitest (cobertura >= 70% en retriever)
└── retrieval/
    ├── agent-intermediary-1.test.ts
    ├── dimensional-filter.test.ts
    ├── bm25-strategy.test.ts
    ├── context-aggregator.test.ts
    └── prompt-injector.test.ts
```

### 4. Decisiones de Tecnología

#### 4.1 Almacenamiento Dual

| Rol | Tecnología | Clase facade |
|-----|-----------|-------------|
| Grafo estructural + BM25 | SQLite (better-sqlite3) + FTS5 | `LaCoCoDatabase` |
| Embeddings + ANN | LanceDB | `LaCoCoLanceDb` |

**Esquema LanceDB** (`NodeEmbeddingRecord`):

```typescript
interface NodeEmbeddingRecord {
  node_id: string;           // FK → SQLite.nodes.id
  embedding: Float32Array;   // all-MiniLM-L6-v2 (384 dims)
  dimension: "SYS" | "CPG" | "DTG";
  sub_type: string;          // "function" | "class" | "package" | ...
  file_path: string;         // filtrado por módulo
  package_name?: string;     // solo DTG: nombre del paquete npm
  package_version?: string;  // solo DTG: versión exacta
}
```

> **Por qué metadatos redundantes en LanceDB:** LanceDB permite filtros
> pre-ANN (antes del ranking vectorial), reduciendo el espacio de búsqueda.
> Sin ellos, cada consulta necesitaría JOIN posterior a SQLite, duplicando
> round-trips. El costo de almacenamiento es marginal frente a la ganancia en
> latencia.

#### 4.2 Embeddings

- **Modelo:** `all-MiniLM-L6-v2` (384 dimensiones, ~80MB)
- **Motor:** `@xenova/transformers` (transformers.js para Node.js)
- **Generador:** `EmbeddingGenerator` (`src/retriever/utilities/embeddings/embedding-generator.ts`)
- **Indexer:** `EmbeddingIndexer` (`src/retriever/utilities/embeddings/embedding-indexer.ts`)
  — orquesta la generación batch post-extracción, leyendo nodos de SQLite,
  generando embeddings, e insertando en LanceDB.

#### 4.3 Filtro Dimensional (DimensionalFilter)

Pipeline en 3 niveles para clasificar el prompt en SYS/CPG/DTG:

```
Input: clean_query + embedding_input
       │
       ▼
┌─────────────────────┐
│ 1. Heurísticas O(1)│  ← Keywords rápidas (ej. "hereda", "implementa" → SYS)
│   (reglas hardcoded) │     "inyecta", "llama", "instancia" → CPG
└─────────────────────┘     "dto", "retorna", "muta" → DTG
       │
       ▼ si ambiguo
┌─────────────────────┐
│ 2. Clasificador     │  ← PLACEHOLDER: multiplica confianza heurística × 0.85
│    Liviano          │     y reenvía las mismas dimensiones sin clasificar.
│  (PENDIENTE)        │     Debe implementarse con embeddings + regresión logística.
└─────────────────────┘
       │
       ▼ si confianza < 0.65
┌─────────────────────┐
│ 3. SLM Fallback     │  ← Ollama local: Qwen2.5-Coder:1.5B
│   (Ollama)          │     Prompt: "Clasifica esta consulta en SYS, CPG o DTG"
└─────────────────────┘
```

> **IMPORTANTE:** El nivel 2 (clasificador liviano) es un placeholder. La línea
> `const lightweightConfidence = heuristicResult.confidence * 0.85` no realiza
> clasificación real. Implementar embeddings + regresión logística es una
> mejora pendiente prioritaria.

#### 4.4 Modelo de Lenguaje para Agente Agéntico

- **Modelo:** Qwen2.5-Coder:1.5B vía Ollama (local, sin llamadas de red)
- **Cliente:** `OllamaService` (`src/slms/ollama-service.ts`) — HTTP
  wrapper para `/api/generate`, `/api/chat`, `/api/tags`.
- **Uso:** Strategy 2.3 (agentic) emite herramientas (tool-calling).
  Motor determinístico ejecuta sobre SQLite/LanceDB.
  Máximo 3 iteraciones. Si Ollama no está disponible, hace fallback a
  expansión determinística por vecindad.

#### 4.5 Fusión Híbrida (Strategy 2.4)

RRF (Reciprocal Rank Fusion) entre:
- Score BM25 de SQLite/FTS5
- Score de similitud coseno de LanceDB (ANN)

Fórmula RRF para cada documento *d*:
```
RRF_score(d) = Σ 1 / (k + rank_i(d))
```
donde *k* = 60 (constante estándar), *rank_i* = posición en el ranking del
método *i* (BM25 o ANN).

Además, aplica un boost multiplicativo de 1.5× a los chunks cuyo `nodeId`
contenga algún token de la query (coincidencia de símbolos).

### 5. Patrón Strategy: 5 Estrategias de Recuperación

```
┌─────────────────────────────────────────────────────────────┐
│                    RecoveryStrategy (interface)             │
├─────────────────────────────────────────────────────────────┤
│  + retrieve(query: SanitizerOutput): Promise<ContextChunk[]> │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────────┐    ┌─────────────────────┐
│ BM25Strategy  │    │ BM25DimFilter     │    │ AgenticStrategy     │
│ (2.1)         │    │ Strategy (2.2)    │    │ (2.3)               │
│               │    │                   │    │                     │
│ BM25 puro     │    │ BM25 dirigido por │    │ SLM planificador +  │
│ sin filtros   │    │ dimensión detectada│   │ executor determin.  │
│               │    │ + intersección    │    │ + fallback sin SLM  │
└───────────────┘    └───────────────────┘    │ max 3 iteraciones   │
                              │               └─────────────────────┘
                              ▼                        │
                    ┌───────────────────┐              ▼
                    │ HybridStrategy    │    ┌─────────────────────┐
                    │ (2.4)             │    │ AgenticStandalone   │
                    │                   │    │ Strategy (2.5)      │
                    │ BM25 + Embeddings │    │                     │
                    │ + RRF (k=60)      │    │ Expansión por       │
                    │ + symbol boost    │    │ vecindad pura       │
                    │ (default)         │    │ sin SLM ni filtro   │
                    └───────────────────┘    │ (baseline)          │
                                             └─────────────────────┘
```

| # | Clase | Archivo | Líneas | Filtro dim? | BM25? | ANN? | SLM? | source |
|---|-------|---------|--------|-------------|-------|------|------|--------|
| 2.1 | `BM25Strategy` | `bm25-strategy.ts` | 33 | No | FTS5 (50) | No | No | `"BM25"` |
| 2.2 | `BM25DimFilterStrategy` | `bm25-dim-strategy.ts` | 59 | Sí — intersecta candidatos por dimensión con resultados BM25 | FTS5 (100) | No | No | `"BM25+DimFilter"` |
| 2.3 | `AgenticStrategy` | `agentic-strategy.ts` | 221 | Sí — como hint inicial | FTS5 (20 seeds) | No | Sí — Ollama Qwen2.5-Coder:1.5B, fallback a vecindad si no disponible | `"AGENTIC"` |
| 2.4 | `HybridStrategy` | `hybrid-strategy.ts` | 114 | Sí — filtro pre-ANN en LanceDB | FTS5 (50) | LanceDB ANN (50) + RRF k=60 + boost 1.5× | No (pendiente re-ranker) | `"RRF"` |
| 2.5 | `AgenticStandaloneStrategy` | `agentic-standalone-strategy.ts` | 85 | No — explícitamente omitido | FTS5 (20 seeds) | No | No — solo expansión por vecindad determinística | `"AGENTIC-STANDALONE"` |

### 6. Interfaz SanitizerOutput

```typescript
interface SanitizerOutput {
  route: "RAG" | "LLM_DIRECT";
  clean_query: string;          // normalizado para BM25/FTS5 (tokens OR-joined)
  embedding_input: string;        // semántico para LanceDB (sin OR)
  dimensions: ("SYS" | "CPG" | "DTG")[];  // puede ser múltiple
  intent: IntentTag;
  confidence: number;             // 0.0–1.0, umbral recomendado: 0.65
}

type IntentTag =
  | "understand"    // "¿qué hace esta función?"
  | "refactor"      // "refactoriza X para que..."
  | "create"        // "crea un endpoint que..."
  | "debug"         // "por qué falla X"
  | "integrate"     // "usa la librería X para..."
  | "unknown";      // fallback
```

> **RAG vs LLM_DIRECT:** Solo se enruta a RAG si el prompt implica recuperar
> algo del repositorio de código (referencias a símbolos, módulos, clases,
> funciones, o tareas de refactor/creación/debug sobre el codebase actual).
> Prompts genéricos o sin relación con el proyecto van directo al LLM.

### 7. Interfaz RecoveryStrategy y ContextChunk

```typescript
export interface RecoveryStrategy {
  retrieve(query: SanitizerOutput): Promise<ContextChunk[]>;
}

export interface ContextChunk {
  nodeId: string;
  score: number;
  text: string;       // firma o representación textual del nodo
  source: string;     // etiqueta de la estrategia que lo generó
}
```

> Definidos en `src/retriever/models/strategies/types.ts`.

### 8. Restricciones Técnicas Obligatorias

#### Runtime y Módulos
- **ESM-first:** todos los módulos usan `import/export` con extensiones `.js`
  explícitas en los imports relativos (requerido por `moduleResolution: "NodeNext"`).
- **TypeScript >= 5.0** configurado con `module: "NodeNext"`, `target: "ES2022"`,
  `strict: true`.
- **Node.js >= 20 LTS** requerido.

#### Base de Datos
- **No usar ORMs sobre SQLite** (Prisma, Drizzle, TypeORM están prohibidos).
  Todas las queries se escriben con `better-sqlite3` directo vía DAOs.
- Las migraciones de esquema se versionan en
  `src/persistence/lacoco-graph-manager/migrations/` como archivos `.sql`
  numerados secuencialmente.

#### Procesamiento
- El analizador estático opera exclusivamente sobre JS/TS.
  Cualquier otro lenguaje encontrado en el repo debe ignorarse silenciosamente.
- El sistema no realiza llamadas de red durante el análisis o la recuperación.
  Ollama y LanceDB deben estar disponibles localmente.

#### Calidad
- Cobertura mínima de tests: **70% en módulos de recuperación (Retriever)**.
- Toda función pública del Retriever debe tener JSDoc con `@param` y `@returns`.

---

## Parte II — Guía de Implementación

### Estado actual del proyecto

El proyecto se encuentra en **fase de implementación activa**. Los siguientes
componentes ya están codificados y pasan tests:

| Componente | Estado | Archivo(s) |
|------------|--------|------------|
| Extractor (AST → SQLite) | ✅ Completo | `src/extractor/graph-extractor.ts`, `daemon.ts` |
| LaCoCoDatabase (grafo + BM25 + metadata) | ✅ Completo | `src/persistence/lacoco-graph-manager/lacoco-sqlite-service.ts` |
| LaCoCoLanceDb (ANN + filtros) | ✅ Completo | `src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.ts` |
| EmbeddingGenerator | ✅ Completo | `src/retriever/utilities/embeddings/embedding-generator.ts` |
| EmbeddingIndexer | ✅ Completo | `src/retriever/utilities/embeddings/embedding-indexer.ts` |
| OllamaService | ✅ Completo | `src/slms/ollama-service.ts` |
| AgentIntermediary1 | ✅ Completo | `src/retriever/utilities/mini-agents/agent-intermediary-1.ts` |
| DimensionalFilter (3 niveles) | ⚠️ Nivel 2 placeholder | `src/retriever/utilities/filters/dimensional-filter.ts` |
| 5 Strategies de recuperación | ✅ Completo | `src/retriever/strategies/*.ts` |
| ContextAggregator | ✅ Completo | `src/retriever/utilities/filters/context-aggregator.ts` |
| PromptInjector | ✅ Completo | `src/retriever/utilities/filters/prompt-injector.ts` |
| CLI (watch, index, retrieve) | ✅ Completo | `src/cli/index.ts` |
| Tests (5 suites, ~31 tests) | ✅ Pasando | `tests/retrieval/*.test.ts` |

> **⚠️ Bug conocido en CLI:** `src/cli/index.ts:238` tiene un `0` solitario en
> una línea propia (resto de una edición). No impide compilación pero debe
> eliminarse.

### Paso 0: Dependencias

Instalar las dependencias:

```bash
npm install
```

Dependencias ya configuradas en `package.json`:

| Dependencia | Versión | Uso |
|-------------|---------|-----|
| `better-sqlite3` | ^12.8.0 | SQLite nativo + FTS5 |
| `@lancedb/lancedb` | ^0.27.2 | Base vectorial embebida |
| `@xenova/transformers` | ^2.17.2 | Embeddings locales (all-MiniLM-L6-v2) |
| `ts-morph` | ^27.0.2 | Análisis AST TypeScript |
| `commander` | ^14.0.3 | CLI framework |
| `chokidar` | ^5.0.0 | File watcher (daemon) |
| `natural` | ^8.1.1 | NLP (declarado pero **no usado** actualmente) |

DevDependencies: `vitest` ^4.1.6, `tsx` ^4.21.0, `typescript` ^6.0.2,
`@types/better-sqlite3`, `@types/natural`, `@types/node`.

> **Nota:** El `package.json` tiene `"name": "tensor-extractor"` y el bin se
> registra como `lacoco`. No hay inconsistencia funcional, pero es un detalle
> de naming a unificar eventualmente.

### Paso 1: Estructura de directorios (ya implementada)

```
src/
├── cli/                    ← Punto de entrada CLI
├── extractor/              ← Análisis estático (AST → SQLite)
├── retriever/              ← Pipeline RAG completo
│   ├── models/             ← Interfaces y tipos
│   │   ├── strategies/     ← RecoveryStrategy + ContextChunk
│   │   └── utilities/      ← SanitizerOutput + IntentTag
│   ├── strategies/         ← 5 implementaciones concretas
│   └── utilities/
│       ├── mini-agents/    ← AgentIntermediary1
│       ├── filters/        ← DimensionalFilter, ContextAggregator, PromptInjector
│       └── embeddings/     ← EmbeddingGenerator, EmbeddingIndexer
├── persistence/
│   ├── lacoco-graph-manager/    ← SQLite (LaCoCoDatabase + DAOs)
│   └── lacoco-vectors-manager/  ← LanceDB (LaCoCoLanceDb + DAOs)
└── slms/                   ← OllamaService (cliente HTTP)
```

### Paso 2: Migraciones SQL (ya implementadas)

- **`001_add_fts5.sql`** en `src/persistence/lacoco-graph-manager/migrations/`
  — Tabla virtual FTS5 `nodes_fts` sobre `name` y `signature`, con triggers
  de sincronización automática.
- **`002_add_metadata.sql`** en la misma carpeta — Tabla `node_metadata` para
  filtrado dimensional rápido por `dimension` (SYS/CPG/DTG).

### Paso 3: Infraestructura de datos (ya implementada)

| Archivo | Clase | Responsabilidad |
|---------|-------|----------------|
| `src/persistence/lacoco-graph-manager/lacoco-sqlite-service.ts` | `LaCoCoDatabase` | SQLite con WAL, FTS5 BM25, metadata dimensional, prepared statements. Sin ORM. |
| `src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.ts` | `LaCoCoLanceDb` | Conexión LanceDB, tabla `node_embeddings`, índice ANN HNSW, búsqueda con filtros pre-ANN. |
| `src/slms/ollama-service.ts` | `OllamaService` | Cliente HTTP para Ollama (`/api/generate`, `/api/chat`, `/api/tags`). |
| `src/retriever/utilities/embeddings/embedding-generator.ts` | `EmbeddingGenerator` | Carga lazy de `all-MiniLM-L6-v2`. Generación individual y batch. |
| `src/retriever/utilities/embeddings/embedding-indexer.ts` | `EmbeddingIndexer` | Orquesta: lee nodos SQLite → genera embeddings → infiere metadatos → inserta en LanceDB. |

### Paso 4: Pipeline RAG — Componentes Core (ya implementados)

| Orden | Archivo | Descripción |
|-------|---------|-------------|
| 4.1 | `src/retriever/utilities/mini-agents/agent-intermediary-1.ts` | `AgentIntermediary1.sanitize()` — Clasifica RAG vs directo. Sanitiza query. Detecta intent por heurísticas. |
| 4.2 | `src/retriever/utilities/filters/dimensional-filter.ts` | `DimensionalFilter.filter()` — Pipeline 3 niveles: Heurísticas O(1) → Clasificador liviano (placeholder) → SLM Ollama fallback. |
| 4.3 | `src/retriever/models/strategies/types.ts` | `RecoveryStrategy` interface + `ContextChunk` type. |
| 4.4 | `src/retriever/strategies/bm25-strategy.ts` | `BM25Strategy` — BM25 puro sobre FTS5. |
| 4.5 | `src/retriever/strategies/bm25-dim-strategy.ts` | `BM25DimFilterStrategy` — BM25 + DimensionalFilter + JOIN a metadata. |
| 4.6 | `src/retriever/strategies/agentic-strategy.ts` | `AgenticStrategy` — SLM planificador (Ollama) emite JSON tools. Executor determinístico sobre SQLite. Max 3 iteraciones. |
| 4.7 | `src/retriever/strategies/hybrid-strategy.ts` | `HybridStrategy` — BM25 + ANN (LanceDB) + RRF (k=60) + DimensionalFilter + symbol boost (1.5×). |
| 4.8 | `src/retriever/strategies/agentic-standalone-strategy.ts` | `AgenticStandaloneStrategy` — Expansión por vecindad sin filtro dimensional (baseline). No usa SLM. |
| 4.9 | `src/retriever/utilities/filters/context-aggregator.ts` | `ContextAggregator.aggregate()` — Deduplica por nodeId, ordena por score, trunca por tokens (default 4000). |
| 4.10 | `src/retriever/utilities/filters/prompt-injector.ts` | `PromptInjector.inject()` — Template versionado. Inyecta chunks bajo `### Contexto del Proyecto`. |

### Paso 5: Integración CLI y Daemon (ya implementada)

**Comandos disponibles:**

```bash
# Indexar proyecto (cold-start + embeddings)
lacoco index <tsconfig> [--db <path>] [--verbose]

# Modo daemon (cold-start + watcher + embeddings en vivo)
lacoco watch <tsconfig> [--db <path>] [--verbose]

# Pipeline RAG completo (recupera + inyecta + llama LLM)
lacoco retrieve "<query>" \
  [--db <path>] \
  [--strategy bm25|bm25-dim|hybrid|agentic|agentic-standalone] \
  [--ollama <url>] \
  [--no-llm]
```

**Ejemplos de uso:**

```bash
# Indexar
npx tsx src/cli/index.ts index ./tsconfig.json --verbose

# Recuperar con estrategia híbrida (default)
npx tsx src/cli/index.ts retrieve "refactoriza OrderService para async/await"

# Solo chunks, sin LLM
npx tsx src/cli/index.ts retrieve "qué hace UserRepository" --no-llm

# Estrategia agentica con Ollama en otra máquina
npx tsx src/cli/index.ts retrieve "crea endpoint POST /orders" \
  --strategy agentic --ollama http://192.168.1.50:11434
```

**Daemon (`watch`):**
- Cold-start sincrónico del grafo SQLite.
- Post-cold-start async: genera embeddings para todos los nodos en LanceDB.
- Watcher incremental (chokidar): re-procesa archivos modificados + re-indexa embeddings.

### Paso 6: Tests (ya implementados)

Framework: **Vitest** (ESM nativo).

| Test | Archivo | Cobertura |
|------|---------|-----------|
| AgentIntermediary1 | `agent-intermediary-1.test.ts` | Clasificación RAG vs directo, detección de intent |
| DimensionalFilter | `dimensional-filter.test.ts` | Clasificación SYS/CPG/DTG por heurísticas (nivel 1) |
| BM25Strategy | `bm25-strategy.test.ts` | Recuperación BM25 sobre FTS5 con DB en memoria |
| ContextAggregator | `context-aggregator.test.ts` | Deduplicación, ordenamiento, truncado por tokens |
| PromptInjector | `prompt-injector.test.ts` | Inyección de chunks, template versionado |

Ejecutar: `npm test` o `npx vitest run`

**Tests pendientes (no implementados):**
- `HybridStrategy`, `AgenticStrategy`, `BM25DimFilterStrategy`, `AgenticStandaloneStrategy`
- Componentes de embeddings (`EmbeddingGenerator`, `EmbeddingIndexer`)
- Integración end-to-end del pipeline completo
- Benchmarks (mencionados en Paso 8)

### Paso 7: Prerequisitos de ejecución

1. **Node.js >= 20 LTS**
2. **Ollama instalado y corriendo** (`http://localhost:11434`)
3. **Modelo descargado:** `ollama pull qwen2.5-coder:1.5b`
4. **Primera ejecución de `index`:** transformers.js descarga `all-MiniLM-L6-v2`
   (~80MB) automáticamente en el primer uso.

### Paso 8: Benchmarking (fase de validación futura)

Métricas a implementar para comparación de strategies:

| Métrica | Fórmula / Descripción |
|---------|----------------------|
| **TAD** (Tasa de Alucinación de Dependencias) | (# dependencias sugeridas por LLM que no existen en el grafo) / (total dependencias sugeridas) |
| **TCE** (Tasa de Compilación Exitosa) | (# prompts que generan código compilable con el contexto inyectado) / (total prompts) |
| **Recall@K** | (# nodos relevantes en top K) / (total nodos relevantes conocidos) |
| **Latency P95** | Percentil 95 del tiempo de recuperación (ms) |
| **Context Precision** | (# chunks relevantes inyectados) / (total chunks inyectados) |

> Implementar en `src/benchmark/` como scripts independientes ejecutables contra
> repositorios de prueba.

### Paso 9: Cómo desarrollar una nueva estrategia

1. **Crear la clase** en `src/retriever/strategies/` implementando `RecoveryStrategy`:
   ```typescript
   import { type RecoveryStrategy, type ContextChunk } from "../models/strategies/types.js";
   import type { SanitizerOutput } from "../models/utilities/types.js";

   export class MiEstrategia implements RecoveryStrategy {
     constructor(
       private readonly db: LaCoCoDatabase,
       // ... otras dependencias (LanceDB, Ollama, etc.)
     ) {}

     async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
       // Acceder a:
       //   query.clean_query      → versión BM25 (tokens OR-joined)
       //   query.embedding_input   → versión semántica (texto natural)
       //   query.dimensions        → SYS/CPG/DTG hint
       //   query.intent            → understand|refactor|create|debug|integrate
       //   query.confidence        → 0.0–1.0

       // Usar los servicios disponibles:
       //   this.db.searchBM25(query, limit)  → FTS5
       //   this.db.getNodeSignatures(ids)    → firmas
       //   this.db.getNodesByDimension(dim)  → metadata
       //   this.lanceDb.search(embedding, filter, topK) → ANN

       return chunks;
     }
   }
   ```

2. **Registrarla en el CLI** — en `src/cli/index.ts`, agregar el case en el
   switch de selección de estrategia (~líneas 194-216). Si la estrategia
   necesita LanceDB, incluirla en el array `needsLanceDb`.

3. **Agregar tests** en `tests/retrieval/` siguiendo el patrón de las suites
   existentes (Vitest, DB en memoria `:memory:` para tests de SQLite).

---

## Parte III — Mejoras Pendientes y Gaps Identificados

### Prioridad alta

| Gap | Descripción | Ubicación |
|-----|-------------|-----------|
| **Clasificador liviano (nivel 2)** | El `DimensionalFilter` nivel 2 es un placeholder que multiplica por 0.85 sin clasificar. Implementar embeddings + regresión logística con modelo serializado. | `src/retriever/utilities/filters/dimensional-filter.ts:68` |
| **Bug CLI** | Línea `0` solitaria en `src/cli/index.ts:238`. | `src/cli/index.ts:238` |
| **CLI help text** | El `--strategy` del comando `retrieve` no menciona `bm25-dim` en el help text, aunque sí está implementado. | `src/cli/index.ts:151` |
| **AGENTS.md desactualizado** | Las rutas documentadas no coincidían con las reales. ✅ Corregido en esta versión. | — |

### Prioridad media

| Gap | Descripción |
|-----|-------------|
| **Re-ranker agéntico en Hybrid** | El AGENTS.md original mencionaba "Opcional: re-ranker agente sobre top 20" en Hybrid, pero no está implementado. |
| **AgenticStandalone acepta `slmEndpoint` sin usarlo** | El constructor recibe el parámetro pero nunca llama a Ollama. Es solo expansión por vecindad. |
| **LIMITs hardcodeados** | `bm25-dim-strategy.ts` usa 200 para candidatos por dimensión. `agentic-standalone-strategy.ts` usa 100 para neighbors. |
| **`natural` no usado** | La dependencia `natural` está en `package.json` pero ningún archivo la importa. |
| **Confidence máximo 0.95** | `AgentIntermediary1` tiene `Math.min(bestScore * 0.25 + 0.4, 0.95)` — nunca llega a 1.0. |

### Prioridad baja

| Gap | Descripción |
|-----|-------------|
| **EmbeddingIndexer sin paginación** | `getAllNodes()` carga `SELECT * FROM nodes` completo. Para >5000 nodos puede causar presión de memoria. |
| **Sin logging estructurado** | Todos los componentes usan `console.log`/`console.warn`/`console.error` directo. |
| **Sin tests de integración** | No hay tests end-to-end del pipeline completo (sanitize → retrieve → aggregate → inject). |
| **Sin vitest.config.ts** | No hay archivo de configuración explícito para Vitest; usa defaults. |
| **Naming inconsistente** | `package.json` name es `tensor-extractor`, bin es `lacoco`, banner dice `tensor-extractor`. |

---

## Apéndice: Glosario

| Término | Significado |
|---------|-------------|
| **SLM** | Small Language Model (modelo local ligero, ej. Qwen2.5-Coder:1.5B) |
| **LLM** | Large Language Model (modelo de generación final, puede ser local o API) |
| **RAG** | Retrieval-Augmented Generation (Generación Aumentada por Recuperación) |
| **RRF** | Reciprocal Rank Fusion (método de fusión de rankings) |
| **ANN** | Approximate Nearest Neighbors (búsqueda aproximada de vecinos cercanos) |
| **FTS5** | Full-Text Search versión 5 (extensión de SQLite) |
| **BM25** | Best Match 25 (algoritmo de ranking probabilístico para IR) |
| **DTG** | Data-flow Graph (grafo de flujo de datos) |
| **CPG** | Control & Program Graph (grafo de control y programa) |
| **SYS** | System Graph (grafo del ecosistema del sistema) |
| **DAOs** | Data Access Objects (patrón de acceso a datos sin ORM) |

---

> Última actualización: 2026-06-02
> Mantenedor: Equipo LaCoCo (Benavides Rubén, Cobeña Joan)
