# Posicionamiento de novedad — qué es y qué NO es defendible en LaCoCo

> Objetivo: separar lo genuinamente novedoso de lo que es re-implementación de prior art, para no
> sobrevender la tesis y para saber **qué baselines medir**. Honestidad metodológica primero: la
> ausencia de prior art no prueba novedad.

## La contribución defendible: el ranker de consenso estructural

**Qué es.** `consensus-strategy.ts` — un ranker que, sobre un grafo tipado (SYS/CPG/DTG), hace que los
nodos ancla "voten" por sus vecinos ponderando el voto por la dimensión relevante a la intención de la
query (`getIntentWeights`). Es **determinista, sin entrenamiento y sin LLM en el camino caliente**: la
única llamada a modelo es la clasificación de la query (barata, cacheable, fuera del ranking).

**Por qué es defendible.** El diferencial no es "usar un grafo para retrieval" (eso es RepoGraph, Aider,
GraphCoder…), sino **el mecanismo de voto ponderado por dimensión-de-intención, determinista**. La
mayoría de los sistemas grafo-RAG competidores o bien (a) usan centralidad no supervisada agnóstica a
la query (Aider/PageRank), o bien (b) meten un LLM en el ranking (caro, no reproducible). El consenso
ocupa un nicho vacío: *señal estructural condicionada a la intención, a costo cero de inferencia*.

**Evidencia interna a favor** (memoria `consensus-strategy-and-efficiency-reframe`): en el n=8 multi-hop,
`clcr` y `consensus` baten a `hybrid` (+0.125 EditSiteHit, 0.75 vs 0.625); el consenso rescata la tarea
1231 en solitario. El norte declarado es **eficiencia** (calidad por unidad de costo), no SOTA bruto —
y ahí el "sin LLM en el ranking" es precisamente el argumento.

## Lo que NO es novedoso (no venderlo como tal)

- **La tipificación SYS/CPG/DTG.** GraphCoder ya publica el trío CFG+DDG+CDG; el DTG de LaCoCo es
  esencialmente el data-flow de GraphCodeBERT. La taxonomía es una *buena elección de ingeniería*, no
  una contribución teórica. Presentarla como "grafo tri-dimensional novedoso" invita a un rechazo fácil.
- **El anclaje híbrido BM25+ANN con RRF** (`hybrid-anchor-service.ts`). Es el baseline estándar de la
  literatura de retrieval híbrido. La **Mejora B** (sesgo dimensional del pool) sí añade algo, pero es
  una mejora incremental de anclaje, no una tesis.
- **HyDE (C1).** HyDE es prior art (Gao et al. 2022). La adaptación a código es razonable pero conocida
  (varios sistemas ya lo hacen). Venderlo como "canal denso mejorado", no como invención.

## Baselines a medir para aislar el delta del consenso

El experimento honesto no es "consenso vs nada", sino "consenso vs los rankers grafo que ya existen,
con el mismo anclaje y el mismo índice". Tres baselines, todos implementables como una estrategia más en
`registry.ts` + `strategy-names.ts` (hoy 6):

| Baseline | Qué es | Cómo entra | Estado |
|---|---|---|---|
| **RepoGraph** | Ego-graph plano (vecindario a K hops, sin ponderar por dimensión ni por query) | Estrategia nueva `repograph` en el registro; reusa el grafo y el anclaje | Diferido (especificado) |
| **Aider** | PageRank personalizado hacia query-hits (centralidad no condicionada a intención) | = **C3** en `docs/propuestas-innovadoras.md`; construir C3 sirve de baseline | Diferido (= C3) |
| **LARGER** | Prior art más cercano publicado (`arXiv 2605.16352`) | Leer internals antes de afirmar delta; posiblemente no reimplementable 1:1 | Pendiente lectura |

**Criterio de aislamiento.** Todos comparten: mismo índice Jina 768d, mismo anclaje BM25+ANN, mismas 8
tareas svelte multi-hop, misma métrica (EditSiteHit@10 + EditSiteMRR). Lo único que varía es el ranker
de expansión. Si el consenso bate a RepoGraph (grafo sin ponderar) **y** a Aider/PPR (ponderado pero
agnóstico a intención), el delta atribuible es *la ponderación por dimensión-de-intención* — que es la
contribución.

## Nota metodológica (obligatoria antes de escribir "novedoso")

1. **Leer LARGER y CoSIL** (los dos grafo-RAG de código más cercanos) *antes* de afirmar novedad por
   escrito. La ausencia de una cita ≠ prueba de que nadie lo hizo.
2. **RepoGraph y Aider primero.** Si el consenso no bate al PPR de Aider en el n=8, la tesis de
   "ponderación por intención" no se sostiene y hay que reformular hacia eficiencia pura (costo).
3. **Reportar costo, no solo calidad.** El argumento fuerte del consenso es "misma o mejor calidad a
   cero costo de inferencia en el ranking". Toda tabla de calidad debe ir con su columna de latencia/costo
   (`Latency` P95 ya está en `metrics.ts`), o el punto se pierde.

## Resumen de una línea

> La contribución defendible de LaCoCo es un **ranker de consenso estructural determinista ponderado por
> intención→dimensión**; la taxonomía de aristas y el anclaje híbrido son ingeniería sólida pero prior
> art. El experimento que la sostiene es consenso vs RepoGraph vs Aider/PPR sobre el mismo índice,
> reportando calidad **y** costo.
