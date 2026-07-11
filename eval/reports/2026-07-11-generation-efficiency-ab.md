# A/B de generación (eje eficiencia) — el retrieval NO se traduce en generación (deepseek-flash, n=8)

**Fecha:** 2026-07-11 · **Run:** `2026-07-10-gen-eff` · **Split:** `generation_eff` · **Modelo:**
`opencode-go/deepseek-v4-flash` (débil), timeout 480s/agente, tope $6 (gasto real ~$0.66 en 48 celdas).

## Diseño

6 estrategias × 8 svelte multi-hop = 48 celdas. `no_context` = agente nativo (opencode con sus
herramientas) = baseline SOTA del agente. Las demás reciben el contexto pre-inyectado de SU retrieval
(baseline). KPI declarado: ΔE2E + ΔCost **condicionado a los casos que PASAN** (el veredicto 3-way ya mostró
ΔPass@1≈0 con modelo *capaz*; aquí se usa un modelo *débil* para probar "contexto como sustituto de capacidad").

## Resultado

| estrategia | Pass@1 | timeouts | dur_mean | costo_total | EditSiteHit (retrieval) |
|---|---:|---:|---:|---:|---:|
| no_context | 0/8 | 4 | 360s | $0.106 | — |
| hybrid | 1/8 | 3 | 358s | $0.107 | 0.625 |
| **repograph** | **3/8** | 2 | 392s | $0.117 | 0.750 |
| ppr | 0/8 | 4 | 382s | $0.106 | 0.750 |
| consensus | 1/8 | 4 | 373s | $0.121 | 0.750 |
| **connector** | **0/8** | 5 | 353s | $0.107 | **0.875** |

Pases por tarea: repograph {1095, 1376, 464}; hybrid {1376}; consensus {1376}; no_context/ppr/connector {}.
**svelte-1376** (única con varios pases): no_context TIMEOUT · hybrid PASS 409s · repograph PASS 388s ·
consensus PASS 281s · connector **TIMEOUT** (pese a retrieval perfecto, gold en rank 1) · ppr fail 29s.

## Veredicto (honesto)

1. **El retrieval NO se traduce en generación aquí — hay INVERSIÓN.** `connector` gana retrieval (0.875)
   pero es de los PEORES en generación (0/8); `repograph` (baseline plano, 0.750 retrieval) lidera
   generación (3/8). En 1376, connector tenía el gold en rank 1 y aun así hizo timeout, mientras consensus
   pasó en 281s. → **la precisión de localización (EditSiteHit) NO predice el éxito de generación** a esta
   escala/modelo.
2. **La señal dominante es RUIDO del modelo débil.** deepseek-flash edita 4-7 archivos/celda (regenera
   lockfiles, cambios anchos), se rinde o hace timeout de forma errática. Con n=8 y 0-3 pases por estrategia,
   no hay potencia para atribuir nada al retrieval.
3. **Único patrón direccional:** el contexto flipea fail→pass con un modelo débil (no_context 0/8 → contexto
   1-3/8) a **costo plano** (~$0.11 todas) — soporta "contexto como sustituto de capacidad", PERO fue el
   contexto **más ancho** (repograph) el que más ayudó, no el más preciso (connector). Hipótesis (no
   confirmable a n=8): para un modelo débil, la **cantidad** de contexto pesa más que la **precisión**.
   Contrasta con el 3-way (modelo *capaz*, deepseek-pro): ahí el contexto no flipeaba, solo aceleraba.
4. **Caso de eficiencia limpio (1376):** el contexto resuelve lo que el agente desnudo no puede (no_context
   timeout → consensus 281s). Es el único punto donde el eje eficiencia se ve, y ahí consensus/hybrid/
   repograph baten a no_context; connector no (timeout).

## Implicación para la tesis

- **El aporte defendible es el RETRIEVAL** (connector 0.875, determinista, bate a RepoGraph/Aider/consensus).
  Se sostiene por sí mismo con su métrica (EditSiteHit).
- **NO se puede afirmar que connector mejora la generación/eficiencia** — los datos lo contradicen. Para un
  veredicto de eficiencia hay que (a) **escalar** (n≫8, potencia), y (b) usar un **modelo capaz** (deepseek-pro
  volvió) para separar señal de ruido; con flash el ruido domina.
- Hallazgo colateral valioso: **retrieval-precision y generation-success están DESACOPLADOS** con un modelo
  débil — refuerza "el cuello de botella es el modelo" y matiza que "más contexto" puede batir a "mejor
  contexto" para modelos débiles. Digno de investigar con más escala.

## Gotchas del arnés

- El entorno MATA procesos largos de background: la generación se detuvo a 22/40 y hubo que `--resume`
  (salta celdas ya grabadas). `generation.jsonl` NO se trunca con `--resume`.
- El panel `phase3-comparison` computa ΔE2E/ΔCost como promedio BRUTO (no condicionado a PASS) → inútil con
  tantos timeouts; el análisis condicionado a PASS se hizo a mano desde `generation.jsonl`.
- Para añadir una estrategia nueva (connector) a un run de generación existente: re-correr su retrieval en el
  mismo `--run-id` (poblar el record de contexto) + `eval:generation --resume`.
