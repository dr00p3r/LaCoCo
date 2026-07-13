# LaCoCo — Vectores LanceDB

## Propósito

Módulo de persistencia vectorial para embeddings semánticos de nodos del grafo. Utiliza LanceDB como base embebida (Rust-based, sin servidor) con índices ANN HNSW para búsqueda aproximada de vecinos cercanos.

## Esquema

```
src/persistence/lacoco-vectors-manager/
├── model/
│   └── types.ts                ← NodeEmbeddingRecord
├── dao/
│   ├── connection-dao.ts       ← connect, close, buildIndex
│   ├── embedding-dao.ts        ← insertBatch, replaceBatch, deleteByNodeId
│   └── search-dao.ts           ← ANN search with pre-filter
└── lacoco-lancedb-service.ts   ← Fachada pública del módulo
```

## Funciones del Service (`LaCoCoLanceDb`)

| Método | Descripción |
|--------|-------------|
| `constructor(dbPath?)` | Configura ruta de la base LanceDB |
| `connect()` | Conecta o crea la tabla `node_embeddings` con schema |
| `close()` | Cierra la conexión |
| `insertBatch(records)` | Inserta lote de embeddings con metadatos |
| `replaceBatch(records)` | Reemplaza atómicamente por `node_id` mediante `mergeInsert`, deduplicando primero el lote |
| `search(embedding, filter?, topK?)` | Búsqueda ANN con filtro pre-vectorial |
| `deleteByNodeId(nodeId)` | Elimina embedding de un nodo |
| `buildIndex()` | Construye índice HNSW sobre columna vector |
| `health()` | Reporta conexión, disponibilidad del índice HNSW, estado de mantenimiento y último error de construcción |

`VectorCallbacks` usa `replaceBatch()` para que la indexación por lotes sea
idempotente por `node_id` y no acumule duplicados durante reindexaciones
parciales, reintentos o eventos del watcher.

`LaCoCoLanceDb` ejecuta mantenimiento con `optimizeIfNeeded()` cuando se superan
umbrales de operaciones, filas modificadas, fragmentos pequenos o filas sin
indexar. Conserva versiones recientes y expone el ultimo resultado en
`health().maintenance`.
