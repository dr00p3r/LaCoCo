# A/B de semantic-profile-grounding sobre Jina (zod)

Fecha del análisis: 2026-07-07. Run: `2026-07-07-grounding-ab-zod`.

Mide el efecto del **semantic-profile-grounding** en la recuperación sin generación
(M3–M7), aislándolo como **única variable** sobre una misma línea base Jina. El
grounding ancla la query saneada a términos que existen en el proyecto (vía el
Project Semantic Profile) antes de pasarla al retriever.

## Diseño y metodología

- **Repo/tareas:** zod, 2 tareas (`zod-001`, `zod-002`), commit `7baee4e17`.
- **Estrategias:** `hybrid`, `ictd`, `clcr`, `rpr`. → **8 celdas por brazo**, 16 en total.
- **Brazos** (`split semantic_profile_ab`): `baseline` (sanitizer SLM sin grounding)
  vs `grounded` (sanitizer SLM con candidatos del grounder inyectados).
- **Embeddings:** `jinaai/jina-embeddings-v2-base-code` (768d, fp32), árbol
  `repos-jina/` + `indexes-jina/`.
- **Sanitizer intermediario:** `qwen2.5-coder:1.5b`, congelado una vez por
  (tarea, brazo). *No es* el modelo del perfil (ver siguiente punto).
- **Project Semantic Profile:** build `d8423ade`, `ready`, construido con
  `qwen2.5:7b-instruct` — 1011 términos, 4702 alias, 18 dominios. El **grounder es
  determinista** (match exacto de alias + FTS5 sobre el perfil); el 7B solo
  construyó el perfil, no interviene en la query en tiempo de A/B.
- **Agregación:** `macro_by_task_then_repo`. 0 celdas excluidas.

**Validez del brazo grounded — verificada por artefacto.** El grounding disparó en
las 8 celdas grounded: `_sanitizer/grounded.json` registra `profileBuildId=d8423ade`
y **20 candidatos** por celda (dominios `validation`/`business-logic`/`api` en
zod-001, `configuration`/`testing`/`validation` en zod-002); las 8 celdas baseline
registran 0 candidatos / `profileBuildId=null`. El anclaje es visible en la query:

| tarea | brazo | `clean_query` |
|---|---|---|
| zod-001 | baseline | `"trim" OR "string validation" OR "helper function" OR "API consistency"` |
| zod-001 | **grounded** | `"trim" OR "apply" OR "helper que rechace cadenas vacias" OR "INVALID"` |
| zod-002 | baseline | `"strict" OR "configuracion strict" OR "derivada parcial" OR "schema" OR ...` |
| zod-002 | **grounded** | `"strict" OR "compatibilidad" OR "pruebas existentes"` |

En zod-001 el grounded incorpora `apply` e `INVALID` — términos que existen en los
candidatos del grounder (`typescript::apply`/alias «aplicar», `INVALID` de
`parseUtil.ts`) y **no** en el baseline. El delta grounded↔baseline es, por tanto,
un efecto de grounding, no de estocasticidad del SLM.

> **Nota de trazabilidad (hueco de registro, no de validez).** `retrieval.jsonl`
> guarda `grounding=null` en los brazos grounded: el campo que ahí se persiste
> proviene del subproceso de retrieval (que no hace grounding), no del proceso
> padre. El registro autoritativo del grounding es `_sanitizer/<brazo>.json`.
> Persistir el grounding del padre en `retrieval.jsonl` queda como mejora de
> trazabilidad (no afecta este veredicto).

## Resultado — grounded vs baseline (por estrategia, macro sobre 2 tareas)

| Estrategia | Métrica | baseline | grounded | Δ |
|---|---|---:|---:|---:|
| `ictd`   | M5 MRR              | 0.750 | **1.000** | **+0.250** |
| `ictd`   | M6 Multi-hop Rec@20 | 0.125 | **0.375** | **+0.250** |
| `hybrid` | M6 Multi-hop Rec@20 | 0.250 | **0.375** | **+0.125** |
| `hybrid` | M5 MRR              | 0.750 | 0.750 | 0 |
| `clcr`   | M5 / M6             | 1.000 / 0.125 | 1.000 / 0.125 | 0 / 0 |
| `rpr`    | M5 / M6             | 0 / 0 | 0 / 0 | 0 / 0 |

**M3 (P@5) y M4 (R@5) quedan planos en todas las estrategias** (p. ej. `ictd`/`hybrid`
0.600/0.286 en ambos brazos; `clcr` M4 0.2409→0.2364, ruido). El grounding **no
cambia cuántos relevantes entran al top-5**, sino **cómo se ordenan** (MRR) y la
**cobertura de dependencias multi-hop** (M6).

### Agregado (macro sobre las 4 estrategias)

| Métrica | baseline | grounded | Δ |
|---|---:|---:|---:|
| M3 Precision@5 | 0.425 | 0.425 | 0 |
| M4 Recall@5 | 0.203 | 0.202 | ≈0 |
| M5 MRR | 0.625 | 0.688 | **+0.063** |
| M6 Multi-hop Recall@20 | 0.125 | 0.219 | **+0.094** |
| M7 latencia observada (ms) | 5094.8 | 6747.5 | **+1652.8** (+32%) |

Restringido a las **3 estrategias con señal** (excluye `rpr`, que parte de piso 0
en ambos brazos): **M5 +0.083** y **M6 +0.125** de media.

## Veredicto

Sobre zod (2 tareas, 8 celdas por brazo), el semantic-profile-grounding **recupera
profundidad de ranking**:

- **MRR (M5) y multi-hop (M6) suben** — con mayor efecto en `ictd` (M5 0.75→1.0,
  M6 0.125→0.375) y ganancia de M6 también en `hybrid`. `clcr` y `rpr` quedan planos.
- **Precisión temprana (M3/M4) sin cambio** — el grounding reordena y amplía
  cobertura de dependencias, no aumenta el recall bruto en top-5.
- **Costo: +~1.65 s de latencia observada** (+32%) por el paso de grounding +
  el prompt de sanitizer más grande.

Esto es coherente con la hipótesis del piloto M3–M6 (`2026-07-06-m3-m6-retrieval-consolidado.md`):
el grounding preserva/mejora la ganancia multi-hop atacando la degradación léxica
del SLM, sin sacrificar precisión temprana.

## Limitaciones

1. **Alcance mínimo: 1 repo, 2 tareas.** Los deltas son descriptivos; sin prueba de
   significancia. Falta replicar en rxjs/inversify para generalizar.
2. **M7 no es P95 formal** (sin warmup/repeticiones de `metrics.yaml`); es latencia
   observada por celda. Incluye el costo del sanitizer SLM en ambos brazos.
3. **Sanitizer = `qwen2.5-coder:1.5b`.** Con este modelo el brazo grounded produjo
   JSON válido pese al prompt agrandado; no se probó si un intermediario mayor
   cambiaría el anclaje. El modelo del intermediario **no está registrado por-run**
   (se infiere de la config efectiva) — lo cubre la Fase 2 del plan de limpieza.
4. `rpr` no participa del veredicto (piso 0 en ambos brazos, problema de la
   estrategia, no del grounding).
