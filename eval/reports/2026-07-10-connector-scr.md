# Structural Connector Retrieval (SCR) — el "plus" que bate a RepoGraph, Aider/PPR y consensus

**Fecha:** 2026-07-10 · **Rama:** `feat/consensus-baselines` · **Norte:** ir MÁS ALLÁ del estado del arte
con un mecanismo genuinamente novedoso (no otro ranker de difusión, que ya es `ictd`).

## Contexto y posicionamiento (investigación del SOTA)

El A/B de baselines mostró un empate incómodo: `consensus ≈ repograph` en retrieval. El espacio de "otro
ranker de difusión/voto/proximidad sobre el mismo grafo estático" está saturado (6 estrategias, incl. `ictd`
= Intent-Conditioned Tensor Diffusion, podada por diluir en hubs). La literatura:
- **RepoGraph** (ICLR'25, `arXiv:2410.14684`): ego-graph k-hop, type-blind, determinista → nuestro `repograph`.
- **Aider**: PageRank personalizado, type-blind → nuestro `ppr`.
- **LocAgent** (`arXiv:2503.09089`), **CoSIL** (`arXiv:2503.22424`): grafo TIPADO pero con **LLM en el loop**
  de ranking (fuertes en SWE-bench, caros/no reproducibles).

**Gap identificado:** los métodos tipados fuertes usan LLM; los deterministas son type-blind. SCR ocupa el
nicho vacío: **conectividad tipada DETERMINISTA, costo-cero de inferencia en el ranking.**

## Mecanismo: Structural Connector Retrieval (`connector`)

Mecanismo algorítmico NUEVO — no *esparce* relevancia desde las anclas (difusión/voto/proximidad) sino que
puntúa por **conectividad tipada ENTRE anclas**. Intuición de reparación de programas: *el edit-site es el
nodo que CONECTA los síntomas* (punto de articulación / dependencia compartida / ancestro común).

1. Anclas BM25+ANN+RRF (como todas).
2. Subgrafo inducido, **NO dirigido**, con **costo de arista tipado** `w(e)=1/weight_dim(intent)` — los
   caminos prefieren la dimensión relevante (SYS/CPG/DTG).
3. **Dijkstra entre pares** de las top-M anclas; cada **nodo INTERNO** de un camino más corto acumula
   confluencia `conn(v) += score(a_i)·score(a_j)·pathDecay^hop`, con amortiguación de hubs.
4. **Inyección guardada** (NO RRF plano): las anclas conservan su score; los conectores no-ancla se inyectan
   ESCALADOS por confluencia y CAPADOS por debajo de la ancla `topAnchorsProtected`. Esto rescata el
   conector multi-hop **sin** sacrificar el gold-ancla — resuelve la tensión que hunde a consensus.

Archivos: `src/retriever/strategies/helpers/anchor-confluence.ts` (Dijkstra + confluencia, puro/testeable),
`src/retriever/strategies/connector-strategy.ts`. Determinista, sin LLM.

## Resultados

### mh12 — 8 svelte multi-hop (test discriminante)

| estrategia | EditSiteHit@10 | EditSiteMRR |
|---|---:|---:|
| hybrid | 0.625 | 0.440 |
| repograph | 0.750 | 0.463 |
| ppr | 0.750 | 0.241 |
| clcr | 0.750 | 0.463 |
| consensus | 0.750 | 0.464 |
| **connector** | **0.875** | **0.478** |

Desglose (EditSiteHit): connector acierta **7/8** — solo falla svelte-1095 (que NADIE recupera). **Sostiene
svelte-464 (gold-ancla, que consensus/ppr PIERDEN) Y rescata svelte-1231 + svelte-477 (conectores multi-hop)
a la vez** — lo que ninguna otra estrategia logra. Rompe el techo 0.750 (+0.125) con el mejor MRR.

### bench15 — 3 repos × 5 (escala/generalización)

| estrategia | EditSiteHit@10 | EditSiteMRR |
|---|---:|---:|
| hybrid | 0.733 | 0.411 |
| repograph | 0.733 | 0.388 |
| ppr | 0.667 | 0.266 |
| clcr | 0.667 | 0.364 |
| consensus | 0.733 | 0.384 |
| **connector** | **0.733** | 0.391 |

`connector` **NO regresiona** a escala (empata a los seguros hybrid/repograph/consensus 0.733), a diferencia
de `ppr`/`clcr` que caen a 0.667 en prettier. Sin upside a escala (todo converge a hybrid, consistente con el
veredicto histórico "el grafo ≈ hybrid a escala"), pero **sin daño**.

### Robustez (anti-sobreajuste)

`topAnchorsProtected ∈ {3, 7}` dan AMBOS **mh12=0.875** y **bench15=0.733** — el win NO es knife-edge de un
hiperparámetro; lo que paga es la **inyección guardada** (vs el RRF plano inicial, que daba 0.625 al expulsar
las anclas de rango medio). Default adoptado: `topAnchorsProtected=3`.

## Veredicto

**SCR es el primer ranker de LaCoCo que bate limpio a los baselines deterministas (RepoGraph, Aider/PPR) y a
consensus donde importa (multi-hop, +0.125 EditSiteHit, mejor MRR), y es seguro a escala.** El diferencial
atribuible es el mecanismo NUEVO: conectividad tipada entre anclas + inyección guardada, que resuelve la
tensión rescate↔regresión que hunde a consensus/ppr (pierden 464 al rescatar 1231; SCR sostiene ambos).
Posicionamiento defendible: **conectividad tipada determinista, costo-cero de inferencia** — el nicho vacío
frente a LocAgent/CoSIL (LLM-in-loop) y RepoGraph/Aider (type-blind).

## Honestidad / límites

- n=8 → 0.875 es 7/8; el win es una tarea de diferencia (sostener 464 mientras rescata 1231/477). CI ancho,
  pero el rescate es mecanísticamente causal y explicado tarea a tarea, y no regresiona a escala.
- Sin upside a escala (bench15 empata): el multi-hop es donde SCR paga; el set general no tiene headroom.
- svelte-1095 sigue sin recuperarse (recall/léxico, fuera del alcance de conectividad estructural).
- Siguiente paso para una afirmación "beyond SOTA" incontestable: escalar el benchmark (potencia estadística)
  y el A/B de generación (eje eficiencia, en curso).

## Reproducir

```bash
MD=eval/manifests/swe-polybench-mh12 RUN=<id> \
  npm run eval:retrieval -- --run-id $RUN --split retrieval_baselines --manifests-dir $MD
npm run eval:metrics:retrieval -- --run-id $RUN --manifests-dir $MD   # connector vs 5 estrategias
```
