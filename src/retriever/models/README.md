# LaCoCo — Modelos del Retriever

## Propósito

Define los contratos de datos compartidos entre todos los componentes del pipeline RAG. Se separan en dos dominios según su responsabilidad:

- **`strategies/`**: tipos que definen la interfaz de recuperación y la estructura de los resultados devueltos por las estrategias.
- **`utilities/`**: tipos que definen la entrada procesada del usuario y la clasificación de su intención, usados por los utilities de preprocesamiento.

Esta separación evita acoplamientos circulares y mantiene una dependencia unidireccional: `strategies` → `utilities` (nunca al revés).

## Esquema

```
src/retriever/models/
├── strategies/
│   └── types.ts          ← RecoveryStrategy, ContextChunk
├── utilities/
│   └── types.ts          ← IntentTag, SanitizerOutput
└── README.md
```

## Tipos

### `strategies/types.ts`

| Tipo | Propósito |
|------|-----------|
| `ContextChunk` | Fragmento de código recuperado con su score de relevancia y fuente (BM25, ANN, RRF, AGENTIC). Es el formato estándar que toda estrategia debe retornar. |
| `RecoveryStrategy` | Interfaz que deben implementar todas las estrategias de recuperación (BM25, híbrida, agéntica, etc.). Define el contrato `retrieve(query: SanitizerOutput): Promise<ContextChunk[]>`. |

**Por qué separado aquí:** Estos tipos son la interfaz pública del módulo de estrategias. Separarlos de las utilities evita que cambios en el preprocesamiento del prompt afecten el contrato de recuperación.

### `utilities/types.ts`

| Tipo | Propósito |
|------|-----------|
| `IntentTag` | Etiqueta que clasifica la intención del usuario: `understand`, `refactor`, `create`, `debug`, `integrate` o `unknown`. Determina cómo se prioriza el contexto recuperado. |
| `SanitizerOutput` | Salida del Agente Intermediario 1. Contiene la ruta (RAG vs LLM directo), la query limpia para BM25, el texto para embeddings, las dimensiones sugeridas (SYS/CPG/DTG), la intención detectada y el nivel de confianza. |

**Por qué separado aquí:** Son tipos de entrada, producidos por `AgentIntermediary1` y consumidos por las estrategias y el `DimensionalFilter`. Al estar en un dominio separado, las utilities de preprocesamiento no dependen de los tipos de las estrategias.
