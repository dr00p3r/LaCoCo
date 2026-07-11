# Generación GROUNDED + deepseek-v4-pro (13 tareas) — el grounding reduce búsqueda pero NO tiempo/tokens

**Fecha:** 2026-07-11 · **Runs:** `2026-07-11-gen-grounded-pro{,-p2,-p3}` (3 grupos paralelos por repo) ·
**Modelo:** `opencode-go/deepseek-v4-pro` · **Prompt:** grounded ON (`LACOCO_EVAL_GROUNDED_PROMPT=1`) ·
timeout 600s · gasto total **$5.21**.

## Motivación

El A/B con deepseek-**flash** mostró que el contexto NO bajaba tiempo/tokens; la investigación halló la
causa (el agente re-explora aunque tenga contexto: 10-17 greps; y los timeouts dominan el promedio). Hipótesis
del usuario: **(1) restringir al agente a confiar en el contexto** (prompt grounded) + **(2) modelo capaz**
(pro) deberían materializar el ahorro. Este run lo prueba sobre 13 instancias gradeables (5 svelte + 5 prettier
+ 3 mui; mui-13690/13778 excluidas por `flatmap-stream` despublicado de npm).

## Resultado

**Pass@1 (de 13):** no_context 3 · hybrid 3 · **consensus 4** · connector 3. Solo **svelte** pasa; TODAS las
mui y prettier fallan (con o sin contexto). Pasan: svelte-510/906/907 (las 4 estrategias), svelte-1116 (solo
consensus — rescate fail→pass). svelte-728 dura (nadie). Costo plano (~$1.3/estrategia).

**Condicionado a las 3 tareas donde TODAS pasan (510, 906, 907) — comparación justa:**

| estrategia | tiempo medio | **greps medio** |
|---|---:|---:|
| no_context | **203s** | 11.3 |
| hybrid | 240s | 12.7 |
| consensus | 250s | **7.0** |
| connector | 255s | 11.0 |

## Veredicto (honesto)

1. **El grounding FUNCIONA mecánicamente:** `consensus` hace **−38% greps** (7.0 vs 11.3) — el agente
   re-explora menos, confía más en el contexto provisto. La restricción del prompt tuvo el efecto buscado.
2. **Pero NO se traduce en menos tiempo ni tokens:** `no_context` es el MÁS rápido (203s); el contexto es
   igual o más lento en promedio. El 2× de svelte-510 (consensus 76s vs no_context 173s) fue un **outlier**;
   svelte-907 lo compensa al revés (consensus 550s vs no_context 233s). Los greps ahorrados no bajan el
   wall-clock porque **el cuello de botella es razonar el fix, no localizarlo.**
3. **Pass@1 marginal incluso con pro:** consensus +1 (rescata svelte-1116), cost plano. El contexto NO voltea
   fiablemente fail→pass; contrasta con lo esperado de "contexto como sustituto de capacidad".
4. **Los repos duros (mui, prettier) fallan siempre** — limitado por capacidad del modelo, no por retrieval.

## Conclusión del frente de generación (CERRADO)

Incluso con las condiciones correctas (**modelo capaz pro + agente restringido al contexto**), el contexto
**no baja robustamente tiempo/tokens ni voltea fiablemente fail→pass**. El grounding cambia el comportamiento
(menos búsqueda, −38% greps) y ocasionalmente rescata un solve (svelte-1116), pero **la precisión del
retrieval NO se traduce en eficiencia de generación** a esta escala — la capacidad del modelo para razonar
el fix domina. Consistente con el veredicto 3-way (2026-07-09) y con el A/B de flash: el cuello de botella es
el modelo, no el retrieval.

**El aporte defendible de LaCoCo sigue siendo el RETRIEVAL** (connector 0.875 EditSiteHit, bate a
RepoGraph/Aider/consensus, determinista). La generación es un eje ruidoso donde manda la capacidad del modelo.

## Notas operativas / gotchas (nuevos)

- **Paralelización de generación:** debe ser **por REPO, no por celda** — las N estrategias de un mismo repo
  comparten el worktree (`repos-jina/<id>`), y todos los run-ids usan los MISMOS dirs. 3 grupos de repos
  disjuntos (`gen_p1/p2/p3`, run-ids separados) → ~3× wall-clock, sin colisión; se fusionan los 3
  `generation.jsonl` al analizar. Bonus: corridas más cortas resisten mejor el kill del entorno.
- **`reset_excludes` NO debe incluir `.lacoco`:** no está gitignored en los repos eval, y al preservarlo el
  `git add -A` de la captura de diff lo mete en el patch (778 archivos/33MB, rompe los guards). `.lacoco` no
  se necesita en generación (contexto ya en retrieval.jsonl). `reset_excludes=[node_modules]` preserva deps
  para tests sin polucionar el diff. FIX commiteado (5ca2e53→5ca2e53 rama).
- **Installs de repos viejos:** mui/prettier ~2018 necesitan `--legacy-peer-deps`; `flatmap-stream@0.1.0`
  (malware event-stream despublicado) hace irrecuperables mui-13690/13778.
- **Panel `phase3-comparison` inútil aquí** (promedio bruto con muchos timeouts); análisis condicionado a
  PASS hecho a mano.

## Pendiente (no bloqueante)

Brazo de aislamiento `consensus-normal` (pro, flag off) para atribuir el −38% de greps limpiamente al
grounding vs al contexto en sí. Diferido: el headline (el contexto no mejora robustamente la generación) no
cambiaría.
