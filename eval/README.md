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

| Archivo | Funcion |
|---|---|
| `manifests/repos.yaml` | Define repositorios, refs, gestores de paquetes, comandos de instalacion, pruebas e indexacion. |
| `manifests/strategies.yaml` | Define las estrategias que se comparan: `no_context`, `hybrid`, `ictd`, `clcr`, `rpr` y `agentic`. |
| `manifests/agents.yaml` | Define adaptadores para agentes externos, inicialmente OpenCode, Codex CLI, Claude Code, modo manual y dry-run. |
| `manifests/metrics.yaml` | Formaliza M1-M13 para generacion, retrieval y grounding semantico. |
| `manifests/run.yaml` | Controla rutas, repeticiones, timeouts, semillas, politicas de limpieza, formato de salida y gates de ejecucion. |
| `manifests/tasks.yaml` | Contiene las tareas experimentales y su ground truth. Los nodos relevantes deben anotarse manualmente antes de calcular M3-M6. |

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
  -> compute M3, M4, M5 and M6 when gold is available
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

## Ground truth

El ground truth no debe inventarse automaticamente. Para cada tarea se deben registrar:

- `relevant_nodes`: nodos necesarios para resolver la tarea.
- `multihop_nodes`: subconjunto de nodos relevantes que estan a distancia mayor o igual a dos saltos en el grafo.
- `target_tests`: comandos o archivos de prueba que validan la solucion.
- `annotation_notes`: justificacion breve de por que esos nodos son necesarios.
- `translation_gold.relevant_terms`: términos canónicos esperados en la traducción; se anotan manualmente.

Mientras una tarea tenga `gold.status: pending_manual_annotation`, el pipeline puede ejecutarla para inspeccion, pero debe excluirla de metricas M3-M6.

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
