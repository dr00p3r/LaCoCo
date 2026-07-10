# A/B: Anclaje ANN dimensional (Mejora B) + HyDE-code (C1) — svelte n=8 multi-hop

**Fecha:** 2026-07-11 · **Split:** `generation_mh` (swe-polybench-mh12) · **Índice:** Jina 768d
**SLM intermediario:** `qwen3:4b-instruct` (baseline) · **Modelo HyDE:** `qwen2.5-coder:7b`
**Tareas (8):** svelte-464, -477, -630, -1095, -1137, -1231, -1376, -1932
**Métrica primaria:** EditSiteHit@10 · **Secundaria:** EditSiteMRR · determinista (sanitizer congelado).

## Qué se probó

Dos mejoras nuevas del canal denso del anclaje, cada una tras un flag (default neutro → cero regresión):

- **Mejora B — anclaje ANN dimensional** (`LACOCO_ANN_OVERFETCH`): sobre-trae el pool ANN (×3) y aplica
  cuotas por intención→dimensión (`getIntentWeights`) con relleno suave por orden ANN. La fila LanceDB
  ya guardaba `dimension`; el ANN la ignoraba. No es filtro duro: preserva recall cross-dimensión.
- **C1 — HyDE-code** (`LACOCO_HYDE`): el SLM reescribe `embedding_input` como un fragmento TS hipotético
  (el código que arreglaría el bug / lanzaría el error). `clean_query` (BM25) queda intacto.

Cuatro brazos: `base` (off), `dimB` (overfetch=3), `hyde` (HyDE on), `combo` (ambos).

## Resultados (EditSiteHit@10 / EditSiteMRR, macro por tarea, n=8)

| estrategia | base | dimB (overfetch=3) | hyde (7b) | combo |
|---|---|---|---|---|
| hybrid    | 0.625 / 0.441 | 0.625 / 0.444 | **0.750** / 0.305 | 0.750 / 0.305 |
| clcr      | 0.750 / 0.464 | 0.750 / 0.466 | 0.625 / 0.298 | 0.625 / 0.248 |
| consensus | 0.750 / 0.464 | **0.875 / 0.466** | 0.875 / 0.382 | 0.875 / 0.352 |

## Lectura

- **Mejora B es un win limpio.** Sube `consensus` EditSiteHit **0.750 → 0.875 (+0.125)** sin regresar
  hybrid/clcr y con MRR neutro-positivo. Como el retrieval es determinista (sanitizer congelado), el
  único factor que cambia entre `base` y `dimB` es el overfetch → **el delta es causal**, no ruido.
  - Tarea rescatada: **svelte-464** (bug "<:Self> con nombre en minúscula"). El sesgo dimensional metió
    `Component.js#visitComponent` (la lógica de `compile`) en el top-K de consensus.
  - **Config ganadora del estudio: `consensus + overfetch=3` → EditSiteHit 0.875, EditSiteMRR 0.466**
    (mejor hit *y* mejor MRR de las 12 celdas).

- **HyDE (7b) es mixto — honestamente, no un win.** Rescata recall en hybrid (+0.125) y consensus
  (+0.125) pero **regresiona clcr (−0.125) y degrada EditSiteMRR en las tres estrategias** (los
  edit-sites rescatados entran al top-K pero rankean bajo; el snippet desplaza buenos rankings). El
  brazo `combo` confirma que HyDE domina el cambio de candidatos y B no rescata su MRR. Decisión:
  **off por defecto**; HyDE necesita mejor modelo o tuning (p. ej. concatenar snippet+issue, o un
  modelo de nube) para pagar de forma consistente.

- **El snippet HyDE es de buena calidad** (no es el problema el generador, sino el trade-off recall↔MRR).
  Ejemplo (svelte-464): `function compile(componentName){ if(/^[a-z]/.test(componentName)) throw new
  Error('Component names must start with an uppercase letter.'); }` — código plausible y cercano al
  edit-site real.

## Reproducir

```bash
export MD=eval/manifests/swe-polybench-mh12
# base / dimB / hyde / combo — reusan índice de indexes-jina copiado al worktree
LACOCO_ANN_OVERFETCH=1 LACOCO_HYDE=0 npm run eval:retrieval -- --run-id <id> --split generation_mh --sanitizer-variant baseline --manifests-dir $MD
LACOCO_ANN_OVERFETCH=3 LACOCO_HYDE=0 ...   # dimB
LACOCO_ANN_OVERFETCH=1 LACOCO_HYDE=1 LACOCO_HYDE_MODEL=qwen2.5-coder:7b ...   # hyde
npm run eval:metrics:retrieval -- --run-id <id> --manifests-dir $MD
```

## Anexo A — Bonus: HyDE modo `concat` (hipótesis refutada)

Se probó una variante `LACOCO_HYDE_MODE=concat` que embebe `snippet + "\n\n" + issue` (en vez de solo el
snippet), apostando a preservar el recall de HyDE sin degradar el MRR.

| estrategia | EditSiteHit base/replace/concat | EditSiteMRR base/replace/concat |
|---|---|---|
| hybrid    | 0.625 / 0.750 / 0.750 | 0.441 / 0.305 / 0.239 |
| clcr      | 0.750 / 0.625 / 0.625 | 0.464 / 0.298 / 0.305 |
| consensus | 0.750 / 0.875 / 0.750 | 0.464 / 0.382 / 0.386 |

**Refutada:** concat perdió la ganancia de recall de consensus (0.875 → 0.750) y no arregló el MRR
(hybrid incluso peor). Diluir el snippet con el texto del issue debilita la señal HyDE sin compensar.
`replace` sigue siendo la mejor variante HyDE; el camino para rescatar el MRR es otro (mejor modelo o
un re-ranking post-hoc de los edit-sites rescatados).

## Anexo B — A/B de generación (deepseek-v4-flash, la nube volvió)

La nube `opencode-go` salió de mantenimiento durante la sesión (deepseek-v4-flash responde). Se corrió
generación real no_context vs consensus (contexto del run dimB) sobre las 8 tareas. Pass@1 reconstruido
de los `tests.log` por celda (costo total ~$0.25).

| tarea | no_context | consensus | nota |
|---|---|---|---|
| svelte-1095 | PASS | PASS | fácil, ambos |
| svelte-1376 | fail | **PASS** | mismo archivo `EventHandler.ts`; consensus arregla, no_context no |
| svelte-1932 | PASS | timeout | +contexto empuja a deepseek más allá de 600s (repo 987 nodos) |
| 464/477/630 | fail | fail | ninguno resuelve |
| 1137/1231 | timeout | timeout | el agente edita 30+ archivos y se descontrola |

- Global 2/8 vs 2/8 (empate); en las 5 tareas gradeable-limpias en ambos: **consensus 2/5 vs no_context 1/5**.
- **(1)** El contexto mejora la *calidad del fix* (svelte-1376). **(2)** El contexto tiene *costo de
  latencia*: en el repo grande empujó al agente al timeout → tensión calidad↔latencia (norte=eficiencia).
  **(3)** deepseek a veces regenera lockfiles / edita 30+ archivos pese al prompt (ruido del agente).
- n=8 con 2 timeouts → direccional, no concluyente. Escalable ahora que la nube responde (subir timeout
  a 1200s para tareas grandes; reintentar los timeouts).

## Notas metodológicas

- Determinismo: sanitizer congelado por brazo; ANN determinista → deltas atribuibles a los flags.
- Latencia entre brazos NO es comparable (runs separados, carga del sistema variable); no se reporta como
  señal. Para latencia usar el panel de repeticiones dentro de un mismo run.
- n=8 es pequeño: los CI bootstrap son anchos (p. ej. EditSiteHit 0.875 CI ~[0.5, 1]). El delta de B es
  consistente con el veredicto histórico "el grafo se paga" y lo empuja más allá del 0.75.
