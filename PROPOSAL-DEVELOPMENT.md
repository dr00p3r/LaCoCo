# LaCoCo — Guía de Desarrollo de Propuestas de Retrieval

> Documento vivo destilado de la implementación de ICTD (Proposal 1) y CLCR (Proposal 2).
> Usalo como checklist al codificar una nueva estrategia de recuperación.

---

## 1. Anatomía de una Estrategia

Toda propuesta toca exactamente **3 archivos**:

| # | Archivo | Acción |
|---|---------|--------|
| 1 | `src/retriever/strategies/<name>-strategy.ts` | Crear |
| 2 | `src/cli/index.ts` | Modificar (import + help text + switch case) |
| 3 | `considerations.md` | Añadir entrada nueva |

Si la estrategia requiere **datos precomputados offline** (ej. comunidades), además:

| # | Archivo | Acción |
|---|---------|--------|
| 4 | `src/persistence/.../migrations/00X_add_<feature>.sql` | Crear migración |
| 5 | `src/persistence/.../lacoco-sqlite-service.ts` | Añadir métodos públicos |
| 6 | Nuevo comando en `src/cli/index.ts` | Registrar subcomando |

---

## 2. Esqueleto TypeScript de una Estrategia

```typescript
/**
 * XxxStrategy (2.X) — Descripción de una línea.
 *
 * Explicación de la hipótesis y el algoritmo en 5-6 líneas.
 */

import {
  type RecoveryStrategy,
  type ContextChunk,
} from "../models/strategies/types.js";
import type { SanitizerOutput, IntentTag } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";

// ── Constantes reutilizables ───────────────────────────────────
// Si usás dimensiones, copiá DIM_MAP e INTENT_WEIGHTS de ICTD.
// Son constantes de módulo, no de clase.

const DIM_MAP: Record<string, "SYS" | "CPG" | "DTG"> = { /* ... */ };

// ── Config tipada ──────────────────────────────────────────────

export interface XxxConfig {
  chunkLimit: number;
  // ...
}

const DEFAULT_CONFIG: XxxConfig = {
  chunkLimit: 50,
  // ...
};

// ── Clase ──────────────────────────────────────────────────────

export class XxxStrategy implements RecoveryStrategy {
  private readonly config: XxxConfig;

  constructor(
    private readonly db: LaCoCoDatabase,
    config?: Partial<XxxConfig>
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    // 1. Usar query.clean_query para BM25
    // 2. Usar query.embedding_input para semántica (si usás LanceDB)
    // 3. Usar query.intent para pesos dimensionales
    // 4. Usar query.dimensions para hints dimensionales
    // 5. Usar query.confidence para umbrales

    // ... lógica de la estrategia ...

    return chunks; // source label único: "XXX"
  }
}
```

### Reglas de estilo

- `source` en `ContextChunk`: string corto y único (`"ICTD"`, `"CLCR"`, `"BM25"`, etc.)
- Métodos privados: prefijo `#` (`#computeWeights`, `#buildSubgraph`)
- Sin comentarios inline a menos que la lógica sea no-obvia
- JSDoc solo en la clase (el bloque de arriba)
- Imports con extensión `.js` (requerido por `moduleResolution: "NodeNext"`)
- `type` imports para tipos que solo se usan en anotaciones
- `interface DimNeighbors` y `function emptyNeighbors()` como helpers locales si se necesita tipado de vecinos por dimensión

---

## 3. API de Base de Datos Disponible

### Métodos públicos de `LaCoCoDatabase`

```typescript
// ── Búsqueda textual ──
db.searchBM25(query: string, limit?: number): { node_id: string; score: number }[]
  // FTS5: score es el rank (menor = más relevante).
  // Convertir: Math.max(0, 1 - Math.abs(r.score))
  // Normalizar: dividir por el max del batch

// ── Firmas ──
db.getNodeSignatures(ids: string[]): Map<string, string>
  // Devuelve COALESCE(signature, name) para cada id.
  // Usar para poblar ContextChunk.text

// ── Filtro por dimensión (usa node_metadata) ──
db.getNodesByDimension(dim: "SYS"|"CPG"|"DTG", limit?: number): GraphNode[]

// ── Raw SQL (para queries custom) ──
db.getRawDb(): Database.Database
  // Retorna el handle de better-sqlite3.
  // Usar para prepared statements con ? placeholders.
```

### Patrones de SQL crudo vía `db.getRawDb()`

**BFS sobre edges (bidireccional):**
```typescript
const placeholders = frontierArr.map(() => "?").join(",");
const sql = `
  SELECT sourceId, targetId, relation
  FROM edges
  WHERE sourceId IN (${placeholders}) OR targetId IN (${placeholders})
  LIMIT 5000
`;
const params = [...frontierArr, ...frontierArr]; // doble para los dos IN
const edges = rawDb.prepare(sql).all(...params) as {
  sourceId: string; targetId: string; relation: string;
}[];
```

**BFS con filtro por dimensión:**
```typescript
const rPlaceholders = relations.map(() => "?").join(",");
const fPlaceholders = frontierArr.map(() => "?").join(",");
const sql = `
  SELECT sourceId, targetId, relation
  FROM edges
  WHERE (sourceId IN (${fPlaceholders}) OR targetId IN (${fPlaceholders}))
    AND relation IN (${rPlaceholders})
  LIMIT 5000
`;
const params = [...frontierArr, ...frontierArr, ...relations];
```

**Contar dimensiones por nodo (UNION ALL):**
```typescript
const placeholders = allIds.map(() => "?").join(",");
const sql = `
  SELECT nid, relation FROM (
    SELECT sourceId AS nid, relation FROM edges WHERE sourceId IN (${placeholders})
    UNION ALL
    SELECT targetId AS nid, relation FROM edges WHERE targetId IN (${placeholders})
  )
`;
const rows = rawDb.prepare(sql).all(...allIds) as { nid: string; relation: string }[];
```

**Lookup de comunidad (si existe tabla `community_membership`):**
```typescript
const sql = `SELECT node_id, community_id FROM community_membership WHERE node_id IN (${placeholders})`;
```

---

## 4. Patrones Algorítmicos Comunes

### 4.1 Normalización de scores BM25

```typescript
const anchorResults = db.searchBM25(query.clean_query, config.anchorLimit);
const anchorScores = new Map<string, number>();
let maxScore = 0;
for (const r of anchorResults) {
  const s = Math.max(0, 1 - Math.abs(r.score));
  anchorScores.set(r.node_id, s);
  if (s > maxScore) maxScore = s;
}
if (maxScore > 0) {
  for (const [id, s] of anchorScores) anchorScores.set(id, s / maxScore);
}
```

### 4.2 Pesos dimensionales desde intent

Copiar `INTENT_WEIGHTS` y `DIM_MAP` de `ictd-strategy.ts`. Boost por hints:

```typescript
const base = { ...INTENT_WEIGHTS[intent] };
if (dimensions.length > 0 && dimensions.length < 3) {
  for (const dim of dimensions) base[dim] *= 1.5;
}
// Normalizar a suma = 1
const total = base.SYS + base.CPG + base.DTG;
if (total > 0) {
  base.SYS /= total; base.CPG /= total; base.DTG /= total;
}
```

### 4.3 BFS por hops

```typescript
let frontier = new Set(anchorIds);
const visited = new Set<string>();

for (let hop = 0; hop < maxHops && frontier.size > 0; hop++) {
  const edges = /* query edges incidentes al frontier */;
  const nextFrontier = new Set<string>();

  for (const edge of edges) {
    const otherId = frontier.has(edge.sourceId) ? edge.targetId : edge.sourceId;
    if (visited.has(otherId)) continue;
    // ... procesar nodo ...
    nextFrontier.add(otherId);
  }

  for (const id of frontier) visited.add(id);
  frontier = new Set([...nextFrontier].filter(id => !visited.has(id)));

  if (totalNodes + frontier.size > bfsMaxNodes) break;
}
```

### 4.4 Scores con decaimiento por distancia

```typescript
const decay = Math.pow(decayFactor, hop + 1);  // 0.5, 0.25, 0.125...
const propagated = srcScore * decay;
targetScore = Math.max(existingScore, propagated);
```

### 4.5 Boost multiplicativo por propiedad del nodo

```typescript
// Ejemplo: cross-layer boost
const boost = 1 + lambda * (layerCount - 1);
// 1 capa  → ×1.00
// 2 capas → ×(1 + lambda)
// 3 capas → ×(1 + 2*lambda)

const finalScore = baseScore * boost;
```

---

## 5. Checklist de Registro en CLI

### 5.1 Determinar dependencias

```
¿Usa LanceDB? ──→ añadir a array needsLanceDb
¿Usa Ollama?  ──→ constructor recibe endpoint string
¿Solo SQLite? ──→ rama else del switch
```

### 5.2 Pasos en `src/cli/index.ts`

```typescript
// 1. Agregar import (línea ~24)
import { XxxStrategy } from "../retriever/strategies/xxx-strategy.js";

// 2. Si solo SQLite, agregar case en rama else (~línea 267):
case "xxx":
  strategy = new XxxStrategy(db);
  break;

// 3. Si necesita LanceDB, agregar case en rama if (~línea 253):
case "xxx":
  strategy = new XxxStrategy(db, lanceDb);
  break;

// 4. Si necesita Ollama, pasar endpoint:
case "xxx":
  strategy = new XxxStrategy(db, options.ollama);
  break;

// 5. Actualizar help text de retrieve (~línea 207):
.option("-s, --strategy <name>", "... xxx)", "hybrid")

// 6. Actualizar help text de inspect-query (~línea 368):
.option("-s, --strategy <name>", "... xxx)", "hybrid")
```

**Tip:** usar `replaceAll: true` en el edit para actualizar ambos help texts de una vez.

---

## 6. Verificación

```bash
# TypeScript debe compilar sin errores
npx tsc --noEmit

# Los 32 tests existentes deben seguir pasando
npx vitest run
```

Si tu estrategia agrega tests nuevos, crealos en `tests/retrieval/xxx-strategy.test.ts` siguiendo el patrón Vitest + `:memory:` DB de los tests existentes.

---

## 7. Template para `considerations.md`

```markdown
## Proposal N: XXX (Nombre Completo)

**Status:** Implemented (`src/retriever/strategies/xxx-strategy.ts`, CLI flag `--strategy xxx`)

### Summary

Dos frases explicando la hipótesis y qué encuentra la estrategia.

### Algorithm

1. Paso 1
2. Paso 2
3. ...

### Intent → X Mapping  (si aplica)

Tabla o lista de cómo el intent del query influye en la estrategia.

### Configuration (tunable via constructor)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `param` | valor | qué hace |

### Considerations

- **Punto de diseño 1:** justificación y alternativas.
- **Punto de diseño 2:** posibles mejoras futuras.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| Caso borde 1 | Comportamiento |
| Caso borde 2 | Comportamiento |
```

---

## 8. Árbol de Decisión Rápido

```
¿La estrategia requiere datos precomputados offline?
├─ Sí → Nuevo comando CLI + migración SQL + métodos en LaCoCoDatabase
└─ No  → Solo strategy file + CLI registration

¿Usa embeddings (LanceDB)?
├─ Sí → Agregar a needsLanceDb array, constructor recibe LaCoCoLanceDb
└─ No  → Solo LaCoCoDatabase en constructor

¿Usa Ollama / SLM?
├─ Sí → Constructor recibe endpoint: string, usar OllamaService
└─ No  → Sin dependencias externas

¿Necesita filtrar edges por dimensión?
├─ Sí → Copiar DIM_MAP y DIM_RELATIONS de ICTD
└─ No  → BFS genérico sobre todas las edges

¿Necesita pesos por intent?
├─ Sí → Copiar INTENT_WEIGHTS de ICTD
└─ No  → Comportamiento uniforme

¿El puntaje es por nodo o por camino?
├─ Por nodo → Acumular en Map<string, number>, aplicar boost al final
└─ Por camino → Trackear caminos explícitamente durante BFS/difusión
```

---

## 9. Estrategias Implementadas (referencia rápida)

| # | Nombre | Archivo | Dependencias | Mecanismo |
|---|--------|---------|-------------|-----------|
| Utilidad | BM25 Service | `utilities/search/bm25-service.ts` | SQLite | FTS5, normalización y construcción de chunks |
| 2.3 | Agentic | `agentic-strategy.ts` | SQLite + Ollama | SLM planifica tools |
| 2.4 | Hybrid | `hybrid-strategy.ts` | SQLite + LanceDB | BM25 + ANN + RRF |
| 2.6 | ICTD | `ictd-strategy.ts` | SQLite | Tensor diffusion |
| 2.7 | CLCR | `clcr-strategy.ts` | SQLite | Staged BFS cross-layer |
| 2.8 | RPR | `rpr-strategy.ts` | SQLite | Relational path enumeration |

---

> Última actualización: 2026-06-20
> Mantenedor: Equipo LaCoCo
