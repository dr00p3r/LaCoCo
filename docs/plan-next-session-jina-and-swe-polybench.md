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

## Prioridad sugerida para la próxima sesión

1. **Frente B, paso 1** (listar+filtrar repos C3) — barato, desbloquea todo el diseño.
2. **Frente A** (grounding A/B) — cerrar la historia del retrieval mientras el índice
   Jina está fresco; es acotado.
3. **Frente B, resto** — la integración grande; el refactor instance-centric primero.
