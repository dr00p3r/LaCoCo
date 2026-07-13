# Runbook del benchmark (SWE-PolyBench · svelte)

Guía copy-paste para correr el benchmark completo con las dos condiciones
(**determinista** y **grounded/SLM**), ambas con generación, incluyendo la
estrategia `agentic` (SLM 4b) y opencode con `deepseek-v4-flash` en `high`.

La métrica **norte es el agente** (ΔPass@1 vs `no_context` + flips, tiempo, costo,
alucinaciones); el retrieval (patch-evidence gold) explica *por qué* una estrategia
ayuda o no.

---

## 0. Variables de entorno (una vez por sesión)

```bash
export MD=eval/manifests/swe-polybench
export RUN=2026-07-08-svelte-agentic          # id estable para todo el run

# SLM 4b — lo usan la estrategia `agentic` y la variante `grounded`
export LACOCO_AGENT_MODEL="qwen3:4b-instruct"        # ollama pull qwen3:4b-instruct
export LACOCO_AGENT_ENDPOINT="http://localhost:11434"

# Modelo de generación de opencode = deepseek-v4-flash en high
export LACOCO_EVAL_OPENCODE_MODEL="opencode-go/deepseek-v4-pro"  # id EXACTO de `opencode models`
export LACOCO_EVAL_OPENCODE_AGENT="build"                       # ver nota "high" abajo
```

> **Sobre "high":** el arnés solo pasa `--model {model}` y `--agent {agent_profile}`
> a opencode. El *reasoning effort* "high" se configura del lado de opencode
> (`opencode.json` por-modelo, o un agent profile). Pon el id real del modelo
> (`opencode models`) y, si tu "high" vive en un perfil, apúntalo en
> `LACOCO_EVAL_OPENCODE_AGENT`.

> **Atajo:** en vez de repetir `--manifests-dir $MD` puedes `export
> LACOCO_EVAL_MANIFESTS_DIR=$MD` y omitir el flag.

---

## 1. (Opcional) Regenerar el gold desde el dataset

Ya está regenerado. Solo si quieres rehacerlo (escribe `tasks/repos/run.yaml`,
`patches/*.patch` y `gold.patch_evidence`):

```bash
pnpm run eval:import:swe-polybench -- --repo sveltejs/svelte --limit 10
```

---

## 2. Común (una vez por run)

```bash
pnpm run eval:check-manifests -- --manifests-dir $MD
pnpm run eval:prepare         -- --run-id $RUN --manifests-dir $MD
pnpm run eval:index           -- --run-id $RUN --manifests-dir $MD
```

---

## 3. Config A — determinista (el actual) + generación

Estrategias: `hybrid / ictd / clcr / rpr / agentic` (+ `no_context` en generación).
`agentic` planifica con el SLM 4b vía Ollama.

```bash
# Retrieval + métricas + doctor
pnpm run eval:retrieval         -- --run-id $RUN --split retrieval_official --manifests-dir $MD
pnpm run eval:metrics:retrieval -- --run-id $RUN --manifests-dir $MD --strict
pnpm run eval:benchmark:doctor  -- --run-id $RUN --split retrieval_official --manifests-dir $MD

# Generación (opencode deepseek-v4-flash high) + análisis
pnpm run eval:generation         -- --run-id $RUN --split generation_official --manifests-dir $MD
pnpm run eval:hallucination      -- --run-id $RUN --manifests-dir $MD
pnpm run eval:metrics:generation -- --run-id $RUN --manifests-dir $MD
pnpm run eval:compare:strategies -- --run-id $RUN --manifests-dir $MD
```

---

## 4. Config B — grounded (SLM 4b) + generación

Requiere **Ollama con `qwen3:4b-instruct`**. Ojo al **orden**: el retrieval grounded
debe correr antes que la generación grounded (produce los registros
`strategy@grounded` congelados).

```bash
# Perfil semántico (build offline con el 4b)
pnpm run eval:grounding:profiles -- --run-id $RUN --manifests-dir $MD

# Retrieval grounded + métricas (registros hybrid@grounded, agentic@grounded, ...)
pnpm run eval:retrieval          -- --run-id $RUN --split retrieval_grounded --manifests-dir $MD
pnpm run eval:metrics:retrieval  -- --run-id $RUN --manifests-dir $MD

# Generación alimentada con el contexto grounded
pnpm run eval:generation         -- --run-id $RUN --split generation_grounded --manifests-dir $MD
pnpm run eval:hallucination      -- --run-id $RUN --manifests-dir $MD
pnpm run eval:metrics:generation -- --run-id $RUN --manifests-dir $MD
pnpm run eval:compare:strategies -- --run-id $RUN --manifests-dir $MD
```

---

## 5. (Opcional) A/B de grounding puro (retrieval)

Baseline (sin grounding) vs grounded, solo retrieval, para aislar el efecto del
Project Semantic Profile:

```bash
pnpm run eval:retrieval               -- --run-id $RUN --split semantic_profile_ab --manifests-dir $MD
pnpm run eval:metrics:retrieval       -- --run-id $RUN --manifests-dir $MD
pnpm run eval:metrics:semantic-profile -- --run-id $RUN --manifests-dir $MD
```

---

## Recomendación

Corre **Config A y Config B en el MISMO `--run-id`**. Así el `generation.jsonl`
contiene `hybrid`, `agentic`, … (deterministas) **y** `hybrid@grounded`,
`agentic@grounded`, … contra el mismo baseline `no_context`, y
`eval:compare:strategies` te da ΔPass@1 + flips de ambas condiciones en una sola
tabla comparable.

Secuencia mínima end-to-end (ambas configs, un solo run):

```bash
pnpm run eval:check-manifests    -- --manifests-dir $MD
pnpm run eval:prepare            -- --run-id $RUN --manifests-dir $MD
pnpm run eval:index              -- --run-id $RUN --manifests-dir $MD
pnpm run eval:grounding:profiles -- --run-id $RUN --manifests-dir $MD
# retrieval de ambas variantes
pnpm run eval:retrieval          -- --run-id $RUN --split retrieval_official --manifests-dir $MD
pnpm run eval:retrieval          -- --run-id $RUN --split retrieval_grounded --manifests-dir $MD
pnpm run eval:metrics:retrieval  -- --run-id $RUN --manifests-dir $MD --strict
pnpm run eval:benchmark:doctor   -- --run-id $RUN --split retrieval_official --manifests-dir $MD
# generación de ambas variantes (grounded exige retrieval_grounded previo)
pnpm run eval:generation         -- --run-id $RUN --split generation_official --manifests-dir $MD
pnpm run eval:generation         -- --run-id $RUN --split generation_grounded --manifests-dir $MD
pnpm run eval:hallucination      -- --run-id $RUN --manifests-dir $MD
pnpm run eval:metrics:generation -- --run-id $RUN --manifests-dir $MD
pnpm run eval:compare:strategies -- --run-id $RUN --manifests-dir $MD
```

---

## Dependencias externas

| Paso | Necesita |
|---|---|
| retrieval determinista (`hybrid/ictd/clcr/rpr`) | nada extra |
| estrategia `agentic` | Ollama + `qwen3:4b-instruct` |
| grounding / variante grounded | Ollama + `qwen3:4b-instruct` + `eval:grounding:profiles` |
| generación | agente `opencode` instalado + tests del repo ejecutables |

---

## Salidas (en `eval/runs/$RUN/`)

| Archivo | Contenido |
|---|---|
| `retrieval-metrics.json`, `summary.md/.csv` | EditSiteHit / PatchEvidenceHit / MRR / EditSiteMRR / UsefulContextCoverage / ExternalNoiseRate (contra patch-evidence gold) |
| `benchmark-doctor.json/.md` | salud del patch-evidence, cobertura estratificada, rank del primer gold, perfil de distancia de grafo (diagnóstico) |
| `generation-metrics.json`, `generation-summary.md/.csv` | M1 (Pass@1 regression), M2 (hallucination), y panel de tiempo/costo: `RetrievalOverheadMs`, `AgentDurationMs`, `EndToEndMs`, `CostUsd` por estrategia |
| `phase3-comparison.md/.csv` | ΔPass@1 + flips vs `no_context`, **panel end-to-end** (overhead + agente + `EndToEndMs` con ΔE2E y ΔCost vs `no_context`), determinista vs `@grounded` |

> **Tiempo end-to-end:** el agente recibe el contexto **pre-inyectado** (no hay hook
> vivo), así que `agent_duration_ms` **excluye** la recuperación. `EndToEndMs` =
> overhead de recuperación (`retrieval.jsonl` timings_ms.total; 0 para `no_context`) +
> agente = el costo real del flujo asistido. `compute-generation-metrics` une por
> `(task, strategy_id)`, así que **corre el `eval:retrieval` de la variante ANTES de la
> generación** para que el overhead esté disponible (si falta, end-to-end usa overhead 0
> y verás un `⚠` en la salida).

---

## Referencia de splits

| Split | Fase | Variante | Estrategias |
|---|---|---|---|
| `retrieval_official` | retrieval | deterministic | hybrid, ictd, clcr, rpr, agentic |
| `retrieval_grounded` | retrieval | grounded | hybrid, ictd, clcr, rpr, agentic |
| `semantic_profile_ab` | retrieval | baseline + grounded | hybrid, ictd, clcr, rpr, agentic |
| `generation_official` | generation | deterministic | no_context, hybrid, ictd, clcr, rpr, agentic |
| `generation_grounded` | generation | grounded | no_context, hybrid, ictd, clcr, rpr, agentic |
