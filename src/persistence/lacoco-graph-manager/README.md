# LaCoCo — Base de Datos SQLite

## Propósito

Módulo de persistencia del grafo multirrelacional generado por el extractor estático. Provee acceso a SQLite con esquema versionado, índices FTS5 para búsqueda BM25, y metadatos dimensionales (SYS/CPG/DTG) para filtrado rápido.

## Esquema

```
src/persistence/lacoco-graph-manager/
├── model/
│   └── types.ts                ← GraphNode, GraphEdge (interfaces)
├── dao/
│   ├── node-dao.ts             ← CRUD de nodos
│   ├── edge-dao.ts             ← CRUD de aristas
│   ├── search-dao.ts           ← Búsqueda FTS5 y filtro dimensional
│   ├── migration-dao.ts        ← Inicialización de esquema y migraciones
│   └── connection-dao.ts       ← Ciclo de vida de la conexión
├── migrations/
│   ├── 001_add_fts5.sql        ← Tabla virtual FTS5 para BM25
│   └── 002_add_metadata.sql    ← Tabla node_metadata para filtro dimensional
└── lacoco-sqlite-service.ts    ← Fachada pública del módulo
```

## Funciones del Service (`LaCoCoDatabase`)

| Método | Descripción |
|--------|-------------|
| `constructor(dbPath?)` | Abre conexión SQLite, migra esquema, compila prepared statements |
| `insertNode(node)` | Inserta o reemplaza un nodo en el grafo |
| `insertEdge(edge)` | Inserta una arista ignorando duplicados |
| `deleteNodesByFile(filepath)` | Elimina nodos y aristas de un archivo |
| `getNodesByFile(filepath)` | Recupera todos los nodos de un archivo |
| `getNodeSignatures(ids)` | Obtiene signaturas de múltiples nodos por ID |
| `searchBM25(query, limit?)` | Búsqueda full-text BM25 sobre FTS5 |
| `getNodesByDimension(dimension, limit?)` | Filtra nodos por dimensión semántica |
| `transaction(fn)` | Ejecuta operaciones en una transacción atómica |
| `stats()` | Conteo rápido de nodos y aristas |
| `close()` | Cierra la conexión limpiamente |
| `getRawDb()` | Expone la instancia raw de better-sqlite3 |
