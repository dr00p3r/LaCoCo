# Smoke SWE-PolyBench — svelte, retrieval M3–M5 (baseline sin grounding)

**Fecha:** 2026-07-07 · **Rama:** `eval/harness-cleanup` · **Run:** `2026-07-07-9d35435-pilot`
**Alcance:** 10 instancias de `sveltejs/svelte` (`is_func_only` + `num_nodes==1`), retrieval
determinista (sin Ollama), baseline **sin** Project Semantic Profile.

## Resultado en una línea

El arnés SWE-PolyBench corre de punta a punta. **9/10 instancias** indexadas y evaluadas;
**9/9 nodos gold existen en el grafo** (gate de validez limpio) → el recall bajo es dificultad
real de retrieval, **no** un bug de mapeo/indexado. Mejor estrategia: **`clcr`, Recall@5 = 0.33**.

## Métricas (macro por tarea, luego macro por repo; 9 instancias × 4 estrategias = 36 ejecuciones)

| Estrategia | M3 Precision@5 | M4 Recall@5 | M5 MRR |
|---|---:|---:|---:|
| **clcr**  | 0.067 | **0.333** | 0.185 |
| hybrid    | 0     | 0     | 0.051 |
| ictd      | 0     | 0     | 0.022 |
| rpr       | 0     | 0     | 0     |
| **global**| 0.017 | 0.083 | 0.065 |

- **M6 (multi-hop):** N/A — el gold SWE-PolyBench no trae `multihop_nodes` (esperado; es el
  diferenciador de LaCoCo y va por anotación aparte).
- **M7 (latencia):** ~2.59 s por consulta (media global).

Instancias con gold en top-5 (por `clcr`): **svelte-510, svelte-906, svelte-1923** (3/9).

## Gate de validez (clave)

Todos los nodos gold traducidos por `swe-polybench-nodes.ts` fueron verificados contra la tabla
`nodes` de cada `tensor.sqlite`:

```
svelte-510..2185: gold 1/1 en grafo   (9 instancias)
svelte-3151:      sin DB (no indexada, ver abajo)
```

El extractor indexa correctamente tanto `.js` (svelte ~2019, p.ej. `EachBlock.js#visitEachBlock`)
como `.ts` (svelte posterior) gracias al tsconfig generado con `allowJs: true` y
`source_roots: [src]`. El guard `detectAllZeroRetrieval()` **no** disparó (recuperación real).

## Instancia caída (best-effort)

**svelte-3151:** `npm install` salió con código 1 en el **postinstall** (`npm run build` del
compilador falla), aunque las dependencias sí se instalaron. Como el prepare no la registró en
el lock, index y retrieval la saltaron (`continue_on_repo_prepare_failure` + `..._task_failure`).
Queda como 1/10 no evaluada, registrada, sin abortar el run.

## Bug encontrado y corregido durante el smoke

`import-swe-polybench.ts` emitía `deterministic_input.intent: "fix"`, pero el sanitizer
determinista (`deterministic-retrieve.ts`) solo acepta `{understand, refactor, create, debug,
integrate, unknown}` → las 4 estrategias fallaban con exit 1. Mapeado a **`debug`** (correcto
para bug-fix). Commit `9d35435`.

## Nota de arnés (gotcha)

El **run-id deriva del short SHA de HEAD** (`2026-07-07-<sha>-pilot`). Commitear en medio del
smoke movió los artefactos de `9c6aaf2-pilot` (de-risk de svelte-510) a `9d35435-pilot` (las 9).
Los repos/índices viven en `eval/workdir/{repos,indexes}-jina/` (compartidos, no por-run), así que
no hubo re-clonado. Para runs limpios: congelar el commit antes de arrancar prepare→metrics.

## Próximos pasos

1. **Delta de grounding (A/B):** construir el Project Semantic Profile y re-medir M3–M5. Aquí
   entra `OLLAMA_NUM_PARALLEL=6` (server) + `grounding.enrich_concurrency: 6` (cliente).
2. **Escalar** a las otras instancias fáciles de svelte y a otros repos (mui/prettier, otros runners).
3. **svelte-3151:** si se quiere recuperar, saltar el postinstall build (install sin scripts) —
   el grafo no lo necesita.
4. **Calidad de retrieval:** `clcr` domina; investigar por qué hybrid/ictd/rpr rankean el gold
   fuera del top-5 en estas queries (problem_statement crudo con diff embebido).
