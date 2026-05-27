# LaCoCo — Utilidades de Filtros

## Propósito

Conjunto de utilidades que operan en distintos puntos del pipeline RAG. El `DimensionalFilter` clasifica la consulta del usuario en una dimensión semántica (SYS/CPG/DTG) **antes y durante la recuperación**, permitiendo a las estrategias filtrar el espacio de búsqueda. El `ContextAggregator` y el `PromptInjector` actúan **después de la recuperación**: el primero depura, ordena y trunca los chunks obtenidos; el segundo estructura el bloque de contexto final para inyectarlo al LLM.

## Esquema

```
src/retriever/utilities/filters/
├── dimensional-filter.ts     ← Clasificador dimensional SYS/CPG/DTG (pre-RAG)
├── context-aggregator.ts     ← Deduplicador y truncador de chunks (post-RAG)
├── prompt-injector.ts        ← Inyector de contexto en prompt template (post-RAG)
└── README.md
```

## Funciones de las Utilidades

### `DimensionalFilter`

Clasifica la consulta del usuario en una o más dimensiones del grafo multirrelacional. Se usa **antes y durante** la recuperación: las estrategias (HybridStrategy, AgenticStrategy) lo consultan para filtrar el espacio de búsqueda por dimensión, reduciendo ruido y mejorando precisión.

**Datos de configuración:**

| Parámetro | Valor |
|-----------|-------|
| `confidenceThreshold` | `0.65` (default). Si la confianza del nivel heurístico supera este umbral, no recurre al SLM. |
| SLM fallback | `OllamaService` con `qwen2.5-coder:1.5b` (opcional, para nivel 3). |

**Keywords de clasificación O(1):**

| Dimensión | Keywords |
|-----------|----------|
| **SYS** (Ecosistema) | `hereda`, `extends`, `implementa`, `implements`, `interfaz`, `interface`, `clase base`, `superclass`, `importa`, `imports`, `librería`, `library` |
| **CPG** (Estructura) | `inyecta`, `injects`, `constructor`, `llama`, `calls`, `invoca`, `instancia`, `instantiates`, `crea`, `new`, `método`, `method`, `función`, `function` |
| **DTG** (Flujo datos) | `dto`, `data`, `payload`, `parámetro`, `parameter`, `retorna`, `returns`, `output`, `resultado`, `muta`, `mutates`, `estado`, `state`, `propiedad`, `property`, `campo`, `field` |

**Pipeline de clasificación (3 niveles):**

```
SanitizerOutput (del AgentIntermediary1)
    │
    ▼
[Nivel 1] #heuristicFilter(query.clean_query)
    │  └─ Busca keywords dimensionales en la query limpia
    │  └─ Calcula confidence = min(maxScore / total + 0.3, 0.9)
    │  └─ Si confidence >= threshold (0.65) → retorna dimensiones
    │
    ▼ (si confianza baja)
[Nivel 2] Clasificador liviano (placeholder)
    │  └─ Multiplica confianza heurística por 0.85
    │  └─ Si supera threshold → retorna dimensiones
    │
    ▼ (si confianza sigue baja y Ollama disponible)
[Nivel 3] SLM Fallback
    │  └─ OllamaService.generate() con prompt dimensional
    │  └─ Parsea "SYS"/"CPG"/"DTG" de la respuesta
    │
    ▼ (si todo falla)
    query.dimensions (sugerencia del intermediario) o ["CPG"]
```

**Fórmula de confianza heurística:**

```
confidence = min(maxScore / total + 0.3, 0.9)
```

Donde `total` = suma de keywords de todas las dimensiones, y `maxScore` = puntaje de la dimensión con más coincidencias. A más keywords concentradas en una sola dimensión, mayor confianza. Si ninguna keyword coincide, retorna `{ dimensions: ["CPG"], confidence: 0.3 }`.

---

### `ContextAggregator`

Procesa los chunks devueltos por las estrategias **después de la recuperación**. Elimina duplicados (un mismo `nodeId` puede venir de BM25 y ANN), filtra los de muy baja relevancia, ordena por score y trunca cuando se supera el límite de tokens del contexto.

**Datos de configuración:**

| Parámetro | Valor |
|-----------|-------|
| `maxTokens` | `4000` (default). Límite de tokens estimados del contexto inyectado al LLM. |
| `minScore` | `0.01` (default). Los chunks con score inferior se descartan (ruido). |
| Estimación de tokens | `1 token ≈ 0.75 palabras` |

**Pipeline de agregación:**

```
ContextChunk[] (desde estrategias: BM25, ANN, RRF, AGENTIC)
    │
    ▼
[1] Deduplicar por nodeId
    │  └─ Map<nodeId, ContextChunk> (conserva el de mayor score)
    │
    ▼
[2] Filtrar por score >= minScore
    │  └─ Descarta chunks de baja relevancia (ruido)
    │
    ▼
[3] Ordenar por score descendente
    │  └─ Más relevante primero
    │
    ▼
[4] Truncar por tokens estimados
    │  └─ tokens = ceil(palabras / 0.75)
    │  └─ Acumula hasta alcanzar maxTokens
    │
    ▼
ContextChunk[] (depurado, ordenado, truncado)
```

**Métodos:**

| Método | Descripción |
|--------|-------------|
| `aggregate(chunks, maxTokens?, minScore?)` | Deduplica por `nodeId`, filtra por `minScore`, ordena por score descendente y trunca al superar `maxTokens`. |

---

### `PromptInjector`

Toma los chunks ya agregados y **construye el bloque de contexto** que se antepone al prompt original del usuario. Usa templates versionados (actualmente `v1`) que formatean cada chunk con su fuente, identificador y código. Si no hay chunks, retorna el prompt tal cual.

**Datos de configuración:**

| Parámetro | Valor |
|-----------|-------|
| Template activo | `v1` |
| Formato por chunk | `[N] source | nodeId\ncódigo` |
| Separador entre chunks | `---` |

**Template `v1` de inyección:**

```
### Contexto del Proyecto (recuperado automáticamente)
Los siguientes fragmentos de código fueron recuperados del repositorio actual
como contexto para tu consulta. Úsalos como referencia absoluta de firmas,
tipos y dependencias locales. No inventes símbolos que no aparezcan aquí.

[1] RRF | /src/service.ts#Clase.metodo
export class Clase { ... }

---

[2] BM25 | /src/otro.ts#Funcion
function funcion() { ... }

### Fin del Contexto

{prompt original del usuario}
```

**Métodos:**

| Método | Descripción |
|--------|-------------|
| `inject(originalPrompt, chunks, version?)` | Genera el bloque de contexto con los chunks usando el template especificado y lo antepone al prompt original. Si `chunks` está vacío, retorna el prompt sin modificar. Lanza error si la versión del template no existe. |
