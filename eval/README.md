# LaCoCo experimental evaluation pipeline

Este directorio contiene la infraestructura **externa al core** para ejecutar la validacion academica de LaCoCo. No forma parte del binario `lacoco` ni debe instalarse como funcionalidad inicial de la herramienta.

La separacion es intencional:

- `src/` contiene LaCoCo como herramienta: indexacion, recuperacion y exportacion de contexto.
- `eval/` contiene el arnes experimental: prepara repositorios, ejecuta estrategias, integra agentes de codificacion externos, mide resultados y genera tablas para el trabajo de integracion curricular.

## Objetivo experimental

Evaluar si el contexto recuperado por LaCoCo mejora la generacion de codigo en repositorios JavaScript/TypeScript con Node.js, comparando estrategias de recuperacion y agentes externos bajo tareas controladas.

El pipeline mide dos niveles:

1. **Recuperacion sin LLM**: calidad del contexto recuperado.
2. **Generacion con agente externo**: calidad del cambio producido al inyectar ese contexto en el prompt.

## Por que no es un comando publico

El benchmark requiere clonar repositorios externos, fijar versiones, instalar dependencias, ejecutar suites de pruebas, invocar herramientas como OpenCode/Codex/Claude Code, guardar diffs y calcular metricas. Ese flujo pertenece a un experimento reproducible, no al contrato normal de la CLI.

LaCoCo debe limitarse a producir contexto y prompts enriquecidos. El pipeline experimental decide como usar esos artefactos.

## Estructura propuesta

```text
eval/
  README.md
  manifests/
    agents.yaml       # Agentes externos y modo de invocacion
    metrics.yaml      # Definicion formal de metricas M1-M13
    repos.yaml        # Repositorios de evaluacion, versiones y comandos
    run.yaml          # Configuracion global de ejecucion
    strategies.yaml   # Estrategias LaCoCo y baselines
    tasks.yaml        # Tareas, prompts y ground truth manual
  runs/               # Salidas generadas por ejecuciones concretas (no versionar)
```

## Manifests

El benchmark productivo vigente usa `eval/manifests/swe-polybench/`. El
directorio `eval/manifests/` queda como legacy/historico para reproducir runs
anteriores y para tests del harness; no debe usarse para reportes nuevos.

| Archivo | Funcion |
|---|---|
| `manifests/repos.yaml` | Define repositorios, refs, gestores de paquetes, comandos de instalacion, pruebas e indexacion. |
| `manifests/strategies.yaml` | Define las estrategias que se comparan: `no_context`, `hybrid`, `ictd`, `clcr`, `rpr` y `agentic`. |
| `manifests/agents.yaml` | Define adaptadores para agentes externos, inicialmente OpenCode, Codex CLI, Claude Code, modo manual y dry-run. |
| `manifests/metrics.yaml` | Formaliza las metricas de generacion, retrieval (patch-evidence) y grounding. Cada metrica lleva `role` (`agent_outcome`/`gold_derived`/`diagnostic`/`legacy`); `quality_gates.*.required_metrics` no puede incluir `diagnostic`/`legacy` (invariante validado por `load-manifests.ts`). |
| `manifests/run.yaml` | Controla rutas, repeticiones, timeouts, semillas, politicas de limpieza, formato de salida y gates de ejecucion. |
| `manifests/tasks.yaml` | Contiene las tareas experimentales y su gold. El gold principal es `gold.patch_evidence`, derivado AUTOMATICAMENTE del patch de referencia (no del grafo). Los campos `relevant_nodes`/`multihop_nodes` son legacy y solo alimentan diagnostico de grafo. |

## Runbook SWE-PolyBench

Flujo recomendado, pasando el directorio canonico en cada comando:

```bash
npm run eval:check-manifests -- --manifests-dir eval/manifests/swe-polybench
npm run eval:prepare -- --run-id <run> --manifests-dir eval/manifests/swe-polybench
npm run eval:index -- --run-id <run> --manifests-dir eval/manifests/swe-polybench
# Opcional para A/B de grounding:
npm run eval:grounding:profiles -- --run-id <run> --manifests-dir eval/manifests/swe-polybench
npm run eval:retrieval -- --run-id <run> --split retrieval_official --manifests-dir eval/manifests/swe-polybench
npm run eval:metrics:retrieval -- --run-id <run> --manifests-dir eval/manifests/swe-polybench --strict
npm run eval:benchmark:doctor -- --run-id <run> --split retrieval_official --manifests-dir eval/manifests/swe-polybench
```

Alternativa para una sesion completa:

```bash
export LACOCO_EVAL_MANIFESTS_DIR=eval/manifests/swe-polybench
npm run eval:check-manifests
npm run eval:prepare -- --run-id <run>
npm run eval:index -- --run-id <run>
npm run eval:retrieval -- --run-id <run> --split retrieval_official
npm run eval:metrics:retrieval -- --run-id <run> --strict
npm run eval:benchmark:doctor -- --run-id <run> --split retrieval_official
```

`eval:benchmark:doctor` escribe `benchmark-doctor.json` y
`benchmark-doctor.md` en el directorio del run. Verifica el manifest efectivo,
split y filtros aplicados, `repos.lock.json`, DB SQLite y LanceDB por repo,
salud del patch-evidence gold (`patch_evidence_health`: gold ausente/vacio,
fallback file-level, refs sin resolver, archivos inexistentes), cobertura
estratificada y rank del primer gold (`patch_evidence_coverage`), el grafo como
DIAGNOSTICO (`graph_diagnostic` + `graph_distance_profile`, nunca hace fallar el
run), artifacts `context.json`, errores por celda, y ruido externo `lib#...`.

## Como leer el benchmark

La metrica NORTE es el AGENTE, no el retrieval. La validacion final de LaCoCo es
si reduce tiempo/costo/alucinaciones y sube el pass rate del agente
(`ΔPass@1` vs `no_context` + flips, tiempo, costo, M2). El retrieval se lee como
*explicacion* de por que una estrategia ayuda o no ayuda al agente, no como fin en
si mismo (mismo principio que SWE-bench).

**Tiempo y costo (panel end-to-end).** El agente recibe el contexto **pre-inyectado**
en el `prompt.md` (no hay hook de recuperacion vivo), asi que `agent_duration_ms`
mide **solo** el agente, sin recuperacion. El overhead de recuperacion se mide aparte
(`retrieval.jsonl.timings_ms.total` = sanitizer SLM + retrieval). `compute-generation-metrics`
los une por `(task, strategy_id)` y `compare-strategies` reporta, por estrategia:
`RetrievalOverheadMs`, `AgentDurationMs`, y el **`EndToEndMs` = overhead + agente**
(0 de overhead para `no_context`), mas `CostUsd`. La lectura justa vs `no_context` es
**ΔE2E**: `< 0` = el contexto se paga solo (menos tiempo total aunque traerlo cueste).
Requiere haber corrido el `eval:retrieval` de la variante ANTES de la generacion, para
que existan los registros de retrieval que aportan el overhead.

Metricas de retrieval (contra `gold.patch_evidence`, K primario =
`aggregation_policy.ranking_cutoff_primary`):

- **EditSiteHit@K** / **PatchEvidenceHit@K**: si el top-K contiene el edit-site
  (archivo o simbolo editado) / cualquier evidencia del patch.
- **MRR** / **EditSiteMRR**: rank reciproco del primer elemento de evidencia /
  del primer elemento estrictamente edit-site. Si NADA matchea, el valor es `0` y
  la tarea SE CUENTA igual en el promedio (no se excluye).
- **UsefulContextCoverage@K**: cobertura del conjunto completo de patch-evidence.
  OJO: `1 − UsefulContextCoverage@K` **no es "ruido"**. El extractor automatico
  nunca captura el 100% del contexto legitimamente util, asi que la fraccion no
  cubierta incluye contexto valido que el gold no modela.
- **ExternalNoiseRate@K**: fraccion del top-K que son nodos externos/genericos
  (`lib#…`, `node_modules`). Acotado a externos, NO "todo lo que no es gold".

Diagnostico de grafo (nunca define pass/fail): `GraphDistanceProfile@K` (con
patches multi-archivo, distancia MINIMA a cualquier edit-site en el resumen y
perfil por edit-site en el doctor) y `GraphNeighborhoodCoverage@K`.

Al ampliar el gold, es esperable que la cobertura amplia converja hacia arriba
entre estrategias; **EditSiteHit@K / EditSiteMRR** suelen ser las que de verdad
discriminan. Precision@5/Recall@5 se retiraron del resumen (viven como `legacy`
en `metrics.yaml` solo por reproducibilidad historica).

## Fases del pipeline

### 1. Preparacion

```text
read repos.yaml
  -> clone repo
  -> checkout ref
  -> install dependencies
  -> optionally generate eval tsconfig
```

### 2. Indexacion

```text
lacoco init <repo_path>
lacoco index_graph <tsconfig> --db <run>/indexes/<repo>/tensor.sqlite
lacoco index_vectors <tsconfig> --lancedb <run>/indexes/<repo>/lancedb
lacoco profile rebuild <repo_path> --json # solo para el A/B semantico
```

### 3. Recuperacion

Para cada tarea y variante de sanitizer:

```text
read task prompt + deterministic sanitizer fields
  -> materialize one complete sanitizer output per task
  -> persist it under artifacts/<task>/_sanitizer/
  -> reuse the same encoded output for every retrieval strategy
  -> save context.json, ranked nodes, scores, metadata and timings
  -> compute EditSiteHit/PatchEvidenceHit/MRR/EditSiteMRR/UsefulContextCoverage/
     ExternalNoiseRate against patch_evidence gold when available
```

El modo determinista vive en `eval/` y reutiliza el pipeline y el registro de
estrategias de LaCoCo. Con `--use-slm`, el runner ejecuta `AgentIntermediary1`
una sola vez por tarea y variante, persiste el contrato completo y lo inyecta
en todas las estrategias. `retrieval.jsonl.sanitizer_source` distingue ambos
casos y `sanitizer_variant: agent_intermediary` identifica la variante SLM
principal. La duracion del sanitizer congelado se suma por igual al tiempo total
de cada estrategia para mantener comparable M7.

El split `semantic_profile_ab` ejecuta las variantes `baseline` y `grounded`
sin confundirlas con estrategias:

```bash
npm run eval:index -- --run-id <run> --repo-id <repo> --profile
npm run eval:retrieval -- --run-id <run> --split semantic_profile_ab --sanitizer-variant grounded
npm run eval:metrics:semantic-profile -- --run-id <run>
```

### 4. Generacion

Para cada tarea, estrategia y agente:

```text
validate every required retrieval context before writing generation.jsonl
  -> reset repo to clean checkout
  -> build enriched prompt
  -> invoke external coding agent
  -> persist the effective model as generation.jsonl.model_id
  -> persist provider-reported cost as generation.jsonl.cost_usd
  -> save stdout/stderr/session artifacts
  -> save git diff
  -> run focused tests
  -> compute M1
  -> run hallucination detector
  -> compute M2
```

### 5. Reporte

```text
retrieval.jsonl
  generation.jsonl
  hallucinations.jsonl
  summary.csv
  summary.md
  tables-for-thesis.md
```

## Ground truth (patch-evidence gold)

El gold principal se deriva AUTOMATICAMENTE del patch de referencia via
`lib/patch-evidence-gold.ts` (no del grafo, para evitar circularidad con
estrategias graph-based). El loader `import-swe-polybench` lo puebla en
`gold.patch_evidence` y persiste el patch crudo bajo `patches/<id>.patch`.

- `patch_evidence.edited_files` / `edited_symbols`: edit-site (lo que el patch
  modifica). Si ningun simbolo mapea, cae a nivel archivo
  (`resolution.fell_back_to_file_level = true`).
- `patch_evidence.touched_tests`: archivos del `test_patch` asociados.
- `patch_evidence.introduced_refs` / `resolved_definitions`: Tier 2 —
  imports/calls/types en lineas añadidas y sus definiciones internas, resueltos
  con ts-morph directo (sin tocar `src/graph`).
- `target_tests`: comandos/archivos de prueba que validan la solucion.

Campos `relevant_nodes` / `multihop_nodes` = LEGACY: solo alimentan el
diagnostico de grafo del doctor, no las metricas del resumen.

Mientras una tarea tenga `gold.status: pending_manual_annotation` o carezca de
`patch_evidence`, el pipeline puede ejecutarla para inspeccion pero sus metricas
de gold quedan excluidas/invalidas (la latencia se computa igual).

## Salidas por tarea

Ejemplo de directorio generado:

```text
eval/runs/2026-xx-xx/
  retrieval.jsonl
  generation.jsonl
  hallucinations.jsonl
  summary.csv
  artifacts/
    zod-001/
      _sanitizer/
        agent_intermediary.json
      hybrid/
        agent_intermediary/context.json
  generation-artifacts/
    zod-001/
      hybrid/
        opencode/
          context.json
          prompt.md
          agent.stdout.log
          agent.stderr.log
          patch.diff
          tests.log
```

Retrieval y generacion usan raices de artefactos separadas. Una estrategia con
retrieval nunca degrada a un placeholder si falta `context.json`: el preflight
falla antes de truncar `generation.jsonl` o modificar un repositorio. Solo
`no_context` conserva el placeholder explicito de la Opcion B.

`eval:generation -- --resume` conserva `generation.jsonl`, suma el costo ya
reportado y omite celdas existentes para el mismo task, estrategia, agente y
modelo. `--max-budget-usd` usa los eventos `step_finish.part.cost` de OpenCode y
detiene la corrida si no puede medir el costo. Los limites `max_diff_bytes` y
`max_changed_files` se aplican antes de ejecutar las pruebas; una violacion
queda registrada como `patch_limit_exceeded` y cuenta como fallo M1.

## Criterio minimo antes de ejecutar una corrida oficial

1. Todos los repositorios de `repos.yaml` deben resolver a un commit exacto en `repos.lock.json`.
2. Las tareas incluidas en la corrida oficial deben tener `gold.status: ready`.
3. Los comandos de prueba deben ejecutarse al menos una vez sin modificaciones del agente.
4. Los agentes externos deben tener configuracion local validada.
5. La corrida oficial debe guardar JSONL crudo y resumen tabular.

## Convenciones

- No editar `src/` para meter logica experimental pesada.
- Si falta instrumentacion en LaCoCo, exponerla como salida JSON o metadata reusable.
- No versionar `eval/runs/`, repositorios clonados, indices SQLite/LanceDB ni logs pesados.
- Usar refs fijos y guardar commits resueltos.
- Reportar siempre fallos y tareas excluidas; no reemplazar datos faltantes por ceros sin marcarlo.
