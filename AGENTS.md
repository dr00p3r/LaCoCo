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
[LLM CON CONTEXT ENRIQUECIDO]
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
├── extractor/               ← Módulo de análisis estático
│   ├── daemon.ts            ← Orquestador cold-start + watcher + embeddings
│   └── graph-extractor.ts   ← Núcleo AST (ts-morph → SQLite)
│
├── retriever/               ← Módulo de recuperación contextual (RAG)
│   ├── agent-intermediary-1.ts    ← Clasificador + Sanitizador
│   ├── context-aggregator.ts      ← Deduplica, ordena, trunca
│   ├── dimensional-filter.ts      ← Pipeline 3 niveles (heurísticas → SLM)
│   ├── embedding-indexer.ts     ← Genera embeddings post-extracción
│   ├── embedding/
│   │   └── embedding-generator.ts  ← all-MiniLM-L6-v2 vía transformers.js
│   ├── infra/
│   │   ├── lancedb-client.ts      ← Wrapper LanceDB (ANN + filtros)
│   │   ├── ollama-client.ts       ← Cliente HTTP para SLM local
│   │   └── types.ts               ← NodeEmbeddingRecord
│   ├── prompt/
│   │   └── prompt-injector.ts     ← Template versionado de inyección
│   └── strategies/
│       ├── base.ts                ← RecoveryStrategy interface
│       ├── bm25-strategy.ts       ← 2.1 BM25 puro
│       ├── bm25-dim-strategy.ts   ← 2.2 BM25 + filtro dimensional
│       ├── agentic-strategy.ts    ← 2.3 LLM planificador + executor
│       ├── hybrid-strategy.ts     ← 2.4 BM25 + ANN + RRF + agente
│       └── agentic-standalone-strategy.ts  ← 2.5 Agente sin filtro
│
├── shared/                  ← Recursos compartidos entre módulos
│   └── db/
│       └── sqlite-manager.ts  ← SQLite + FTS5 + metadata (sin ORM)
│
├── cli/
│   └── index.ts             ← Punto de entrada: watch, index, retrieve
│
db/migrations/               ← Migraciones SQL versionadas
├── 001_add_fts5.sql         ← Tabla virtual FTS5 para BM25
└── 002_add_metadata.sql     ← Tabla node_metadata para filtro dimensional

tests/                       ← Tests Vitest (cobertura >= 70% en retriever)
└── retrieval/
    ├── agent-intermediary-1.test.ts
    ├── dimensional-filter.test.ts
    ├── bm25-strategy.test.ts
    ├── context-aggregator.test.ts
    └── prompt-injector.test.ts
```

### 4. Decisiones de Tecnología

#### 4.1 Almacenamiento Dual

| Rol | Tecnología | Justificación |
|-----|-----------|---------------|
| Grafo estructural + BM25 | SQLite (better-sqlite3) + FTS5 | Ya en uso. WAL mode. Índices nativos. FTS5 para BM25 full-text. |
| Embeddings + ANN | LanceDB | Embebible (sin servidor). Rust-based. ANN aproximado con filtros pre-ANN por metadatos (dimension, sub_type, file_path). Reduce latencia filtrando antes de calcular distancias. |

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
- **Justificación:** 100% offline. Sin dependencia de Python ni Ollama para embeddings.
  Carga lazy, inferencia en CPU/GPU según disponibilidad.
- **Indexer:** `EmbeddingIndexer` orquesta la generación batch post-extracción,
  leyendo nodos de SQLite, generando embeddings, e insertando en LanceDB con
  metadatos inferidos (dimension, sub_type).

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
│ 2. Clasificador     │  ← Embeddings + Regresión Logística entrenada local
│    Liviano          │     (modelo .json serializado, sin dependencias pesadas)
└─────────────────────┘
       │
       ▼ si confianza < 0.65
┌─────────────────────┐
│ 3. SLM Fallback     │  ← Ollama local: Qwen2.5-Coder:1.5B
│   (Ollama)          │     Prompt: "Clasifica esta consulta en SYS, CPG o DTG"
└─────────────────────┘
```

#### 4.4 Modelo de Lenguaje para Agente Agéntico

- **Modelo:** Qwen2.5-Coder:1.5B vía Ollama (local, sin llamadas de red)
- **Cliente:** `OllamaClient` (`src/retriever/infra/ollama-client.ts`) — HTTP
  wrapper para `/api/generate`, `/api/chat`, `/api/tags`.
- **Uso:** Strategy 2.3/2.5 (agentic) emite herramientas (tool-calling).
  Motor determinístico ejecuta sobre SQLite/LanceDB.
  Máximo 3 iteraciones.

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

### 5. Patrón Strategy: 5 Estrategias de Recuperación

```
┌─────────────────────────────────────────────────────────────┐
│                    RecoveryStrategy (interface)             │
├─────────────────────────────────────────────────────────────┤
│  + retrieve(query: SanitizedQuery): Promise<ContextChunk[]> │
└─────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────────┐    ┌─────────────────────┐
│ BM25Strategy  │    │ BM25DimFilter     │    │ AgenticStrategy     │
│ (2.1)         │    │ Strategy (2.2)    │    │ (2.3)               │
│               │    │                   │    │ LLM planificador +  │
│ BM25 puro     │    │ BM25 dirigido por │    │ ejecutor determinístico│
│ sin filtros   │    │ dimensión detectada│   │ max 3 iteraciones   │
└───────────────┘    └───────────────────┘    └─────────────────────┘
                              │                        │
                              ▼                        ▼
                    ┌───────────────────┐    ┌─────────────────────┐
                    │ HybridStrategy    │    │ AgenticStandalone   │
                    │ (2.4)             │    │ Strategy (2.5)      │
                    │ BM25 + Embeddings │    │ Agente sin filtro   │
                    │ + RRF + DimFilter │    │ dimensional         │
                    │ + Apoyo agente    │    │ (baseline agentic)    │
                    └───────────────────┘    └─────────────────────┘
```

| # | Nombre | Descripción | Cuándo usar |
|---|--------|-------------|-------------|
| 2.1 | `BM25Strategy` | Búsqueda full-text BM25 sobre FTS5 SQLite. Sin filtros dimensionales. | Baseline rápido. Queries cortas o cuando no importa la capa. |
| 2.2 | `BM25DimFilterStrategy` | Aplica DimensionalFilter primero, luego BM25 solo sobre nodos de esa dimensión. | Cuando la intención es claramente estructural o de datos. |
| 2.3 | `AgenticStrategy` | LLM planificador emite herramientas (get_neighbors, get_node_by_symbol, get_dependencies). Motor determinístico ejecuta. Max 3 iteraciones. | Queries complejas que requieren navegación explícita del grafo. |
| 2.4 | `HybridStrategy` | BM25 + ANN sobre LanceDB. Fusión RRF. Filtro dimensional pre-ANN. Agente como re-ranker final opcional. | Máxima calidad de recuperación. Recomendado por defecto. |
| 2.5 | `AgenticStandaloneStrategy` | Variante de 2.3 sin filtro dimensional. Agente puro sobre grafo completo. | Para comparar el valor agregado del filtro dimensional en benchmarks. |

### 6. Interfaz SanitizerOutput

```typescript
interface SanitizerOutput {
  route: "RAG" | "LLM_DIRECT";
  clean_query: string;          // normalizado para BM25/FTS5
  embedding_input: string;        // semántico para LanceDB
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

### 7. Restricciones Técnicas Obligatorias

#### Runtime y Módulos
- **ESM-first:** todos los módulos usan `import/export`. CommonJS (`require`)
  solo permitido en configuraciones de herramientas externas.
- **Node.js >= 20 LTS** requerido (uso de `--experimental-vm-modules`,
  `crypto.subtle`, y `fs/promises` nativo).

#### Base de Datos
- **No usar ORMs sobre SQLite** (Prisma, Drizzle, TypeORM están prohibidos).
  Todas las queries se escriben con `better-sqlite3` directo.
- Las migraciones de esquema se versionan en `/db/migrations/` como
  archivos `.sql` numerados secuencialmente.

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
| Migraciones SQL (FTS5 + metadata) | ✅ Completo | `db/migrations/001_add_fts5.sql`, `002_add_metadata.sql` |
| SQLiteManager (grafo + BM25 + metadata) | ✅ Completo | `src/shared/db/sqlite-manager.ts` |
| LanceDB Client | ✅ Completo | `src/retriever/infra/lancedb-client.ts` |
| EmbeddingGenerator | ✅ Completo | `src/retriever/embedding/embedding-generator.ts` |
| EmbeddingIndexer | ✅ Completo | `src/retriever/embedding-indexer.ts` |
| OllamaClient | ✅ Completo | `src/retriever/infra/ollama-client.ts` |
| Agente Intermediario 1 | ✅ Completo | `src/retriever/agent-intermediary-1.ts` |
| DimensionalFilter (3 niveles) | ✅ Completo | `src/retriever/dimensional-filter.ts` |
| 5 Strategies de recuperación | ✅ Completo | `src/retriever/strategies/*.ts` |
| ContextAggregator | ✅ Completo | `src/retriever/context-aggregator.ts` |
| PromptInjector | ✅ Completo | `src/retriever/prompt/prompt-injector.ts` |
| CLI (watch, index, retrieve) | ✅ Completo | `src/cli/index.ts` |
| Tests (32 tests, 5 suites) | ✅ Pasando | `tests/retrieval/*.test.ts` |

### Paso 0: Dependencias

Instalar las dependencias:

```bash
npm install
```

Dependencias ya configuradas en `package.json`:
- `@lancedb/lancedb` — Base vectorial embebida
- `@xenova/transformers` — Embeddings locales
- `better-sqlite3` — SQLite nativo
- `commander` — CLI
- `ts-morph` — Análisis AST
- `vitest` — Tests (dev)

### Paso 1: Estructura de directorios (ya implementada)

```
src/
├── extractor/         ← Análisis estático
├── retriever/         ← Pipeline RAG completo
│   ├── embedding/
│   ├── infra/
│   ├── prompt/
│   └── strategies/
├── shared/db/         ← SQLite (usado por extractor y retriever)
└── cli/
db/migrations/         ← SQL versionado
tests/retrieval/       Tests Vitest
```

### Paso 2: Migraciones SQL (ya implementadas)

- **`db/migrations/001_add_fts5.sql`** — Tabla virtual FTS5 `nodes_fts` para BM25
  sobre `name` y `signature`, con triggers de sincronización automática.
- **`db/migrations/002_add_metadata.sql`** — Tabla `node_metadata` para
  filtrado dimensional rápido por `dimension` (SYS/CPG/DTG).

### Paso 3: Infraestructura de datos (ya implementada)

| Archivo | Responsabilidad |
|---------|----------------|
| `src/retriever/infra/lancedb-client.ts` | Conexión LanceDB, tabla `node_embeddings`, índice ANN HNSW, búsqueda con filtros pre-ANN. |
| `src/retriever/infra/ollama-client.ts` | Cliente HTTP para Ollama (`/api/generate`, `/api/chat`, `/api/tags`). Verifica disponibilidad. |
| `src/retriever/embedding/embedding-generator.ts` | Carga lazy de `all-MiniLM-L6-v2`. Generación individual y batch. |
| `src/retriever/embedding-indexer.ts` | Orquesta: lee nodos SQLite → genera embeddings → infiere metadatos → inserta en LanceDB. |
| `src/shared/db/sqlite-manager.ts` | SQLite con WAL, FTS5 BM25, metadata dimensional, prepared statements. Sin ORM. |

### Paso 4: Pipeline RAG — Componentes Core (ya implementados)

| Orden | Archivo | Descripción |
|-------|---------|-------------|
| 4.1 | `src/retriever/agent-intermediary-1.ts` | Clasifica RAG vs directo. Sanitiza query. Detecta intent por heurísticas. Confidence 0.0–1.0. |
| 4.2 | `src/retriever/dimensional-filter.ts` | Pipeline 3 niveles: Heurísticas O(1) → Clasificador liviano (placeholder) → SLM Ollama fallback. |
| 4.3 | `src/retriever/strategies/base.ts` | `RecoveryStrategy` interface + `ContextChunk` type. |
| 4.4 | `src/retriever/strategies/bm25-strategy.ts` | BM25 puro sobre FTS5. |
| 4.5 | `src/retriever/strategies/bm25-dim-strategy.ts` | BM25 + DimensionalFilter + JOIN a metadata. |
| 4.6 | `src/retriever/strategies/agentic-strategy.ts` | LLM planificador (Ollama) emite JSON tools. Executor determinístico sobre SQLite. Max 3 iteraciones. |
| 4.7 | `src/retriever/strategies/hybrid-strategy.ts` | BM25 + ANN (LanceDB) + RRF (k=60) + DimensionalFilter. |
| 4.8 | `src/retriever/strategies/agentic-standalone-strategy.ts` | Agente sin filtro dimensional (baseline). |
| 4.9 | `src/retriever/context-aggregator.ts` | Deduplica por nodeId, ordena por score, trunca por tokens (default 4000). |
| 4.10 | `src/retriever/prompt/prompt-injector.ts` | Template versionado. Inyecta chunks bajo `### Contexto del Proyecto`. |

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

| Test | Cobertura |
|------|-----------|
| `agent-intermediary-1.test.ts` | Clasificación RAG vs directo, detección de intent |
| `dimensional-filter.test.ts` | Clasificación SYS/CPG/DTG por heurísticas |
| `bm25-strategy.test.ts` | Recuperación BM25 sobre FTS5 con DB en memoria |
| `context-aggregator.test.ts` | Deduplicación, ordenamiento, truncado por tokens |
| `prompt-injector.test.ts` | Inyección de chunks, template versionado |

Ejecutar: `npm test` o `npx vitest run`

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

---

> Última actualización: 2026-05-18
> Mantenedor: Equipo LaCoCo (Benavides Rubén, Cobeña Joan)
