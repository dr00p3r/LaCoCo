# Baselines del consenso — consensus vs RepoGraph vs Aider/PPR (A/B de retrieval)

**Fecha:** 2026-07-10 · **Rama:** `feat/consensus-baselines` · **Norte:** aislar el delta del ranker
de consenso frente a los rankers de grafo publicados, con el mismo índice y el mismo anclaje.

## Diseño

Dos baselines nuevos, implementados como estrategias más (extienden `AbstractAnchoredStrategy`,
reusan anclaje BM25+ANN+RRF y los helpers de traversal; **ninguna usa `getIntentWeights`** — ese es el
eje que las separa de `consensus`):

- **`repograph`** — ego-graph plano: expande el vecindario K-hop de las anclas y puntúa por pura
  proximidad estructural (decay por salto), sin dirección, dimensión ni intención. Baseline **piso**.
- **`ppr`** — PageRank personalizado (la receta de Aider) sobre el subgrafo inducido, con vector de
  personalización sesgado a las anclas, **agnóstico a la intención** (todas las aristas pesan igual).
  Baseline **fuerte** y el prior art más cercano. Canónico (damping 0.85), determinista.

Se corrieron sobre **dos sets** con índice Jina 768d, sanitizer determinista (baseline), `overfetch=1`:
`mh12` (8 svelte multi-hop, test **discriminante**) y `bench15` (svelte+prettier+mui n=15, check de
**escala/generalización**). Métrica primaria EditSiteHit@10, secundaria EditSiteMRR.

## Resultados

### mh12 — 8 svelte multi-hop (donde el grafo debe ganar)

| estrategia | EditSiteHit@10 | EditSiteMRR |
|---|---:|---:|
| hybrid | 0.625 | 0.441 |
| repograph | **0.750** | 0.463 |
| ppr | **0.750** | **0.241** |
| clcr | 0.750 | 0.463 |
| consensus | 0.750 | 0.464 |

Desglose por tarea (EditSiteHit/EditSiteMRR):

| tarea | hybrid | repograph | ppr | clcr | consensus | nota |
|---|---|---|---|---|---|---|
| svelte-1095 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | duro, nadie |
| svelte-1137 | 1/.33 | 1/.33 | 1/.25 | 1/**1** | 1/.25 | clcr mejor rank |
| svelte-1231 | 0/0 | 0/0 | **1/.25** | 0/0 | **1/.12** | **solo ppr+consensus rescatan** |
| svelte-1376 | 1/1 | 1/1 | 1/.5 | 1/1 | 1/1 | ppr peor rank |
| svelte-1932 | 1/1 | 1/1 | 1/.5 | 1/.33 | 1/1 | |
| svelte-464 | 1/.14 | 1/.12 | **0**/.07 | 1/.12 | **0**/.09 | **ppr+consensus regresionan** |
| svelte-477 | **0**/.05 | 1/.25 | 1/.11 | 1/.25 | 1/.25 | **grafo rescata (hybrid falla)** |
| svelte-630 | 1/1 | 1/1 | 1/.25 | 1/1 | 1/1 | ppr peor rank |

### bench15 — 3 repos × 5 (escala)

| estrategia | EditSiteHit@10 | EditSiteMRR |
|---|---:|---:|
| hybrid | 0.733 | 0.411 |
| repograph | 0.733 | 0.388 |
| ppr | **0.667** | **0.266** |
| clcr | 0.667 | 0.364 |
| consensus | 0.733 | 0.384 |

Por familia (EditSiteHit): svelte 0.80 y mui 0.80 empatan en las 5 estrategias; en **prettier
`ppr`/`clcr` regresionan (0.40 vs 0.60** de hybrid/repograph/consensus).

## Veredicto (honesto)

1. **La expansión de grafo se paga sobre `hybrid`, pero el lever es la expansión, no la ponderación.**
   En mh12 las 4 estrategias de grafo baten a hybrid +0.125 (0.750 vs 0.625) — pero **el baseline PLANO
   `repograph` lo consigue igual**. "Tener grafo / expandir el vecindario" es la palanca; la sofisticación
   del ranker no separa aquí. Caso testigo: svelte-477 lo rescatan las 4 (hybrid falla).

2. **La ponderación por intención de `consensus` NO muestra delta robusto sobre el grafo plano.**
   `consensus ≈ repograph ≈ clcr` en EditSiteHit **y** MRR en ambos sets. No se puede sostener por escrito
   que "la ponderación por dimensión-de-intención" bate al grafo sin ponderar — dato negativo válido,
   consistente con el veredicto previo "el grafo ≈ hybrid a escala / el lever fue el indexado".

3. **El win limpio y REPLICADO de `consensus` es sobre `ppr` (Aider), el prior art más cercano.**
   - mh12: **mismo EditSiteHit (0.750) pero ~1.9× mejor MRR (0.464 vs 0.241)**. Ambos alcanzan el rescate
     multi-hop (svelte-1231, que repograph/clcr NO tocan) y ambos pierden svelte-464 (tensión simétrica),
     pero la centralidad de PPR **entierra** el edit-site bajo hubs de alto grado → MRR pobre task a task
     (0.11–0.5). El consenso mantiene el edit-site arriba (1.0 en los fáciles).
   - bench15: **`consensus` bate a `ppr` en hit (0.733 vs 0.667) Y MRR (0.384 vs 0.266)**, y **no regresiona
     como `ppr`/`clcr`** en prettier. `consensus` es el ranker de grafo **seguro** a escala (nunca cae bajo
     hybrid); `ppr` y `clcr` sí caen.

4. **Lectura para la tesis.** El diferencial defendible no es "grafo con ponderación de intención > grafo
   plano" (no se sostiene), sino **"consenso estructural determinista > centralidad personalizada
   agnóstica a la intención (Aider/PPR)"**: mismo o mejor recall, MRR sustancialmente mejor, sin regresión
   a escala, y a costo cero de inferencia en el ranking. El rescate multi-hop (1231) confirma que la
   propagación estructural alcanza edit-sites que ni el anclaje ni la expansión plana ven.

## Reproducir

```bash
# mh12 (8 svelte multi-hop)
MD=eval/manifests/swe-polybench-mh12 RUN=2026-07-10-baselines-mh12 \
  npm run eval:retrieval -- --run-id $RUN --split retrieval_baselines --manifests-dir $MD
npm run eval:metrics:retrieval -- --run-id $RUN --manifests-dir $MD
# bench15 (3 repos x 5)
MD=eval/manifests/swe-polybench-15 RUN=2026-07-10-baselines-bench15 \
  npm run eval:retrieval -- --run-id $RUN --split retrieval_baselines --manifests-dir $MD
npm run eval:metrics:retrieval -- --run-id $RUN --manifests-dir $MD
```

## Notas de validez

- Índices reusados de `repos-jina/.lacoco` (Jina 768d) sin re-indexar; los 5 prettier se copiaron de
  `indexes-jina/` y corren como "índice legacy" (sin `embedding.json`) → warn, no bloquea. Todas las
  estrategias comparten el MISMO índice por repo, así que la comparación relativa (el objeto del A/B) es
  válida; los absolutos de prettier pueden diferir de reportes históricos por snapshot de índice distinto.
- `retrieval.jsonl` se trunca por invocación → las 5 estrategias corren en UNA invocación por split.
- Gotcha detectado y corregido: el selector de estrategias es la INTERSECCIÓN de
  `phases.retrieval.include_strategies` (run.yaml) con las del split; hubo que añadir `repograph`/`ppr` a
  `include_strategies` además del split, o se filtran en silencio.
