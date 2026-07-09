# A/B de semantic-profile-grounding: perfil 7B vs perfil 4B (svelte-728)

**Fecha:** 2026-07-08 · **Intermediario (sanitizer):** `qwen2.5:7b-instruct` (fijo, único SLM en el A/B)
**Split:** `semantic_profile_ab` (2 repos: svelte-510, svelte-728; 4 estrategias; 2 brazos: baseline/grounded; 16 celdas por run)
**Runs:**
- `2026-07-08-grounding-ab-svelte728-7b-profile7b` → perfil 7B (Run A)
- `2026-07-08-grounding-ab-svelte728-7b-profile4b` → perfil 4B (Run B)

## 1. Métricas de build del perfil (svelte-728)

| Métrica | 7B (qwen2.5:7b-instruct) | 4B (qwen3:4b-instruct) | Speedup |
|---|---:|---:|---:|
| Wall time | 5096.9 s = **85 min** | 1859.7 s = **31 min** | **2.74×** |
| Concurrencia | 1 (efectiva: serie) | 3 (paralela) | — |
| VRAM pico | 5112 MB | 4262 MB | -850 MB |
| Tokens/s (per slot) | 50 t/s | 60 t/s | 1.2× |
| **Términos** | 1121 | 1121 | idéntico |
| **Aliases** | 5307 | **3558** | -33% |
| Dominios | 18 | 18 | idéntico |

> **Nota sobre el target del plan:** el plan proponía ≤10 min. La realidad fue 31 min. El cuello de botella no fue el modelo (60 t/s vs 50 t/s) ni la VRAM (sobraron 4 GB), sino el **prompt cache thrashing** que se repite con la 4B (`cached n_tokens = 208, memory_seq_rm [208, end)` por batch). Con 4096 ctx y `BATCH_SIZE=5`, cada batch invalida el cache. La velocidad viene de los 3 slots paralelos, no de KV cache más grande (no la aprovechamos — el server sigue con default 4096 ctx).
>
> **Fix para bajar a ≤10 min:** subir `num_ctx: 8192` (la 4B cabe en 4 GB con margen) o reducir `BATCH_SIZE` de 5 a 2-3. Queda como tarea Fase 0bis.

## 2. GroundCandidates del grounder (artefacto `_sanitizer/grounded.json`)

### svelte-728 (el caso duro)

**Perfil 7B (top-10 por score):**
```
Element.ts (source-file)      0.031
first (symbol)                0.030
Binding.ts (source-file)      0.029
typescript::Array (ext-import) 0.028
pos (symbol)                  0.027
blocks (symbol)               0.026
first (symbol)                0.022
typescript (dependency)       0.016
output.json (project-file)    0.016
nodes (symbol)                0.016
```

**Perfil 4B (top-10 por score):**
```
blocks (symbol)               0.031
blocks (symbol)               0.029   ← duplicado por evidencia de path
first (symbol)                0.026
first (symbol)                0.026
localBlocks (symbol)          0.016
helpers (symbol)              0.016
block (symbol)                0.016
rules (symbol)                0.016
getBindingValue (symbol)      0.016
Block (symbol)                0.016
```

**Comparación cualitativa**:
- 7B mezcla paths de archivos (`Element.ts`, `Binding.ts`, `output.json`) con símbolos genéricos. Muchos candidatos son del tipo `source-file` / `project-file` / `external-import`.
- 4B produce candidatos **todos del tipo `symbol`** y lexicalmente más cercanos al bug ("keyed blocks" → `blocks`, `localBlocks`, `block`, `Block`, `first`, `rules`).
- **Gold `visitComponent` no aparece en ninguno** (rank > 20 en ambos perfiles). El grounder está trayendo **vecinos** del grafo, no el gold. Esto explica el M5 plano/negativo.
- **Diferencia estructural**: 4B produce 1/3 menos aliases pero todos relevantes al dominio del símbolo; 7B produce más volumen pero diluye.

### svelte-510 (caso fácil, baseline ya en rank 1)

**Perfil 7B (top-10)** — usado en ambos runs (510 nunca se rebuildeó con 4B):
```
Ref.js (source-file)          0.030
mount (symbol)                0.025
Component.js (source-file)    0.016
isElseIf (symbol)             0.016
Component.js (source-file)    0.016
warnings.json (project-file)  0.016
magic-string::remove (ext)    0.016
output.json (project-file)    0.016
svelte.js (source-file)       0.016
isReference (symbol)          0.015
```

Gold `visitEachBlock` no aparece tampoco. Pero el baseline ya recupera el gold por la query directa ("else block").

## 3. Métricas M3-M7 del A/B (svelte-728 aislado, Run A vs Run B)

| Estrategia | Métrica | baseline | 7B grounded | 4B grounded | Δ(7B-bas) | Δ(4B-bas) |
|---|---|---:|---:|---:|---:|---:|
| hybrid | M3 P@5 | 0.200 | 0.100 | 0.100 | -0.100 | -0.100 |
| hybrid | M4 R@5 | 1.000 | 0.500 | 0.500 | -0.500 | -0.500 |
| hybrid | M5 MRR | 0.667 | 0.500 | 0.500 | -0.167 | -0.167 |
| hybrid | M7 lat (ms) | 9964.5 | 5079.5 | 5240.5 | -4885.0 | -4724.0 |
| ictd | M3 | 0.100 | 0.100 | 0.100 | +0.000 | +0.000 |
| ictd | M4 | 0.500 | 0.500 | 0.500 | +0.000 | +0.000 |
| ictd | M5 | 0.250 | 0.167 | 0.167 | -0.083 | -0.083 |
| ictd | M7 | 9831.0 | 5111.5 | 5230.5 | -4719.5 | -4600.5 |
| clcr | M3 | 0.200 | 0.100 | 0.100 | -0.100 | -0.100 |
| clcr | M4 | 1.000 | 0.500 | 0.500 | -0.500 | -0.500 |
| clcr | M5 | 0.667 | 0.500 | 0.500 | -0.167 | -0.167 |
| clcr | M7 | 9775.5 | 5097.0 | 5232.5 | -4678.5 | -4543.0 |
| rpr | M3-M5 | 0 | 0 | 0 | 0 | 0 |
| rpr | M7 | 9763.5 | 5177.0 | 5260.0 | -4586.5 | -4503.5 |

**Conclusión métrica**: las métricas del A/B son **idénticas** entre perfil 7B y perfil 4B en svelte-728. La diferencia cualitativa en `groundCandidates` (4B más relevante, 7B más volumen) **no se traduce** en delta de M3-M5. El bottleneck es estructural: el gold no aparece en top-20 de candidatos con ninguno de los dos perfiles.

**Latencia (M7)**: el grounded es ~50% más rápido que baseline en ambos runs (~5100 ms vs ~9800 ms). El intermediario 7B del baseline corre más lento (cold cache) que el del grounded (warm cache por el prompt más largo del grounding). Esto NO es un efecto del grounding, es **orden de ejecución** (baseline se ejecuta primero en el split). Confirmado por la simetría 7B vs 4B.

## 4. Veredicto

### Build

- ✅ **4B es 2.74× más rápido que 7B en build** (31 min vs 85 min), usando la misma `BATCH_SIZE=5` y `num_predict=2048`. La causa es el paralelismo 3-slot, no el modelo (60 vs 50 t/s marginal).
- ⚠️ El target de ≤10 min del plan no se cumplió. **Causa**: `BATCH_SIZE=5` con prompt > 4096 ctx causa prompt cache thrashing (`memory_seq_rm [208, end)` en cada batch). Fixes posibles: `num_ctx: 8192` (4B cabe) o `BATCH_SIZE: 2-3`.
- ✅ VRAM 4B (4262 MB) deja ~4 GB libres. Margen amplio para subir `num_ctx` o `concurrency`.
- ❌ 4B produce 33% menos aliases que 7B. Es una diferencia estructural, no necesariamente mala (4B es más conciso, 7B más verboso).

### A/B retrieval

- ❌ **El grounding NO ayuda en svelte-728** con ninguno de los dos perfiles. M5 (MRR) cae de 0.667 → 0.500 (clcr/hybrid) y 0.250 → 0.167 (ictd) con grounding. Las M3/M4 (precisión/cobertura temprana) también caen.
- **Causa raíz (ya diagnosticada en memoria anterior)**: el gold `Component/.../Component.ts#visitComponent` **no está entre los top-20 candidatos** del grounder. El bug es "keyed blocks and binding breaks array looping" — el gold no contiene "blocks" ni "keyed" en su nombre. La query saneada por el 7B se desvía hacia vecinos tangenciales.
- El **prompt no es informativo** del símbolo gold. Es el mismo problema que en zod-001/002 donde el grounding sí ayudó (el símbolo gold tenía lexical hooks como `trim`/`strict`). En svelte-728 el símbolo se llama `visitComponent` y la query habla de "blocks/binding/looping" — desconexión semántica que el grounding no puede cerrar.

### Calidad del perfil 4B

- ✅ Los candidatos del 4B son **cualitativamente mejores** (todos `symbol` relevantes al dominio del bug) vs 7B (mezcla `source-file`/`project-file`/`external-import` con símbolos genéricos).
- ❌ Pero la mejora cualitativa no llega al gold. El delta de M3-M5 es cero.

## 5. Decisiones

### Aceptado

- ✅ **Adoptar `qwen3:4b-instruct` como modelo permanente de build offline del perfil**, en lugar de `qwen2.5:7b-instruct`. Razones:
  - 2.74× más rápido (31 min vs 85 min) para svelte-728.
  - 850 MB menos VRAM (4262 vs 5112 MB) — margen para `num_ctx=8192` futuro.
  - Calidad de aliases comparable (33% menos volumen, mejor precisión simbólica).
  - `OLLAMA_NUM_PARALLEL=3` (3 slots paralelos) es el sweet spot para esta GPU.

### Pendiente (Fase 0 / 0bis)

- ❌ Bajar build time a ≤10 min requiere:
  - Subir `num_ctx: 8192` en OPTIONS (con `4B` cabe: ~2.5 GB modelo + ~1.5 GB KV cache 8k = ~4 GB; los 4 GB libres absorben).
  - O reducir `BATCH_SIZE: 5 → 3` (prompt más chico, cache hit mejor, throughput cae ~20% pero per-batch latency mejora).
- ❌ El **grounding sigue sin aportar** sobre casos donde el símbolo gold no es lexicalmente derivable del prompt. La fix de fondo no es la schema ni el modelo del perfil — es **un mecanismo para que el prompt del bug apunte al símbolo** (probablemente fuera del alcance del grounding, es un problema de task definition / gold).

### Reproducibilidad

- Snapshot del DB 7B antes de invalidar: `/tmp/lacoco-svelte728-7b-snapshot-20260708-071759.sqlite` (4.9 MB)
- 7B build eliminado al ejecutar el 4B rebuild (`completeBuild` borra builds anteriores). El snapshot permite reconstruirlo.
- Lock para re-correr: `eval/runs/2026-07-07-9d35435-pilot/repos.lock.json` (con `--repo-id svelte-728 --model qwen3:4b-instruct --concurrency 3`).
