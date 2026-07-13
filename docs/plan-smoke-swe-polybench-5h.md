# Plan cerrado — Smoke SWE-PolyBench en <5h (retrieval M3–M5)

> Documento historico de planificacion del 2026-07-07. Para comandos vigentes de
> LaCoCo usa `README.md`, `AGENTS.md`, `docs/cli.md` y `eval/RUNBOOK.md`.
> Las menciones a `npm install` en este archivo se refieren a instalar
> dependencias de repositorios benchmark en sus commits, no al gestor del
> repositorio LaCoCo.

**Fecha:** 2026-07-07 · **Meta del usuario:** poder *probar ya* con un subconjunto
reducido (30–50 instancias, empezar con ~10), en un máximo de **5 horas de trabajo
conjunto**, sin dejar puntos abiertos y sin hacer trabajo desactualizado.

**Decisiones del usuario (2026-07-07):** indexar **con `npm install` por commit**
(grafo con edges de tipos resueltos) · repo de arranque **svelte** · **cerrar Fase 1
del cleanup ANTES del smoke** · **incluir Fases 2–5 del cleanup** en el trabajo de hoy.

> **Orden macro:** primero se cierra el cleanup del harness (rama `eval/harness-cleanup`,
> Fases 1–5), luego el smoke SWE-PolyBench. Motivo: el smoke usa `compute-retrieval-metrics.ts`
> en su Pieza D, y el guard `detectAllZeroRetrieval` de la Fase 1 es la red de seguridad
> que distingue "mala recuperación" de "bug de mapeo del traductor de node-ids".

---

## 🔖 PARA RETOMAR (fin de sesión 2026-07-07)

**Hecho hoy:** Cleanup Fases 0–3 **cerradas y commiteadas** en `eval/harness-cleanup`
(`fa81150` → `309185b` → `1230dd3` → `fbf8db2`). typecheck + 106/106 tests del eval verdes.

**Siguiente acción en sesión fresca (en orden):**
1. *(opcional, higiene)* Fases 4–5 del cleanup — ver abajo. No bloquean el smoke.
2. **Arrancar el smoke SWE-PolyBench: Pieza A (loader).** Ver §2. Genera
   `tasks.swe-polybench.yaml` con ~10 instancias de svelte. Todo lo previo (dataset
   completo, 2 traductores, árbol Jina canónico, guards de invalidez) ya está listo.

**Contexto que ya NO hay que rehacer:** dataset HF completo bajado; traductores
`swe-polybench-nodes.ts`/`swe-polybench-test-command.ts` hechos; árbol Jina es el
canónico (`paths` en run.yaml + projects.json podado); assert de embedding activo.

⚠ **Nota de validez del smoke:** al indexar svelte con `eval:index`, el índice cae en
`indexes-jina/` y `run-retrieval` verificará el `embedding.json`. Si sale el warn
"índice legacy" es porque el índice se construyó antes de Fase 2 → reindexar.

---

## CLEANUP DEL HARNESS (rama `eval/harness-cleanup`) — va PRIMERO

Estado: rama `eval/harness-cleanup`. **Fases 0–3 COMPLETAS y commiteadas** (2026-07-07).
Quedan Fases 4–5 (higiene, no bloquean el smoke).

### ✅ Fase 0 — Fixes de invalidez silenciosa + reporte A/B zod — COMMIT `fa81150`
3 fixes (repoPath del lock, `resolveIntermediaryModel()`, `--full`) + reporte `2026-07-07-grounding-ab-zod.md`.

### ✅ Fase 1 — Guard de invalidez silenciosa — COMMIT `309185b`
- `detectAllZeroRetrieval()` + `--strict` + lock desde `run.runDirectory` (ya estaban; se cerró el test + commit).
- **Test de regresión escrito** en `compute-retrieval-metrics.test.ts`: caso de prefijo (gold relativo resuelto
  contra `repoPath` del lock → M3 > 0) + 4 unit tests del guard. typecheck OK, **6/6 verdes**.

### ✅ Fase 2 — Perfil de embedding por-run (mata env juggling) — COMMIT `1230dd3`
- Bloque `embedding: {model, dim, quantized}` (Jina) en `run.yaml` = fuente de verdad única.
- Nueva lib `eval/scripts/lib/embedding-profile.ts` (+test, **9/9 verdes**): `resolveEmbeddingProfile()`,
  `applyEmbeddingEnv()` (setea `LACOCO_EMBEDDING_*` → subprocesos lo heredan), write/read/`checkEmbeddingConsistency`.
- `index-repos.ts`: aplica env al subproceso `index_vectors` + escribe `embedding.json` junto al índice.
- `run-retrieval.ts`: aplica env al subproceso de retrieval; metadata del run desde el perfil (no constantes
  congeladas); **ABORTA si el índice (resolveDbPath) se construyó con otro modelo/dim** (ausente = warn, legacy).
- 106/106 tests del eval verdes.

### ✅ Fase 3 — Single-tree Jina — COMMIT `fbf8db2`
- `run.yaml` `paths.repos/indexes` → árbol Jina (`repos-jina/`+`indexes-jina/`) como ÚNICO activo. Esto hace que
  `eval:index` construya en `indexes-jina/` y **vuelve estricto el assert de Fase 2** (el índice que abre el
  retrieval = donde `index-repos` escribe `embedding.json`).
- **Paso manual FUERA del repo (hecho):** podados los 3 registros MiniLM de
  `~/.local/state/lacoco/projects.json` (backup en `projects.json.bak-2026-07-07-fase3`). Quedan 3 Jina.
- `repos/`+`indexes/` (MiniLM) = histórico. Runs MiniLM viejos NO recomputables (métricas congeladas, se
  resuelven contra el repoPath de su lock por el fix de Fase 0). 106/106 tests verdes.

### ⏳ Fase 4 — Cortar cruft (PENDIENTE, higiene) · ~20 min
- Borrar/archivar scratch de M1/M2: `eval/runs/_analyze_gen.py`, `_gen-m1-m2-driver.sh`, `_gen-m1-m2-logs*`.
- Revisar 1-a-1: `normalize-node-ids.ts` (migración one-shot ya aplicada; **referencia el árbol `repos/` viejo**
  — candidato claro a archivar), `compare-strategies.ts` (sin npm), `embedding-jina-index.ts` (si construyó el
  índice Jina y es reproducible-necesario → conservar + npm script). ⚠ `deterministic-retrieve.ts` **NO es cruft**.

### ⏳ Fase 5 — Nota "gold interino" en `tasks.yaml` (PENDIENTE) · ~5 min
- Comentario: gold manual (20 tareas) = interino para A/B + baseline M3–M6; SWE-PolyBench lo reemplaza. **No borrar.**

**Estado cleanup: Fases 0–3 cerradas. Fases 4–5 son higiene y pueden hacerse en la sesión del smoke o después.**

---

## 0. Por qué el "~40h" ya no aplica (contexto)

El "~40h" nunca estuvo escrito en el repo — era el costo del **smoke de GENERACIÓN
(M1/M2)**: clonar + `npm install` por `base_commit`, traducir el `test_command` de
Docker→local (nvm/custom-reporter), verificar F2P rojo, correr el agente con Ollama
(cuello serial) y correr los tests. Esa cola es real, pero **no es lo que necesitas
para "probar ya"**. Dos hechos la colapsan:

1. **El bloqueo del loader desapareció.** `eval/data/swe-polybench/instances.tsjs.full.jsonl`
   (bajado 2026-07-07 07:46) **ya trae `problem_statement` + `patch` + `test_patch`**
   (verificado). El paso "bajar HF" del plan viejo está **CUMPLIDO**.
2. **Los 2 traductores ya existen y están testeados** (typecheck OK, tests verdes):
   - `eval/scripts/lib/swe-polybench-nodes.ts` — `modified_nodes`→node-id (91.8%).
   - `eval/scripts/lib/swe-polybench-test-command.ts` — parser de los 200.

**El atajo:** el smoke de **RETRIEVAL (M3–M5)** deriva el gold del `modified_nodes`
(ya traducido) y usa `problem_statement` como query. **No corre tests, no usa Ollama
para generar.** Es lo que cabe en 5h y ya te da una señal citable de localización.

---

## 1. PUNTOS QUE SE CIERRAN (no hacer — desactualizados o fuera de alcance)

| # | Punto del plan viejo | Estado | Motivo |
|---|---|---|---|
| C1 | "Bajar el parquet de HF / texto completo" | ✅ **HECHO** | `instances.tsjs.full.jsonl` ya tiene los 3 campos de texto. |
| C2 | `gold-patch-nodes.ts` (parsear diff→AST para M3–M5) | ❌ **NO HACER** | SWE-PolyBench ya publica `modified_nodes` (CST) y el traductor `swe-polybench-nodes.ts` ya lo consume. Reparsear el diff es trabajo duplicado. |
| C3 | Traductor `test_command`→local (nvm/custom-reporter) | ⏸ **APLAZAR** | Solo se necesita para GENERACIÓN (correr tests). El smoke de retrieval no corre tests. Ya está escrito de todos modos. |
| C4 | Harness de regresión manual (`eval/manifests/regression/`, `broken_patch`, `applyBrokenPatch`/`verifyBrokenState`) | ❌ **NO USAR** en el flujo SWE-PolyBench | El estado roto viene del `base_commit`, no de diffs a mano. **No borrar todavía** (Frente A grounding aún lo referencia); solo no ramificar sobre él. |
| C5 | A/B de grounding sobre zod/rxjs/inversify (Frente A) | ⏸ **SEPARADO** | Es otro objetivo (¿grounding mejora retrieval?). No bloquea "probar SWE-PolyBench". Se retoma después del smoke. |
| C6 | M6 multi-hop manual | ⏸ **FUERA DEL SMOKE** | Requiere anotación manual sobre el grafo. Es el diferenciador, pero va después de que M3–M5 corra. |
| C7 | Generación M1/M2 (agente + Ollama + tests verdes) | ⏸ **FASE 2** | Es el "~40h". No entra en las 5h. |

---

## 2. LO QUE SÍ SE HACE — smoke de retrieval en svelte (<5h)

**Alcance:** 1 repo (svelte), ~10 instancias `is_func_only` + `num_nodes==1`,
escalar a 30 dentro de svelte si sobra tiempo. Todas Node 16.20.2 (un solo `nvm use`).
⚠ **Dato de riesgo:** las 24 instancias fáciles de svelte tienen **23 `base_commit`
distintos** → "con install" ≈ un `npm install` por instancia sobre svelte ~2019.
Mitigación: install best-effort con timeout; si un commit no instala, **se marca y se
sigue** (el grafo estructural se construye igual; solo se degradan edges de tipos).

### Pieza A — Loader instance-centric (nuevo) · ~60–90 min
`eval/scripts/import-swe-polybench.ts`:
- Lee `instances.tsjs.full.jsonl`, filtra `repo == sveltejs/svelte` + `is_func_only`
  + `num_nodes==1` + `!is_no_nodes`, toma las primeras N (default 10, `--limit`).
- Por instancia emite una `TaskDefinition` + bloque `regression`:
  - `prompt` / `deterministic_input.retrieval_input.query` ← `problem_statement`.
  - `gold.relevant_nodes` ← `translateModifiedNodes(...)` (traductor existente).
  - `regression.base_commit` ← `base_commit`; `target_tests` ← `F2P` parseado.
  - `repo_id` ← `svelte-<instance_short>` (instance-centric: id único por commit).
- Escribe `eval/manifests/tasks.swe-polybench.yaml` + entradas de repo (una por
  `base_commit`) en un `repos.swe-polybench.yaml` (o extiende el lock existente).
- **Validación incluida:** loguea cuántos `relevant_nodes` quedaron `unmapped`
  (esperado: los orphan_method de serverless no aplican a svelte → ~0).

### Pieza B — Clonar + checkout + install por instancia · ~90–120 min (mayormente espera)
Reusar `prepare-repos.ts`, adaptación mínima:
- `ref = base_commit` (ya soporta `--detach` checkout; línea 147).
- **`npm install` con timeout** (900s ya está en `repos.yaml`); on-fail → marcar
  `install: failed`, continuar (no abortar el run — `continue_on_repo_prepare_failure`
  ya existe en run.yaml:270).
- **NO** aplicar `applyBrokenPatch` (el `base_commit` ya es el estado a indexar).
- **NO** aplicar `test_patch` en el smoke de retrieval (solo haría falta para F2P rojo
  en generación).
- Clone shallow por commit: svelte es mediano; con 10 commits distintos, prever disco.

### Pieza C — Indexar el `base_commit` · ~60 min (mayormente espera)
Reusar `index-repos.ts` (`index_graph` + `index_vectors`). Indexa el estado
**pre-fix** (correcto para validez de retrieval). El extractor es AST/ts-morph
(`getType()` resuelve edges con deps presentes → por eso elegiste install).

### Pieza D — Retrieval + métricas M3–M5 · ~30 min
- `eval:retrieve:deterministic` (sin Ollama) o `eval:retrieval` con query =
  `problem_statement`, sobre `tasks.swe-polybench.yaml`.
- `eval:metrics:retrieval` → File Retrieval + Node Retrieval Rec/Prec (comparable con
  la tabla publicada de SWE-PolyBench).
- **Gate de validez del smoke:** para ≥1 instancia, verificar a mano que los
  `relevant_nodes` traducidos **existen en `tensor.sqlite`** (tabla `nodes`). Si el
  recall es 0 en todas, es bug de mapeo, no de retrieval — parar y depurar el traductor.

### Pieza E — Reporte · ~20 min
`eval/reports/2026-07-07-swe-polybench-svelte-smoke.md`: N instancias, % nodos
mapeados/encontrados en el grafo, M3–M5, y lista de instancias con install fallido.

---

## 3. Presupuesto de tiempo (realista, con cleanup + install)

| Bloque | Trabajo activo (yo) | Espera (máquina) |
|---|---|---|
| **Cleanup Fase 1** (test + commit) | 30–40 min | — |
| **Cleanup Fases 2–5** | 85–105 min | — |
| A. Loader | 60–90 min | — |
| B. Clone+install ×10 | 20 min setup | 60–90 min install |
| C. Indexar ×10 | 15 min | 45–60 min |
| D. Retrieval+métricas | 20 min | 10 min |
| E. Reporte | 20 min | — |
| **Total** | **~4.5–5.5h activo** | **~2–2.5h espera (solapable con el activo)** |

⚠ **Honestidad sobre las 5h:** con el cleanup (Fases 1–5) DENTRO del alcance, el trabajo
activo llega al borde de las 5h **antes** de terminar el smoke. Dos salidas realistas:
- **Opción realista:** hoy cerramos **cleanup + Piezas A–C** (loader + repos indexados);
  las Piezas D–E (retrieval + reporte) caen a primera hora de la siguiente sesión. El
  smoke queda *armado y listo para disparar*, que es el 90% del riesgo eliminado.
- **Opción "probar hoy sí o sí":** reducir Fases 2–5 a lo mínimo (Fase 1 + Fase 5, que
  son baratas) y aplazar Fases 2–4 (env juggling, single-tree, cruft) — así el smoke
  M3–M5 termina hoy. Requiere tu OK para recortar el cleanup.

El install de svelte ~2019 es el otro riesgo de tiempo. Fallback: install best-effort con
timeout; si >3 de 10 fallan, el smoke sale con N menor y **queda todo registrado** —
ningún punto a medias.

---

## 4. Orden de ejecución (checklist)

1. [ ] **Confirmar dataset y traductores** (ya verificado hoy) — 0 min.
2. [ ] **Pieza A: loader** → generar `tasks.swe-polybench.yaml` con 10 instancias svelte.
3. [ ] **Revisar 1 tarea a mano**: query razonable, `relevant_nodes` no vacío.
4. [ ] **Pieza B: prepare** 10 instancias (clone+checkout+install, best-effort).
5. [ ] **Pieza C: index** las que instalaron (o todas, install-independiente si toca).
6. [ ] **Gate de validez**: node-ids del gold existen en `tensor.sqlite` (≥1 instancia).
7. [ ] **Pieza D: retrieval + métricas M3–M5.**
8. [ ] **Pieza E: reporte.**
9. [ ] **Si sobra tiempo:** escalar 10→30 dentro de svelte (mismo flujo, `--limit 30`).

## 5. Después del smoke (fuera de las 5h, para no perderlo de vista)
- Generación M1/M2 (necesita traductor `test_command` [ya hecho] + F2P rojo + Ollama).
- M6 multi-hop manual sobre subconjunto.
- Escalar a mui/prettier (otros runners).
- Retomar A/B grounding (Frente A).
