# LaCoCo — Mini-Agents

## Propósito

Punto de entrada del pipeline RAG. El `AgentIntermediary1` clasifica y sanitiza el prompt del usuario antes de cualquier recuperación. Decide si la consulta necesita RAG (referencia al código del proyecto) o va directo al LLM, extrae términos relevantes para búsqueda, detecta la intención del usuario y sugiere dimensiones semánticas preliminares. Todo el procesamiento es determinístico, sin SLM.

## Esquema

```
src/retriever/utilities/mini-agents/
├── agent-intermediary-1.ts    ← Clasificador y sanitizador de entrada
└── README.md
```

## Funciones de la Utilidad

### `AgentIntermediary1`

**Datos de configuración:**

| Parámetro / Constante | Valor |
|-----------------------|-------|
| `RAG_BLOCKLIST` | Prompts que van directo al LLM: `hola`, `gracias`, `adiós`, `explica`, `qué es`, `cómo funciona`, `tutorial` |
| `STOP_WORDS` | ~130 palabras vacías en español e inglés (artículos, preposiciones, verbos comunes, etc.) |
| `INTENT_KEYWORDS` | 5 categorías de intención con keywords asociadas |

**Pipeline de sanitización:**

```
Prompt crudo del usuario
    │
    ▼
[1] ¿Necesita RAG? (#needsRag)
    │  └─ Si el texto contiene SOLO palabras del RAG_BLOCKLIST → LLM_DIRECT
    │  └─ Si contiene símbolos de código (PascalCase, .ts, .js, camelCase, etc.) → RAG
    │  └─ Si contiene keywords de tarea (refactoriza, crea, debug, etc.) → RAG
    │  └─ Si no → LLM_DIRECT
    │
    ├─ (LLM_DIRECT) → Retorna SanitizerOutput con route="LLM_DIRECT", clean_query=texto, confidence=1.0
    │
    ▼ (RAG)
[2] Extraer keywords (#extractKeywords)
    │  └─ Minúsculas + remover puntuación
    │  └─ Tokenizar y filtrar STOP_WORDS
    │  └─ Filtrar tokens de 1 carácter (excepto los de 2 como "db", "id")
    │  └─ Retorna string[] con términos relevantes para código
    │
    ▼
[3] Generar clean_query (#toFts5Query)
    │  └─ Une keywords con " OR " para búsqueda FTS5 flexible
    │  └─ Ej: "hybrid OR strategy" en vez de "hybrid strategy"
    │
    ▼
[4] Generar embedding_input
    │  └─ Keywords unidas con espacio (sin OR) para búsqueda ANN semántica
    │
    ▼
[5] Detectar intent (#detectIntent)
    │  └─ Busca keywords de INTENT_KEYWORDS en el prompt original
    │  └─ Categoría con más coincidencias → intent
    │  └─ Fórmula: confidence = min(coincidencias × 0.25 + 0.4, 0.95)
    │
    ▼
[6] Sugerir dimensiones (#hintDimensions)
    │  └─ Heurísticas rápidas de palabras clave por dimensión
    │  └─ SYS: herencia/implementación → "hereda", "extends", "interface"
    │  └─ CPG: estructura/inyección → "inyecta", "constructor", "new"
    │  └─ DTG: flujo de datos → "dto", "retorna", "payload"
    │  └─ Si ninguna coincide → asume CPG
    │
    ▼
SanitizerOutput
```

**Categorías de intención (`IntentTag`):**

| Intención | Keywords de detección |
|-----------|----------------------|
| `understand` | `qué hace`, `cómo funciona`, `para qué sirve`, `explica`, `entender` |
| `refactor` | `refactoriza`, `renombra`, `extrae`, `simplifica`, `optimiza`, `mueve` |
| `create` | `crea`, `genera`, `añade`, `nuevo`, `implementa`, `escribe` |
| `debug` | `falla`, `error`, `bug`, `por qué no`, `exception`, `trace` |
| `integrate` | `usa la librería`, `integra`, `conecta con`, `llama a` |
| `unknown` | Fallback (ninguna keyword detectada) |

**Fórmula de confianza del intent:**

```
confidence = min(cantidad_keywords_coincidentes × 0.25 + 0.4, 0.95)
```

- Base 0.4 incluso sin coincidencias
- Cada keyword suma 0.25
- Tope en 0.95

**Métodos:**

| Método | Descripción |
|--------|-------------|
| `sanitize(prompt)` | Clasifica el prompt (RAG vs directo), extrae keywords, genera query FTS5 y embedding_input, detecta intent y sugiere dimensiones. Retorna `SanitizerOutput`. |

**Dimensiones sugeridas (`#hintDimensions`):**

| Dimensión | Keywords de activación |
|-----------|----------------------|
| **SYS** (Ecosistema) | `hereda`, `extends`, `implementa`, `interface`, `clase base`, `superclase` |
| **CPG** (Estructura) | `inyecta`, `constructor`, `llama`, `instancia`, `crea`, `new` |
| **DTG** (Flujo datos) | `dto`, `retorna`, `muta`, `status`, `data`, `payload`, `parámetro`, `input`, `output` |
| Default | `CPG` (si ninguna dimensión coincide) |
