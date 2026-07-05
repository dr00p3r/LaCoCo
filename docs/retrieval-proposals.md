# LaCoCo: propuestas de retrieval y estado actual

> Estado verificado contra el código el 2026-06-27.
>
> Este documento reemplaza a `DEFERRED.md` y `considerations.md`. El primero
> describía una auditoría ya resuelta y el segundo había quedado desactualizado
> respecto del anclaje híbrido compartido. La fuente de verdad ejecutable sigue
> siendo el código; `AGENTS.md` define el contrato operativo del repositorio.

## Estado ejecutivo

Las tres propuestas multirrelacionales están implementadas y disponibles en la
CLI:

| Propuesta | Nombre CLI | Estado | Dependencias específicas de estrategia |
|---|---|---|---|
| Intent-Conditioned Tensor Diffusion | `ictd` | Implementada | SQLite, LanceDB y embeddings locales |
| Cross-Layer Cascade Retrieval | `clcr` | Implementada | SQLite, LanceDB y embeddings locales |
| Relational Path Retrieval | `rpr` | Implementada | SQLite, LanceDB y embeddings locales |

También están implementadas las estrategias de referencia:

| Estrategia | Papel | Dependencias específicas de estrategia |
|---|---|---|
| `hybrid` | Baseline y estrategia predeterminada | SQLite, LanceDB y embeddings locales |
| `agentic` | Exploración guiada por un SLM local | SQLite y Ollama |

La CLI completa requiere Ollama antes de seleccionar estrategia porque
`AgentIntermediary1` clasifica todas las consultas. La tabla separa únicamente
las dependencias añadidas por el mecanismo interno de cada estrategia.

No quedan elementos pendientes en la antigua auditoría `DEFERRED.md`. Están
resueltos la observabilidad del daemon y de HNSW, la división de los módulos
CLI, la unificación de helpers de estrategias, `LlmClient.abort()`, el acceso a
persistencia mediante DAOs, la validación de filas SQLite, la configuración de
`agent.model`, el `mergeInsert` de embeddings y la extracción única del daemon.

El trabajo pendiente real no es terminar las propuestas, sino validarlas con
evidencia experimental, corregir algunas ambigüedades de scoring y formalizar
operaciones de mantenimiento de LanceDB. El backlog concreto está al final de
este documento.

## Contrato común del pipeline

Las estrategias no reciben el prompt original. Reciben el contrato producido
por `AgentIntermediary1`:

```ts
interface SanitizerOutput {
  route: "RAG" | "LLM_DIRECT";
  clean_query: string;
  embedding_input: string;
  dimensions: ("SYS" | "CPG" | "DTG")[];
  intent: "understand" | "refactor" | "create" | "debug" | "integrate" | "unknown";
  confidence: number;
}
```

El flujo completo es:

```text
prompt
  -> SlmClassifier
  -> si route=LLM_DIRECT: no hay retrieval
  -> si route=RAG: RecoveryStrategy
  -> ContextAggregator
  -> PromptInjector
  -> prompt enriquecido para un agente externo
```

El clasificador usa Ollama con esquema JSON, temperatura cero y semilla fija.
`clean_query` alimenta FTS5 y `embedding_input` alimenta el modelo local
`all-MiniLM-L6-v2`. `Bm25Service` normaliza únicamente la sintaxis FTS5; no
decide términos, keywords ni intención.

Toda estrategia devuelve:

```ts
interface ContextChunk {
  chunkId: string;
  nodeId: string;
  score: number;
  text: string;
  source: string;
  path?: { nodes: string[]; relations: string[]; dimensions: string[] };
}
```

Después del retrieval, `ContextAggregator`:

1. deduplica por `chunkId`, conservando el mayor score;
2. filtra por score mínimo, cuyo valor predeterminado es cero;
3. ordena por score descendente;
4. limita el contexto a una estimación predeterminada de 4000 tokens.

Los límites propios de cada estrategia son máximos previos a la agregación y se
pueden cambiar con `--chunks`. `--max-tokens` controla el presupuesto final;
ninguno garantiza por sí solo el número de chunks inyectados.

## Familia de anclaje híbrido

`hybrid`, `ictd`, `clcr` y `rpr` extienden
`AbstractAnchoredStrategy`. Las cuatro comparten exactamente el mismo mecanismo
de anclaje mediante `HybridAnchorService`:

1. BM25 busca `clean_query` en SQLite/FTS5.
2. `all-MiniLM-L6-v2` genera un embedding de 384 dimensiones a partir de
   `embedding_input`.
3. LanceDB ejecuta ANN sin filtro dimensional.
4. Se fusionan ambos rankings con Reciprocal Rank Fusion.
5. La estrategia concreta recibe las mejores anclas y ejecuta `expand()`.

La fórmula para cada nodo es:

```text
RRF(node) = present_bm25 / (60 + rank_bm25)
          + present_ann  / (60 + rank_ann)
```

`present_bm25` y `present_ann` valen uno cuando el nodo aparece en el ranking
correspondiente y cero en caso contrario. Los scores nativos de BM25 y ANN no se
mezclan directamente; solo importan sus posiciones. Los empates se resuelven
por `nodeId`, lo que hace determinista la fusión para rankings iguales.

Las dimensiones no filtran ANN deliberadamente. En `ictd` y `clcr` intervienen
después, durante la expansión del grafo. `hybrid` y `rpr` no usan las
dimensiones de la consulta para filtrar o ponderar anclas.

## Comparación funcional

| Estrategia | Unidad recuperada | Expansión | Uso de intent/dimensiones | Límite predeterminado |
|---|---|---|---|---:|
| `hybrid` | Nodo | Ninguna | No | 20 anclas |
| `ictd` | Nodo | Difusión bidireccional | Pesos por intent y hints dimensionales | 50 chunks |
| `clcr` | Nodo | Capa dominante y cascada | Selección de dimensión dominante | 50 chunks |
| `rpr` | Camino dirigido | BFS local y DFS | Dimensión de cada relación para scoring | 50 caminos |
| `agentic` | Nodo | Herramientas elegidas por SLM o vecindad determinística | El plan recibe la consulta semántica | Sin límite final estricto |

## Propuesta 1: ICTD

### Objetivo

Intent-Conditioned Tensor Diffusion modela la relevancia como calor que se
propaga por las relaciones SYS, CPG y DTG. Su hipótesis es que una consulta se
beneficia de vecinos estructurales aunque estos no aparezcan bien posicionados
por similitud textual o vectorial.

Implementación: `src/retriever/strategies/ictd-strategy.ts`.

### Algoritmo vigente

1. Recuperar hasta 30 anclas híbridas BM25 + ANN + RRF.
2. Calcular pesos dimensionales desde `intent` y `dimensions`.
3. Construir un subgrafo con BFS bidireccional de hasta dos saltos y 5000 nodos.
4. Inicializar el calor de cada ancla con su score RRF; los demás nodos parten
   de cero.
5. Iterar hasta diez veces:
   - el calor saliente se distribuye por dimensión y se normaliza por el número
     de destinos salientes de esa dimensión;
   - el calor también fluye en sentido inverso y se normaliza por el grado
     entrante del destino en esa dimensión;
   - el 20 % del valor inicial se reinicia en cada iteración;
   - la iteración termina anticipadamente si el cambio máximo es menor que
     `1e-6`.
6. Descartar nodos con calor final menor o igual que `0.001`.
7. Ordenar por calor y devolver hasta 50 chunks con `source="ICTD"`.

### Pesos por intent

| Intent | SYS | CPG | DTG |
|---|---:|---:|---:|
| `debug` | 0.30 | 0.40 | 0.30 |
| `refactor` | 0.40 | 0.40 | 0.20 |
| `create` | 0.50 | 0.30 | 0.20 |
| `integrate` | 0.30 | 0.20 | 0.50 |
| `understand` | 0.35 | 0.35 | 0.30 |
| `unknown` | 0.34 | 0.33 | 0.33 |

Si el intermediario devuelve una o dos dimensiones, sus pesos se multiplican
por 1.5 y luego los tres valores se renormalizan para sumar uno. Si devuelve
cero o las tres dimensiones, se conservan los pesos base.

### Configuración

| Parámetro | Valor | Efecto |
|---|---:|---|
| `anchorLimit` | 30 | Candidatos máximos después de RRF |
| `maxIterations` | 10 | Iteraciones de difusión |
| `restartProb` | 0.20 | Fracción de reinicio hacia el calor inicial |
| `epsilon` | `1e-6` | Umbral de convergencia |
| `chunkLimit` | 50 | Nodos máximos antes de agregación |
| `bfsMaxNodes` | 5000 | Presupuesto de nodos visitados |
| `maxHops` | 2 | Profundidad del subgrafo |

Estos valores pueden cambiarse al construir `IctdStrategy`, pero no están
expuestos como flags CLI ni como configuración persistente.

### Comportamiento límite

| Situación | Resultado vigente |
|---|---|
| BM25 y ANN no devuelven anclas | `[]` |
| Solo uno de los rankings devuelve resultados | RRF usa únicamente ese ranking |
| Anclas sin aristas | El reinicio conserva las anclas con score positivo |
| Se alcanza `bfsMaxNodes` | El recorrido deja de añadir nodos; no emite warning |
| Convergencia antes de diez iteraciones | Salida anticipada |
| Primer uso del modelo de embeddings | Puede requerir descargar el modelo local |

### Fortalezas y costes

- Favorece dependencias multi-hop sin enumerar todos los caminos.
- Hace explícito el efecto del intent y de SYS/CPG/DTG.
- Su scoring no está calibrado contra métricas reales todavía.
- Los hubs pueden redistribuir señal a muchos vecinos y reducir precisión.
- El coste depende del tamaño del subgrafo y del número de iteraciones.

### Decisiones que deben validarse con datos

- Un `restartProb` menor extiende la difusión; uno mayor concentra la señal en
  las anclas. No debe cambiarse el valor 0.20 sin comparar precisión y recall.
- La difusión bidireccional aporta contexto de consumidores y dependencias, pero
  una variante solo `source -> target` podría reducir ruido causal.
- Los pesos por intent son heurísticos. El benchmark puede justificar una tabla
  distinta o demostrar que los hints dimensionales no aportan mejora.
- Aumentar `maxHops` amplía recall y coste de forma no lineal; el valor dos debe
  tratarse como hipótesis, no como propiedad universal de los repositorios.

## Propuesta 2: CLCR

### Objetivo

Cross-Layer Cascade Retrieval prioriza una dimensión dominante y luego busca
puentes hacia las otras capas. Su hipótesis es que la expansión por etapas
recupera contexto transversal con menos ruido que recorrer todas las relaciones
con la misma profundidad.

Implementación: `src/retriever/strategies/clcr-strategy.ts`.

### Algoritmo vigente

1. Recuperar hasta 30 anclas híbridas BM25 + ANN + RRF.
2. Calcular los pesos por intent y elegir la dimensión de mayor peso.
3. Ejecutar un BFS bidireccional de dos saltos usando solo relaciones de la
   dimensión dominante.
4. Propagar un score base por salto: `childScore = parentScore * 0.5`. Por tanto,
   a profundidad `h`, `score = anchorScore * 0.5^h`.
5. Desde todos los nodos de la capa primaria, ejecutar una cascada de un salto
   para cada dimensión no dominante.
6. Asignar a un nodo nuevo de cascada el score de su padre multiplicado por
   `0.7` por cada salto de cascada.
7. Consultar las relaciones incidentes de los candidatos y contar en cuántas
   dimensiones participa cada nodo.
8. Aplicar el boost:

```text
finalScore = baseScore * (1 + lambda * (layerCount - 1))
lambda = 0.25
```

9. Ordenar y devolver hasta 50 chunks con `source="CLCR"`.

### Selección de dimensión dominante

CLCR reutiliza la misma tabla de pesos de ICTD y aplica el mismo boost de 1.5 a
los hints dimensionales. La dimensión dominante es el máximo después de
renormalizar. En empates se conserva el orden canónico SYS, CPG, DTG; por ello
`refactor`, cuyos pesos SYS y CPG son iguales, elige SYS salvo que los hints
cambien el resultado.

### Boost cross-layer

| Capas incidentes | Multiplicador con `lambda=0.25` |
|---:|---:|
| 1 | 1.00 |
| 2 | 1.25 |
| 3 | 1.50 |

El conteo considera relaciones entrantes y salientes mediante
`EdgeDao.getIncidentRelations()`. No se limita a las aristas recorridas durante
la cascada.

### Configuración

| Parámetro | Valor | Efecto |
|---|---:|---|
| `anchorLimit` | 30 | Candidatos máximos después de RRF |
| `primaryHops` | 2 | Profundidad en la dimensión dominante |
| `cascadeHops` | 1 | Profundidad por dimensión secundaria |
| `chunkLimit` | 50 | Nodos máximos antes de agregación |
| `bfsMaxNodes` | 5000 | Presupuesto por cada recorrido BFS |
| `lambda` | 0.25 | Fuerza del boost cross-layer |

`bfsMaxNodes` se aplica a cada BFS por separado. No es hoy un límite global
compartido entre la fase primaria y ambas cascadas. Estos parámetros tampoco se
exponen por CLI.

### Comportamiento límite

| Situación | Resultado vigente |
|---|---|
| BM25 y ANN no devuelven anclas | `[]` |
| La dimensión dominante no tiene aristas | Las anclas siguen en el conjunto primario |
| Una cascada no encuentra aristas | No añade candidatos para esa dimensión |
| Nodo sin relaciones reconocidas | `layerCount=1`, sin boost |
| Un BFS alcanza 5000 nodos | Ese recorrido se trunca sin warning |

### Fortalezas y costes

- La salida sigue siendo nodal y es fácil de agregar e inyectar.
- Hace explícita la búsqueda de puentes entre capas.
- Requiere una consulta adicional de relaciones incidentes para calcular el
  boost.
- El límite de 5000 nodos puede aplicarse tres veces, por lo que el coste máximo
  real supera el que sugería la documentación anterior.
- La fórmula de decaimiento primario necesita una decisión explícita; se detalla
  en el backlog.

### Decisiones que deben validarse con datos

- `lambda=0.25` produce boosts moderados de 1.25 y 1.50. Valores mayores pueden
  sobrerrepresentar hubs; valores menores acercan el ranking al score de ancla.
- Dos saltos primarios y uno de cascada favorecen profundidad en la capa
  dominante. Aumentar la cascada puede mejorar recall cross-layer a costa de
  ruido y más consultas.
- El conteo de capas se calcula en cada consulta. Si aparece como cuello de
  botella, puede materializarse por nodo durante la indexación, siempre que la
  actualización incremental mantenga esa metadata consistente.

## Propuesta 3: RPR

### Objetivo

Relational Path Retrieval cambia la unidad de recuperación: en lugar de devolver
solo nodos, devuelve caminos dirigidos con sus relaciones y dimensiones. Su
hipótesis es que una secuencia como Controller -> Service -> Repository aporta
más información causal que los mismos símbolos aislados.

Implementación: `src/retriever/strategies/rpr-strategy.ts`.

### Algoritmo vigente

1. Recuperar hasta 30 anclas híbridas BM25 + ANN + RRF.
2. Construir un subgrafo con BFS bidireccional de hasta dos saltos y 5000 nodos.
3. Guardar para enumeración únicamente las aristas en su dirección original
   `sourceId -> targetId`.
4. Propagar relevancia a cada nodo descubierto multiplicando el score de su
   padre por `decayPerHop=0.5`.
5. Desde cada ancla, ejecutar DFS sin ciclos y enumerar caminos dirigidos de
   hasta tres aristas.
6. Detener la enumeración al llegar a 5000 candidatos.
7. Puntuar cada camino:

```text
pathScore = average(nodeRelevance) * uniqueDimensions
```

8. Ordenar por score y deduplicar por el `nodeId` terminal, conservando el
   camino de mayor score y contando los caminos alternativos descartados.
9. Aplicar el corte y devolver hasta 50 nodos con su mejor camino y
   `source="RPR"`.

### Scoring

| Dimensiones únicas | Multiplicador |
|---:|---:|
| 1 | 1 |
| 2 | 2 |
| 3 | 3 |

No hay un hiperparámetro para suavizar este boost. La fórmula favorece
deliberadamente caminos que cruzan capas, aunque un camino monocapa tenga mayor
relevancia nodal media.

### Formato del chunk

```text
OrderController.create --CALLS--> PaymentService.process --PRODUCES--> PaymentResult | dims: CPG→DTG | relations: CALLS, PRODUCES
```

`nodeId` se fija actualmente al último nodo del camino. `text` conserva la
secuencia completa, las dimensiones únicas en orden de aparición y las
relaciones únicas. `chunkId` incorpora el hash de nodos y relaciones, y `path`
expone la trayectoria como metadata estructurada.
`diagnostics.duplicateCount` indica cuantos caminos alternativos hacia el mismo
`nodeId` se descartaron antes de aplicar `chunkLimit`.

### Configuración

| Parámetro | Valor | Efecto |
|---|---:|---|
| `anchorLimit` | 30 | Candidatos máximos después de RRF |
| `subgraphMaxHops` | 2 | Profundidad del subgrafo local |
| `bfsMaxNodes` | 5000 | Presupuesto de nodos visitados |
| `maxDepth` | 3 | Aristas máximas por camino |
| `maxCandidates` | 5000 | Caminos máximos antes del ranking |
| `chunkLimit` | 50 | Caminos máximos antes de agregación |
| `decayPerHop` | 0.5 | Decaimiento aplicado a cada descubrimiento |

Los parámetros son configurables por constructor; `--chunks` permite cambiar
`chunkLimit` desde CLI.

### Comportamiento límite

| Situación | Resultado vigente |
|---|---|
| BM25 y ANN no devuelven anclas | `[]` |
| Ninguna ancla tiene caminos salientes | Devuelve las anclas como chunks RPR |
| Un camino volvería a un nodo ya incluido | Se descarta para evitar ciclos |
| Se alcanzan 5000 candidatos | La enumeración termina sin warning |
| Dos enumeraciones producen el mismo camino | Se conserva el de mayor score para el nodo terminal |
| Dos caminos distintos terminan en el mismo nodo | Se conserva el de mayor score y se incrementa `diagnostics.duplicateCount` |

### Fortalezas y costes

- Produce contexto explicable y conserva causalidad direccional.
- Puede capturar dependencias multi-hop de forma explícita.
- DFS puede crecer combinatoriamente en subgrafos densos.
- El multiplicador 1/2/3 aún no está justificado por benchmarks.
- El camino se conserva además como metadata estructurada en el chunk.

### Decisiones que deben validarse con datos

- El boost lineal 1/2/3 puede suavizarse con `ln(1 + uniqueDimensions)` o con
  `1 + lambda * (uniqueDimensions - 1)`, pero añadir `lambda` solo se justifica
  si el scoring actual perjudica precisión.
- La enumeración solo sigue aristas salientes para conservar causalidad. Una
  variante bidireccional multiplicaría candidatos y mezclaría semánticas de
  relaciones dirigidas.
- `maxDepth=3` captura patrones habituales de tres relaciones. Profundidades
  mayores requieren medir primero explosión combinatoria y utilidad marginal.

## Estrategia de referencia: hybrid

`HybridStrategy` devuelve directamente las anclas RRF sin expansión de grafo.
Usa un `anchorLimit` predeterminado de 20 y marca los chunks con `source="RRF"`.
Es la estrategia predeterminada porque establece un baseline fuerte, simple y
de menor coste que las tres propuestas multirrelacionales.

Su función experimental es separar la mejora producida por la expansión del
grafo de la mejora ya obtenida al combinar búsqueda léxica y semántica.

## Estrategia exploratoria: agentic

`AgenticStrategy` no pertenece a la familia de anclaje híbrido:

1. recupera cinco semillas BM25;
2. consulta disponibilidad de Ollama;
3. permite hasta tres decisiones estructuradas entre
   `get_neighbors`, `get_node_by_symbol`, `get_dependencies` y `done`;
4. valida tipos, propiedades permitidas e identificadores de vecindad;
5. falla explícitamente si Ollama no está disponible o incumple el contrato tras
   dos intentos;
6. deduplica nodos, ordena por score y aplica el límite final configurado.

Los scores fijos de herramientas son 0.7 para símbolos, 0.6 para dependencias y
0.5 para vecinos. El límite predeterminado es 50 y puede cambiarse con
`--chunks`; cada herramienta recibe únicamente la capacidad restante.

Esta estrategia se mantiene fuera de la comparación principal del benchmark
porque añade variabilidad del planificador local. Sí es útil como análisis
exploratorio separado.

## Mapa de implementación y pruebas

| Responsabilidad | Fuente principal | Cobertura principal |
|---|---|---|
| Registro, nombres y requisitos | `src/retriever/strategies/registry.ts`, `strategy-names.ts` | `tests/cli/retrieve-cli.test.ts`, `tests/cli/state-store.test.ts` |
| Anclaje híbrido | `src/retriever/utilities/search/hybrid-anchor-service.ts` | `tests/retrieval/hybrid-strategy.test.ts` |
| BM25 y sintaxis FTS5 | `src/retriever/utilities/search/bm25-service.ts` | `tests/retrieval/bm25-service.test.ts` |
| ICTD, CLCR y RPR | `src/retriever/strategies/*-strategy.ts` | `tests/retrieval/tensor-strategies.test.ts` |
| Pesos y BFS | `src/retriever/strategies/helpers/` | `tests/retrieval/strategy-helpers.test.ts` |
| Agentic | `src/retriever/strategies/agentic-strategy.ts` | `tests/retrieval/agentic-strategy.test.ts` |
| Agregación | `src/retriever/utilities/filters/context-aggregator.ts` | `tests/retrieval/context-aggregator.test.ts` |
| Pipeline CLI | `src/cli/pipeline.ts` | `tests/cli/retrieve-cli.test.ts` |

La cobertura actual prueba integración funcional y contratos básicos. No prueba
todavía calidad de ranking sobre un corpus etiquetado ni complejidad en grafos
grandes; esas conclusiones pertenecen al benchmark, no a los tests unitarios.

## Decisiones operativas cerradas

- Los defaults de estrategias son metadata inmutable del registro. El loader de
  manifiestos exige igualdad exacta y el runner contrasta los parámetros
  efectivos devueltos por cada ejecución antes de aceptar el registro.
- CLCR usa decaimiento por salto: 0.5 en la capa primaria y 0.7 en cascada.
- RPR deduplica por nodo terminal antes de `chunkLimit`, conserva el mejor
  camino como `chunkId=RPR:<path-hash>` y reporta alternativas descartadas en
  `diagnostics.duplicateCount`.
- Agentic usa tool calls estructurados, máximo 3 iteraciones, 2 intentos por
  decisión y límite final estricto.
- LanceDB optimiza con umbrales de escrituras, filas modificadas, fragmentos y
  filas sin indexar; conserva siete días de versiones y reporta mantenimiento
  mediante `health()`.

## Backlog vigente

### Alta: completar la validación experimental

El pipeline `eval/` ya define repositorios, tareas, estrategias y métricas M1-M7,
pero no existe aún evidencia oficial comparable:

- las tareas siguen con `gold.status: pending_manual_annotation`;
- la corrida está marcada `official: false`;
- generación y detección de alucinaciones están deshabilitadas;
- falta ejecutar al menos 20 tareas con gold listo para el gate oficial;
- el runner usa `embedding_input` como proxy y todavía no puede inyectar de
  forma determinista `clean_query`, `intent` y `dimensions` por la CLI.

Criterio de cierre: publicar una corrida reproducible con commits fijados,
ground truth manual, M3-M7 para retrieval y, si se evalúa generación, M1-M2.

### Baja: exponer tuning solo después del benchmark

Hoy los hiperparámetros se cambian únicamente por constructor. Añadir flags para
todos ellos antes de medir produciría una superficie CLI amplia sin defaults
justificados.

Criterio de cierre: usar los resultados experimentales para elegir qué
parámetros merecen configuración persistente y mantener el resto como detalles
internos.

## Comandos de verificación

```bash
npm run typecheck
npm test
npm run build
npm run dev -- retrieve --help
npm run dev -- inspect-query --help
```

Para evaluar propuestas, el contrato experimental vive en `eval/README.md` y en
`eval/manifests/`. Sus resultados no deben presentarse como oficiales mientras
las tareas no tengan gold manual y la corrida conserve `official: false`.
