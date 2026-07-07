# Plan de handoff — próxima sesión (Jina grounding + SWE-PolyBench)

**Fecha:** 2026-07-06 · **Encargado:** Claude (yo, en próxima sesión) · **Estado sesión actual:** contexto al 100%, se corta aquí.

Contexto rápido: el reporte consolidado M3–M6 está entregado y citable
(`eval/reports/2026-07-06-m3-m6-retrieval-consolidado.md`). El piloto de
generación manual (`2026-07-06-regression-pilot`) resultó frágil (3/4 NO_PATCH; el
único válido, zod-001, pasó con y sin contexto → no discrimina). De ahí dos
decisiones: (1) terminar el A/B de grounding sobre Jina; (2) **pivotar M1/M2 a
SWE-PolyBench** en vez de curar broken_patch a mano. El otro agente (dueño del
harness de regresión) ya terminó; el `workdir` compartido está libre.

Memoria relevante: `benchmark-strategy-swe-polybench.md`,
`grounding-ab-retrieval-state.md`, `eval-generation-m1-m2-state.md`,
`eval-indexing-scope-and-inversify.md`.

Nota operativa: el classifier de permisos de Bash ha estado **intermitente**
(bloquea `ls`/`cat`, deja pasar `grep`/`python3`). Si bloquea comandos pesados
(`npm run eval:*`), pedir al usuario correrlos con `! <cmd>`.

---

## 🌅 PARA TI — QUÉ HACER MAÑANA (2026-07-07)  ← LEE ESTO PRIMERO

**Tu meta:** mañana tener resultados que digan **si hay mejora**; y si no la hay,
realizar un **análisis completo del proyecto** para encontrar los puntos que puedan dar esa mejora.

**Camino más corto al veredicto (verdad honesta):** lo que responde "¿hay mejora?"
es el **A/B de grounding (Carril 1)** — `grounded` (SLM + perfil semántico) vs
`baseline` (SLM crudo) sobre retrieval M3–M6. El perfil de **zod ya está listo**.
Bajar SWE-PolyBench (Carril 2, lo que pediste) es **progreso real pero NO da
resultados de generación mañana** (falta: bajar texto de HF → loader →
prepare_repos → clonar repos → generación con Ollama). **Recomendación: corre los
dos** — Carril 1 te da el veredicto mañana mismo, Carril 2 avanza el benchmark
grande en paralelo. Ollama es el cuello serial: encola sus pasos.

### Orden concreto (con mi ayuda)

1. [Realizado]**[5 min] Commitear lo pendiente.** Enricher/classifier/`intermediary.model` +
   los 2 traductores nuevos están validados (typecheck + tests verdes) pero **sin
   commitear**. Revisamos el diff y commiteamos antes de tocar nada.
2. [Responde (Cómo puedo configurarlo para que tarde mucho menos, en la herramienta estaba pensando tener un tiempo menor a 10 minutos, incluso menor a 5? )]**[arranca temprano, es largo — Ollama] Perfiles rxjs + inversify** (para el A/B
   completo de 6 tareas): `npm run eval:grounding:profiles -- --lock 2026-07-05-jina-code --model qwen2.5:7b-instruct`
   (~1–1.5 h c/u). ⚠ `inversify` puede chocar con M1 — avísame para coordinar.
   **Atajo:** el A/B **solo-zod** ya se puede correr (perfil listo) → señal rápida
   en minutos mientras rxjs/inversify construyen.
3. **[Ollama] A/B:** `eval:retrieval --run-id 2026-07-07-jina-grounding-ab
   --split semantic_profile_ab --use-slm` con env Jina. Validez: `grounded`
   `clean_query` ≠ `baseline` (si no, el grounder no tuvo efecto).
4. **[15 min] Métricas + reporte → EL VEREDICTO.** `eval:metrics:retrieval` +
   `eval/reports/2026-07-07-grounding-ab-jina.md`. **¿grounding recupera M3–M5?**
5. **[EN PARALELO, offline, tu `!`] Carril 2 — bajar HF.** Bajar el parquet de
   `SWE-PolyBench_Verified` con `problem_statement`/`patch`/`test_patch` (hoy solo
   tenemos metadata → loader bloqueado). Luego escribo el **loader instance-centric**
   (ya consume los 2 traductores hechos).

### Gate de decisión (tu frase "y en caso de que no…")

- **Si hay mejora** → lo documentamos como resultado citable y seguimos SWE-PolyBench.
- **Si NO hay mejora** → **análisis completo del proyecto**. Puedo orquestarlo como
  workflow multi-agente (retrieval, grounding, embeddings, enricher, extractor) y
  traerte una lista priorizada de dónde está el techo y por qué. Dime "análisis completo".

### Ya listo (no rehacer)

- `eval/scripts/lib/swe-polybench-nodes.ts` (+test) — `modified_nodes`→node-id (91.8%).
- `eval/scripts/lib/swe-polybench-test-command.ts` (+test) — parser de los 200 (176 runnable).
- Perfil zod: `eval/workdir/indexes-jina/zod/tensor.sqlite`, `state=ready`, 1011 términos.

---

## ESTADO ACTUAL — sesión 3 (2026-07-06): enricher RESUELTO, perfil de zod listo

El muro del enricher (sesión 2) quedó **resuelto** y el perfil semántico de **zod
se construyó end-to-end**. Cambios **sin commitear** (typecheck OK, 31 tests
dirigidos verdes + suite completa salvo un flake de timing en `e2e-cli` que pasa
aislado).

**Causa raíz real (distinta al diagnóstico de sesión 2):** el tag local
`gemma4:e4b` que se probó es un **modelo *thinking*** (arch `gemma4`, 8B, capacidad
`thinking`). `OllamaService.chat` solo leía `message.content` y no desactivaba el
razonamiento → en lotes reales el modelo gastaba todo `num_predict` en el campo
`thinking` y devolvía `content` **vacío** (`len=0` → "no devolvió JSON"). No era el
modelo mal hecho: era agotamiento de presupuesto por thinking.

**Fix aplicado (archivos):**
- `src/slms/llm-client.ts` + `ollama-service.ts`: `ChatOptions.think?: boolean`
  reenviado como campo top-level de Ollama.
- `src/semantic-profile/semantic-term-enricher.ts`: `think:false`; quitado el
  volcado temporal a `/tmp`; y **rediseño para que NUNCA aborte**: (a) contenido
  (alias/dominios/descripción/confianza) se coacciona o descarta (ruido del SLM),
  (b) la reparación pide **solo los términos faltantes** (con temp0/seed42 reintentar
  el mismo lote da la misma salida errónea; una entrada más pequeña decodifica
  fresco), (c) los que el SLM siga omitiendo reciben `minimalEnrichment` (sin
  alias/dominios, `confidence:0`) preservando completitud. Esto fue necesario: qwen
  falló en real por (1) `confidence de alias inválido` y (2) count mismatch.
- `src/retriever/utilities/mini-agents/agent-intermediary/classifier.ts`:
  `think:false` (obligatorio: su `num_predict:256` lo consumiría entero un modelo
  thinking → `content` vacío → clasificación fallida).
- **Modelo del intermediario configurable**: nueva clave `intermediary.model`
  (vacío = hereda `agent.model`) + `resolveIntermediaryModel()` en `src/cli/config.ts`,
  cableado en `src/cli/pipeline.ts` (default runtime). Decisión usuario: **qwen en
  todo por ahora**; basta `lacoco config set intermediary.model gemma4:e4b` para
  cambiar solo el intermediario sin tocar generación ni enricher.
- Tests nuevos: `tests/retrieval/semantic-term-enricher.test.ts`,
  `tests/cli/intermediary-model.test.ts`, y `think` passthrough en `ollama-service.test.ts`.

**Resultado del build (comando ganador):**
`npm run eval:grounding:profiles -- --lock 2026-07-05-jina-code --repo-id zod --model qwen2.5:7b-instruct`
→ **zod: 1011 términos, 4702 aliases, state=ready, smoke ground()=20 candidatos**,
en **4551s (~76 min)**. El gate confirma `grounded != baseline`.

### (A) Lo que queda por revisar / hacer
1. **Commitear** los 10 archivos (sin commitear aún).
2. **Escalar el perfil a `rxjs` (2648 nodos) e `inversify` (549)** con el mismo
   comando (quitar `--repo-id` o repetir por repo) y `--model qwen2.5:7b-instruct`.
   `inversify` puede **colisionar con M1** si vuelve el agente de generación.
3. **Correr el A/B de retrieval real** — FRENTE A pasos 3–4 (abajo), aún sin correr.
   Validez: en `retrieval.jsonl` confirmar `clean_query` grounded ≠ baseline.
4. **`watch.ts:206` usa `agent.model` (=qwen2.5-coder:1.5b) para el `profile
   rebuild` en background** → al auto-reconstruir el perfil en watch-mode chocaría
   con el mismo muro del enricher (el coder 1.5b no puede). Falta una clave
   `profile.model` (o reusar `intermediary.model`/un `enricher.model`) análoga.
   **Gap real, no cubierto por esta sesión.**
5. **`inspect.ts:53` construye su propio `SlmClassifier` con `options.model`
   explícito** → NO respeta `intermediary.model`. Decidir si cablearlo por
   consistencia (es una herramienta de debug con `--model` propio; quizá OK dejarlo).
6. **Verificar gemma en el intermediario end-to-end**: solo se hizo el plumbing +
   `think:false`; no se corrió un `retrieve` real con `intermediary.model=gemma4:e4b`.
7. **Cuántos términos de zod cayeron a `minimalEnrichment`** (aliases=[], conf=0):
   no hay observabilidad → no sabemos la calidad real del perfil (ver mejora 2).

### (B) Consideraciones de mejora
1. **Velocidad (~76 min/repo es caro).** `num_predict:8192` es muy holgado para
   lotes de 5 con `think:false` (~900 tokens observados de salida). Bajarlo (p. ej.
   1500–2048) y/o subir `BATCH_SIZE` (5→10/15 con un 7b capaz) debería acelerar
   mucho. Medir trade-off antes de escalar a rxjs (4× nodos) e inversify.
2. **Observabilidad del fallback**: contar/loguear términos con `minimalEnrichment`
   por lote y total (calidad del perfil, y si conviene reintentar con otro
   seed/temperatura en vez de degradar).
3. **La reparación por-subconjunto añade 1 llamada extra por lote incompleto**; con
   `BATCH_SIZE` grande podría dispararse el nº de reparaciones. Monitorear.
4. **Latencia del intermediario si se usa gemma4:e4b**: corre **por consulta** (no
   offline); 9.6GB/thinking vs qwen2.5-coder:1.5b. `think:false` ya está, pero
   validar que la latencia de clasificación sea aceptable antes de adoptarlo.
5. **Enricher secuencial por lote**: se podría paralelizar/cachear más agresivo
   (ya hay reuse por hash en `SemanticProfileBuilder`).

### (C) Carril 2 (SWE-PolyBench) — hecho hoy en paralelo al build (offline, sin Ollama)

Se construyeron los **2 traductores** que el loader consumirá (con tests, typecheck OK):

- **`eval/scripts/lib/swe-polybench-nodes.ts`** — `modified_nodes` (rutas CST) →
  node-id LaCoCo `<relpath>#<símbolo>`. Replica el extractor real
  (`node-extraction.ts` + `class-extraction.ts`): función→`#f`, clase→`#C`,
  método→`#C.m`. Decisiones de validez contra `tensor.sqlite`: **constructor →
  colapsa a `#Clase`** (LaCoCo usa `getMethods()`, no indexa constructores);
  nodos anidados → colapsan al ancestro direccionable (`collapsed:true`);
  `method_definition` sin clase (object-literals CommonJS de serverless) → no mapea
  a nivel nodo (`orphan_method`) pero el archivo queda como señal file-level.
  **Cobertura real: 382/416 nodos (91.8%); los 34 no-mapeados son todos
  orphan_method.** Limitación documentada: getter/setter indistinguible del método
  en la ruta CST (LaCoCo los nombra `Clase::get:x`) → el smoke los detectará.
- **`eval/scripts/lib/swe-polybench-test-command.ts`** — parser/clasificador de los
  200 `test_command`. `parseTestCommand()` (nunca lanza): nodeVersion, runner,
  packageManager, reporter, custom-reporter, testTargets, bespoke+razón.
  `parseF2pTestId()` separa `file->title`. `toLocalTestCommand()` best-effort:
  quita prefijo Docker (`. /usr/local/nvm/nvm.sh && nvm use X && npm pkg set lint`),
  reemplaza `/testbed/custom-reporter.js`→reporter local, `null`+razón en bespoke.
  **Landscape: mocha 103, npm-script 50, yarn-script 20, jest 3, bespoke 24;
  176/200 runnable local; bespoke = vscode `scripts/test.sh` (23) + angular `bazel`
  (1) → excluir del smoke.** No sintetiza `--grep`/`-t` de F2P (eso lo hará el
  runner con el repo presente, usando los títulos parseados).

**BLOQUEO del loader (paso 5 de "PARA TI"):** `eval/data/swe-polybench/instances.tsjs.jsonl`
tiene solo metadata (`problem_statement_len`, etc.), **NO el texto** de
`problem_statement`/`patch`/`test_patch` (`fetch_metadata.py` fue liviano). Sin
`problem_statement` no hay query de retrieval → **bajar el dataset completo de HF es
prerequisito del loader.** Lo que YA tenemos completo y los traductores consumen:
`base_commit`, `F2P`, `test_command`, `changed_files`, `modified_nodes`.

### (C) Lo que YA estaba en el plan (cross-ref, sin cambios)
- **FRENTE A pasos 1–4** (índice Jina, perfil in-place, A/B, métricas+reporte): la
  parte del **perfil** ya está desbloqueada y probada en zod; faltan rxjs/inversify
  y el A/B en sí. El gap "perfil vacío → grounding silencioso" ya no aplica en zod.
- **Escalar a rxjs/inversify** y la **colisión inversify↔M1**: ya anotado (paso 4
  del enricher, y "Puntos de sincronización").
- **DECISIÓN abierta**: si el A/B sobre las 6 tareas manuales aún vale la pena
  frente al pivote a SWE-PolyBench (recomendación previa: correrlo igual, barato una
  vez indexado).
- **FRENTE B (SWE-PolyBench)** entero: intacto, no se tocó esta sesión.
- Memoria: [[grounding-ab-retrieval-state]] actualizada con este estado.

---

## ESTADO — sesión 2 (2026-07-06): muro de capacidad del enricher [RESUELTO en sesión 3]

**Se intentó ejecutar el setup del Frente A por primera vez y el enricher del
perfil semántico NO funciona con `qwen2.5-coder:1.5b` (= `agent.model`).** Esto es
lo primero que hay que resolver para desbloquear el A/B; el resto del Frente A
(retrieval/metrics/reporte) sigue igual que abajo.

**Diagnóstico definitivo** (volcado crudo en `/tmp/enricher-raw-first.txt`): el
1.5b-coder (a) **ignora los IDs opacos** de entrada y los reinventa como slugs
semánticos, (b) entra en **bucle de repetición** que llena `num_predict` (por eso
truncaba SIEMPRE justo en el techo de tokens, con cualquier batch), (c) emite
**JSON malformado** (comas fuera de lugar) → el `format` de Ollama no fuerza JSON
válido con ese modelo. **No es bug de batch/timeout/parse: es muro de capacidad
del modelo.** La tarea del enricher es SEMÁNTICA (alias es/en, dominios,
descripción), no de código → un **instruct** va mejor que un coder.

**Cambios ya aplicados (SIN commitear todavía):**
- `src/semantic-profile/semantic-term-enricher.ts`:
  - `BATCH_SIZE` 50→**5**; `num_predict` 4096→**8192** (mitigan truncación; no
    arreglan el bucle del 1.5b, pero son correctos para un modelo capaz).
  - `parseAliases`/`parseDomains`: ahora **deduplican y recortan** (ruido cosmético
    del SLM) en vez de lanzar y abortar el lote.
  - **⚠ DIAGNÓSTICO TEMPORAL**: en el `catch` de `#enrichBatch` se vuelca la
    respuesta cruda a `/tmp/enricher-raw-first.txt`. **QUITAR antes de commitear.**
- `eval/scripts/build-grounding-profiles.ts`:
  - Piso de timeout de **10 min** por llamada (el default de 30s abortaba el batch).
  - Flag **`--model <tag>`**: usa ese modelo SOLO para construir el perfil offline.
    El `QueryGrounder` en tiempo de consulta es determinista → **no altera el A/B**
    de retrieval (que sigue usando `agent.model`).

**Decisión (usuario): usar un instruct fuerte para el enricher.** Estado modelos:
- `qwen2.5:7b-instruct` → **ya descargado** (calidad alta, JSON fiable, multilingüe).
- `gemma3n:e4b` (~4B efectivos, MatFormer) → **más rápido que el 7b** en CPU, buen
  balance. **OJO: el tag es `gemma3n:e4b`, NO "gemma4:e4b"** (ese da 404). Hay que
  `ollama pull gemma3n:e4b` primero.

**Pasos para retomar el enricher:**
1. Elegir modelo: `qwen2.5:7b-instruct` (ya está) o `gemma3n:e4b` (pull primero).
2. `npm run eval:grounding:profiles -- --lock 2026-07-05-jina-code --repo-id zod --model <M>`
   (background; 7b en CPU es lento). Éxito = `semantic_terms>0`, `state=ready`,
   `ground>0`.
3. **Si el volcado muestra que el modelo NO echoa los IDs opacos** (los reinventa):
   añadir **fallback por índice** en `#parse` (mapear por posición cuando el count
   coincide pero los IDs no) → robustece el enricher para cualquier modelo. Solo si
   hace falta.
4. Escalar a `rxjs` e `inversify` (quitar `--repo-id`). **inversify puede colisionar
   con M1** si vuelve el agente de generación → coordinar.
5. **Quitar el volcado de diagnóstico temporal** del enricher.
6. Seguir con el A/B de retrieval + métricas + reporte (pasos de abajo, sin cambios).

---

## FRENTE A — Terminar el A/B de grounding sobre Jina (retrieval, M3–M6)

**Objetivo:** responder la pregunta abierta del reporte consolidado: ¿el *query
grounding* (perfil semántico) recupera la relevancia temprana (M3–M5) que el SLM
crudo pierde? Medido sobre el embedding ganador (Jina).

**Diseño:** split `semantic_profile_ab` = `baseline` (SLM sin grounding) vs
`grounded` (SLM + `QueryGrounder`), 4 estrategias × 6 tareas = 48 celdas, embedding
Jina 768d. Referencia ya medida: Jina+determinista (run `2026-07-05-jina-code`).

**Gates ya verdes (verificados 2026-07-06):** Ollama arriba con `qwen2.5-coder:1.5b`
(= default `agent.model`); variante `grounded` cableada en `run-retrieval.ts:285`
(`QueryGrounder(...).ground(task.prompt)`); split definido en `run.yaml:148`.
**Nunca se ha corrido `grounded`** — territorio no probado.

**EL GAP CRÍTICO (o `grounded` ≈ `baseline` en silencio):**
- El grounder abre el `.lacoco/tensor.sqlite` **del propio repo**
  (`resolveDbPath(repoPath)` en `src/cli/storage-paths.ts`; `paths.data=.lacoco`).
- `DeterministicTermExtractor.extract()` (`src/semantic-profile/deterministic-term-extractor.ts:38`)
  lee `SELECT ... FROM nodes` de ese db.
- Pero `eval:index` escribe el grafo al índice del eval con `--db <eval>/indexes/...`,
  e `init` (`state-commands.ts`) solo **registra** el proyecto (no indexa).
- ⇒ `profile rebuild {repo_path}` extrae **0 nodos → perfil vacío → grounding sin efecto**.
- **FIX:** indexar el grafo **in-place** en el `.lacoco` del repo (correr
  `index_graph <tsconfig>` **sin** `--db`) antes de `profile rebuild`. El perfil es
  text-based e **independiente del embedding**; Jina solo afecta el índice de
  *ranking* (indexesDirectory).

### Pasos (workdir ya libre)
1. **Índice de ranking Jina** en `indexesDirectory`, con env:
   `LACOCO_EMBEDDING_MODEL=jinaai/jina-embeddings-v2-base-code`, `LACOCO_EMBEDDING_DIM=768`,
   `LACOCO_EMBEDDING_QUANTIZED=false` (ver `src/embeddings/embedding-config.ts`).
   rxjs necesita recompilar `dist/types` para paridad de 2648 nodos (ver
   `eval/runs/2026-07-05-jina-code/comparison-vs-baseline.md`, nota final).
2. **Perfil in-place:** por cada repo (zod, rxjs, inversify):
   `npm run dev -- index_graph <tsconfig>` (sin `--db`, va a `.lacoco`) +
   `npm run dev -- profile rebuild <repo_path> --json`. Usa el SLM (job largo:
   enricher LLM sobre cientos de términos vía Ollama). **Verificar** que
   `semantic_terms` quedó poblado (`SELECT count(*) FROM semantic_terms`), sino el
   grounding no hace nada.
3. **Correr A/B:** `npm run eval:retrieval -- --run-id 2026-07-06-jina-grounding-ab
   --split semantic_profile_ab --use-slm` con env Jina. Congela el SLM 1×/tarea/variante.
   Para run-id nuevo, `eval:index` exige lock: reusar un lock existente (p. ej.
   copiar `eval/runs/2026-07-05-jina-code/repos.lock.json`) o correr `eval:prepare`.
4. **Métricas + reporte:** `npm run eval:metrics:retrieval -- --run-id 2026-07-06-jina-grounding-ab`
   y reporte `eval/reports/2026-07-06-grounding-ab-jina.md` con columnas: **grounded**
   vs **baseline** (Jina+SLM) vs ref **Jina+det** (jina-code) y **MiniLM+SLM** (slm-fixed).
   Responder explícito: ¿grounding recupera M3–M5? ¿conserva M6?

### Verificación de validez
- Antes de correr, confirmar `count(semantic_terms) > 0` en el `.lacoco` de cada repo.
- Confirmar en el `retrieval.jsonl` que `grounded` produjo `clean_query` distinta a
  `baseline` (sino el grounder no tuvo efecto).

**DECISIÓN abierta:** frente al pivote a SWE-PolyBench, evaluar si este A/B sobre las
6 tareas manuales aún vale la pena, o si el esfuerzo de grounding se traslada al
nuevo benchmark. Recomendación: correrlo igual (barato una vez indexado, cierra la
historia del reporte consolidado) pero no invertir más allá.

---

## FRENTE B — Integrar SWE-PolyBench (generación M1/M2 + M3–M5 auto)

**Decisión (2026-07-06):** M1 (resuelve) + M2 (alucinación) sobre **SWE-PolyBench**;
M3/M4/M5 (localización) **auto-derivadas del gold patch**; M6 (multi-hop, el
diferenciador de LaCoCo) manual sobre subconjunto. Filtrar instancias por
C1 (TS/Node) + C2 (>1000★) + C3 (modular).

**Dataset (HuggingFace, AmazonScience):**
- `SWE-PolyBench` (full), `SWE-PolyBench_500` (estratificado), `SWE-PolyBench_Verified`
  (394, recomendado para calidad). Campos: `instance_id`, `repo`, `base_commit`,
  `patch` (code patch = gold), `test_patch`, `FAIL_TO_PASS`, `PASS_TO_PASS`,
  `problem_statement`, `language`. Harness oficial: `github.com/amazon-science/SWE-PolyBench`
  (usa Docker; nosotros reusamos el camino local).

**Mapeo al harness actual (casi 1:1, y más simple):**
| Harness actual (`task.regression`) | SWE-PolyBench | Nota |
|---|---|---|
| repo verde → `applyBrokenPatch` | `base_commit` **ya es el estado roto** | se elimina el broken_patch manual |
| `target_tests` (manual) | `FAIL_TO_PASS` | vienen del `test_patch` |
| gold patch | `patch` | referencia |
| `relevant_nodes` (manual) | derivable del `patch` | archivos + nodos función/clase |

Flujo nuevo: **checkout `base_commit` + aplicar `test_patch` → los F2P fallan → el
agente arregla → correr F2P**. Desaparece `eval/manifests/regression/`
(broken diffs + STATUS.md) y la lógica `applyBrokenPatch/verifyBrokenState`
(`eval/scripts/lib/git.ts`, `prepare-repos.ts:265-282`).

### Piezas de implementación
1. **Loader de instancias** (nuevo `eval/scripts/import-swe-polybench.ts`, + helper
   python para bajar el parquet de HF). Filtra por language∈{TS,JS} + repo whitelist
   C1/C2/C3. Recomendado empezar con `SWE-PolyBench_Verified`. Emite un manifest de
   tareas (p. ej. `eval/manifests/tasks.swe-polybench.yaml`) mapeando cada instancia
   a `TaskDefinition` + `regression{base_commit, test_patch, FAIL_TO_PASS}`.
2. **prepare_repos instance-centric** (EL CAMBIO ESTRUCTURAL MÁS GRANDE). Hoy el
   harness es **repo-centric** (un repo por id, tasks referencian `repo_id`).
   SWE-PolyBench es **instance-centric** (instancia = repo@commit; distintos
   `base_commit` del mismo repo pueden necesitar deps distintas). Decidir:
   checkout+install **por instancia** (más limpio, más pesado) vs agrupar por repo y
   re-checkout por tarea. Adaptar `prepare-repos.ts`: `ref = base_commit`, aplicar
   `test_patch`, verificar F2P rojo (no `applyBrokenPatch`).
3. **Auto M3–M5** (nuevo lib, p. ej. `eval/scripts/lib/gold-patch-nodes.ts`): parsear
   el gold `patch` (diff unificado) → archivos cambiados (file-level) + nodos
   función/clase que contienen los hunks (node-level, vía AST). **Reusar
   `eval/scripts/lib/node-id.ts`** (formato `<filepath>#<symbol>`) y
   `src/extractor/callable-analysis.ts`. Emitir `relevant_nodes` automáticos. Método
   CST publicado por SWE-PolyBench (deepest affected node por hunk; solo función/clase).
4. **M6 manual**: mantener `annotation_policy` de `tasks.yaml` (multihop = distancia
   ≥2 en grafo desde el anchor). Anotar solo un subconjunto pequeño.
5. **Retrieval/generación/métricas**: **sin cambios** (ya consumen `relevant_nodes`
   y `target_tests`).

### Costos / riesgos (honesto)
- **Refactor repo→instance-centric** es lo más grande; planificarlo primero.
- **Install por `base_commit`**: friccción de deps; acotar con pocos repos + subset
  `_Verified`.
- **Test runner por repo**: cada repo usa jest/vitest/mocha distinto. El harness de
  SWE-PolyBench encapsula build/test por repo en Docker; localmente hay que mapear el
  comando de test por repo (ver `focused_test_command_template` en `repos.yaml`).
  Ejecutar solo los `FAIL_TO_PASS` específicos.
- **Contaminación / validez de retrieval**: LaCoCo debe **indexar el `base_commit`
  (estado pre-fix)**, NO el post-fix. Los `relevant_nodes` del gold patch en su mayoría
  existen pre-fix (los fixes editan código existente); símbolos *nuevos* creados por el
  fix no estarán en el índice pre-fix → caso borde para M3/M4, anotarlo.
- **C3 estricto**: no existe benchmark de reparación OSS con microservicios. Si C3 =
  "modular O microservicios", los repos modulares (material-ui, vue, svelte, express)
  cumplen. Si el tribunal exige microservicios, no hay dataset y toca curar a mano.

### Orden recomendado
1. Bajar dataset (metadata) → **listar repos TS/JS reales** → filtrar C1/C2/C3
   (whitelist final). Read-only, barato.
2. Loader → importar 2–3 instancias de 1 repo (smoke).
3. Adaptar prepare_repos (instance-centric) + verificar F2P rojo en 1 instancia.
4. Auto M3–M5 del gold patch → verificar `relevant_nodes` a mano en 1 instancia.
5. Correr retrieval+generación+métricas end-to-end en el smoke (1 repo, pocas instancias).
6. Escalar a la whitelist C1/C2/C3.

### Verificación end-to-end (smoke)
- 1 instancia: F2P rojo en `base_commit`+`test_patch`; el agente con `no_context`
  vs `ictd` produce patches; M1 discrimina (idealmente `no_context` falla e `ictd`
  pasa en alguna); `relevant_nodes` auto coinciden con inspección manual del gold patch.

---

## Paralelización — qué se puede hacer en simultáneo

El cuello de botella compartido es **Ollama** (un solo backend CPU/GPU) y el
**workdir** de repos. Los Frentes A y B son independientes en código, así que las
partes que NO tocan Ollama pueden solaparse. Tres carriles:

**Carril 1 — Ollama-bound (SERIAL entre sí; no se solapan con otros usos de Ollama):**
- Construir perfiles del enricher (zod → rxjs → inversify) con el modelo instruct.
- A/B de retrieval (`--use-slm`, congela el SLM 1×/tarea/variante) → usa Ollama.
- Estos dos pasos compiten por Ollama entre sí y con cualquier generación de
  Frente B → **serializar todo lo que use Ollama**.

**Carril 2 — CPU/dev SIN Ollama (se solapa 100% con el Carril 1):**
- Frente B, implementación offline: loader de instancias SWE-PolyBench, refactor
  `prepare_repos` a instance-centric, parser gold-patch→node-id (auto M3–M5),
  bajar el parquet de HuggingFace. Nada de esto necesita Ollama → **correr en
  paralelo mientras el Carril 1 tiene Ollama ocupado** (p. ej. mientras el perfil
  del enricher se construye durante minutos).

**Carril 3 — Escritura (se solapa con todo):**
- Reportes (`grounding-ab-jina.md`), este plan, memoria. Sin recursos compartidos.

**Puntos de sincronización (obligan a serializar):**
1. **Ollama**: perfil-enricher, A/B retrieval y generación SWE-PolyBench NO pueden
   correr a la vez. Encolarlos.
2. **Repo `inversify`**: lo comparten Frente A (grounding) y M1 (generación). No
   re-checkout/index simultáneo del mismo worktree.
3. El **smoke de generación** de Frente B necesita que el loader+prepare (Carril 2)
   estén listos Y Ollama libre (Carril 1) → es el primer punto donde convergen.

**Reparto si se usan 2 sesiones/agentes en paralelo:**
- Agente/sesión A → Carril 1 (enricher + A/B, dueño de Ollama y del árbol
  `repos-jina/`).
- Agente/sesión B → Carril 2 (Frente B offline, archivos nuevos + `repos/` para
  SWE-PolyBench, sin tocar Ollama ni `repos-jina/`).
- Coordinar solo en los 3 puntos de sync de arriba.

---

## Prioridad sugerida para la próxima sesión

**Frente B paso 1 (whitelist C1/C2/C3) YA está hecho** — ver
`eval/reports/2026-07-06-swe-polybench-whitelist.md` y [[swe-polybench-schema-and-whitelist]].

Con dos carriles paralelos (ver "Paralelización"):
1. **Arrancar el enricher** (Carril 1, Ollama): elegir modelo instruct, correr el
   perfil de zod, verificar el volcado. Es el desbloqueo de todo el Frente A y hay
   que dejarlo corriendo (minutos por repo).
2. **En paralelo** (Carril 2, sin Ollama): Frente B paso 2 en adelante — loader
   instance-centric + parser gold-patch→node-id, mientras Ollama está ocupado.
3. **Al liberarse Ollama**: A/B de retrieval + métricas + reporte (cierra Frente A).
4. **Convergencia**: smoke de generación SWE-PolyBench (necesita loader listo +
   Ollama libre).
