# LaCoCo — Utilidades de Embeddings

## Propósito

Convierte los nodos del grafo estructural (SQLite) en vectores semánticos que permiten búsqueda por similitud ANN en LanceDB. El `EmbeddingGenerator` es el motor que produce vectores de 384 dimensiones usando `all-MiniLM-L6-v2` vía transformers.js. El `EmbeddingIndexer` orquesta el pipeline completo: lee los nodos de SQLite, genera sus embeddings, infiere metadatos dimensionales y los persiste en LanceDB. Se ejecuta después del cold-start del extractor y también en hot-reload incremental.

## Esquema

```
src/retriever/utilities/embeddings/
├── embedding-generator.ts    ← Motor de embeddings (all-MiniLM-L6-v2)
├── embedding-indexer.ts      ← Orquestador post-extracción
└── README.md
```

## Funciones de las Utilidades

### `EmbeddingGenerator`

Motor de embeddings 100% offline. Carga lazy el modelo `Xenova/all-MiniLM-L6-v2` (~80MB cuantizado) en la primera llamada a `generate()` o `generateBatch()`. Todas las llamadas posteriores reutilizan la misma instancia en memoria.

**Datos de configuración:**

| Parámetro | Valor |
|-----------|-------|
| Modelo | `Xenova/all-MiniLM-L6-v2` |
| Motor | `@xenova/transformers` (transformers.js, Node.js nativo) |
| Tamaño | ~80 MB (cuantizado int8) |
| Dimensiones de salida | 384 (`EMBEDDING_DIM`) |
| Pooling | `mean` (promedia los tokens del texto de entrada) |
| Normalización | `true` (normalización L2, necesaria para similitud coseno en LanceDB) |
| Carga | Lazy (se descarga automáticamente en el primer uso) |

**Métodos:**

| Método | Descripción |
|--------|-------------|
| `generate(text)` | Genera un `Float32Array` de 384 dimensiones para un texto dado. Aplica pooling mean + normalización L2. |
| `generateBatch(texts)` | Genera embeddings para múltiples textos en paralelo via `Promise.all`. Más eficiente que N llamadas individuales. |

---

### `EmbeddingIndexer`

Orquesta la generación de embeddings para todos los nodos del grafo. Se ejecuta automáticamente tras el cold-start del extractor y también cuando un archivo cambia (hot-reload). Recibe las instancias de `LaCoCoDatabase` (lectura de nodos) y `LaCoCoLanceDb` (persistencia vectorial).

**Datos de configuración:**

| Parámetro | Valor |
|-----------|-------|
| `BATCH_SIZE` | 32 nodos por lote (controla uso de memoria) |
| Texto a vectorizar | `"{name} {signature}"` (nombre del nodo + su firma/código) |
| Inferencia de dimensión | Voto ponderado entre aristas del nodo y su `kind` |
| Inferencia de sub_tipo | Mapeo directo desde `node.kind` |

**Métodos:**

| Método | Descripción |
|--------|-------------|
| `constructor(db, lanceDb)` | Recibe `LaCoCoDatabase` (grafo SQLite) y `LaCoCoLanceDb` (base vectorial LanceDB). |
| `indexAll(onProgress?)` | Lee todos los nodos con `SELECT * FROM nodes`, genera embeddings en batches de 32, infiere metadatos e inserta en LanceDB. El callback `onProgress(current, total)` permite reportar avance. |
| `indexFile(filePath)` | Re-indexa embeddings de un archivo específico. Primero elimina los embeddings previos del archivo via `deleteByNodeId`, luego regenera los nuevos. Se usa en hot-reload cuando un archivo cambia. |

**Pipeline interno (`#indexBatch`):**

```
GraphNode[] (batch de 32 nodos desde SQLite)
    │
    ▼
[1] Construir texto a vectorizar por nodo
    │  └─ `${n.name} ${n.signature}`
    │  └─ Ej: "HybridStrategy export class HybridStrategy implements RecoveryStrategy"
    │
    ▼
[2] EmbeddingGenerator.generateBatch(texts)
    │  └─ Config: pooling=mean, normalize=true
    │  └─ Retorna: Float32Array[384] por cada texto
    │
    ▼
[3] Inferir dimensión semántica (#inferDimension)
    │  └─ Cuenta aristas del nodo en SQLite:
    │     ├─ EXTENDS / IMPLEMENTS / IMPORTS_EXTERNAL  →  SYS
    │     ├─ INJECTS / CALLS / INSTANTIATES            →  CPG
    │     └─ CONSUMES_DATA / PRODUCES / MUTATES_STATE  →  DTG
    │  └─ Fallback por kind del nodo (sin aristas):
    │     ├─ CLASS / INTERFACE          →  SYS (+2)
    │     ├─ METHOD / FUNCTION / ARROW  →  CPG (+2)
    │     └─ PROPERTY / VARIABLE        →  DTG (+1)
    │  └─ Dimensión ganadora = la de mayor puntaje total
    │
    ▼
[4] Inferir sub_tipo (#inferSubType)
    │  └─ Mapeo directo desde node.kind:
    │     CLASS → class | METHOD → method | FUNCTION → function
    │     ARROW_FUNCTION → arrow_function | VARIABLE → variable
    │     INTERFACE → interface | TYPE → type_alias
    │     ENUM → enum | ENUM_MEMBER → enum_member
    │     PROPERTY → property | ACCESSOR → accessor
    │     EXTERNAL_LIB → package
    │
    ▼
[5] Construir NodeEmbeddingRecord[]
    │  └─ { node_id, embedding, dimension, sub_type, file_path }
    │
    ▼
[6] LaCoCoLanceDb.insertBatch(records)
    │  └─ Persiste en LanceDB con filtros pre-ANN por metadatos
```

**Campos del registro insertado en LanceDB (`NodeEmbeddingRecord`):**

| Campo | Fuente | Ejemplo |
|-------|--------|---------|
| `node_id` | `node.id` (PK del nodo en SQLite) | `"/src/service.ts#OrderService.create"` |
| `embedding` | Vector generado por `EmbeddingGenerator` | `Float32Array(384)` |
| `dimension` | Inferido por `#inferDimension` | `"CPG"` |
| `sub_type` | Inferido por `#inferSubType` | `"method"` |
| `file_path` | `node.filepath` | `"/src/service.ts"` |
