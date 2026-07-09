# 3-way det/SLM/grounded — veredicto retrieval + agente (svelte 510/728/1923)

**Fecha:** 2026-07-09 · **Agente:** deepseek-v4-pro (timeout 1200s) · **Embeddings:** Jina · **Intermediario:** qwen3:4b
**Runs:** `eval/runs/2026-07-09-retrieval-3way/` (retrieval + pro-SLM), `eval/runs/2026-07-08-svelte-agentic/` (pro-det parcial + qwen-plus baseline respaldados).

Primer 3-way medido de verdad tras arreglar el arnés de generación (ver
`memory/generation-harness-testpatch-gap.md`): antes daba pases falsos (F2P como comando +
nunca aplicaba `test_patch`). Informe visual: artifact "Veredicto 3-way de LaCoCo".

## Carril retrieval — EditSiteHit (¿está el sitio de edición gold en el contexto?)

| Instancia | Determinista | SLM (baseline) | SLM+grounding |
|---|---|---|---|
| svelte-510 | 1.0 | 1.0 | 1.0 |
| svelte-1923 | 1.0 | 1.0 | 1.0 |
| **svelte-728** | **0.0** | **1.0** | **1.0** |

- **Determinista → SLM:** el SLM recupera 728 (EditSiteHit 0→1). Es el value-add real.
- **SLM → grounding:** plano. MRR empate ruidoso (728/clcr 0.25→0.33, 1923/ictd 0.5→0.33). **Grounding no aporta.**
- `ictd` (grafo tensorial) falla 728 (EditSiteHit=0) donde hybrid/clcr plano aciertan.
- Nota: `--use-slm` hace que todas las variantes usen el intermediario; el determinista puro sale del run svelte-agentic. svelte-510 grounded falló (perfil obsoleto) — no crítico (caso fácil).

## Carril agente — Pass@1 con contexto SLM (pro-SLM)

| Instancia | sin contexto | hybrid+SLM | clcr+SLM | ΔPass@1 |
|---|---|---|---|---|
| svelte-510 | PASS (278s) | PASS (91s) | PASS (88s) | 0 · 3× + rápido |
| svelte-1923 | PASS (658s) | PASS (340s) | PASS (345s) | 0 · 2× + rápido |
| svelte-728 | FAIL (541s) | TIMEOUT (1200s) | FAIL (700s) | 0 · no ayuda |

- **ΔPass@1 = 0 en todas las tareas.** El contexto nunca flipea fail→pass.
- **728:** el contexto SLM contiene el sitio gold (EditSiteHit 1.0) y el agente aun así no produce
  un fix correcto (con contexto incluso hace timeout). Cuello de botella = razonar el fix, no el retrieval.
- **510/1923:** el agente ya gana sin contexto → sin headroom para Pass@1; el contexto solo recorta tiempo.
- Capacidad manda: con qwen3.7-plus, 728 y 1923 hacían timeout sin contexto; pro resuelve 1923 solo.

## Veredicto

1. **El grounding no se paga** (retrieval: grounded≡SLM; agente: predeciblemente ≈SLM → brazo omitido).
2. **El contexto no mueve Pass@1**, solo velocidad (ΔE2E 2–3×). La tesis "contexto convierte fallos en éxitos" no se sostiene aquí.
3. **La complejidad del grafo no rinde** (ictd peor que hybrid; rpr/agentic=0 en runs previos).
4. **El benchmark no puede ver el valor del contexto**: no hay instancia "goldilocks" (sin-contexto-falla PERO con-contexto-resuelve).

## Rediseño propuesto

1. Reencuadrar el norte a **ΔE2E (tiempo/coste)**, no Pass@1.
2. **Cortar grounding** del camino crítico (opt-in); reorientar el perfil semántico (p.ej. allow-list anti-alucinación, no probada).
3. **Podar** ictd/rpr/agentic; quedarse con hybrid+clcr.
4. **Conservar** SLM + Jina + query fulltext (las palancas reales).
5. **Rehacer el benchmark** con instancias goldilocks, sin filtro num_nodes==1, +repos/lenguajes, n≥30.
6. Probar **contexto como sustituto de capacidad**: ¿un modelo barato + buen contexto iguala a uno caro? Hipótesis no refutada por estos datos y sin medir.
