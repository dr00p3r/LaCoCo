# Smoke SWE-PolyBench — svelte, query = texto del issue (vs título)

**Fecha:** 2026-07-07 · **Rama:** `eval/harness-cleanup` · **Run:** `2026-07-07-fulltext-pilot`
**Comparación contra:** `2026-07-07-9d35435-pilot` (baseline título-solo).
**Alcance:** mismas 9 instancias svelte, mismo gold, mismo índice (Jina), retrieval
determinista (sin Ollama). Única variable: la query.

## Cambio

El loader ponía `deterministic_input.embedding_input` = **primera línea** del
problem_statement (el título). El retrieval determinista usa ese campo como query
(`run-retrieval.ts:243`), así que solo se buscaba con el título y el cuerpo —donde
viven los identificadores de código— se descartaba.

`import-swe-polybench.ts` ahora pone `embedding_input` = **issue completo limpio**
(`cleanIssueText()`: normaliza `\r\n`, colapsa links markdown a su texto, borra URLs
sueltas, compacta líneas en blanco; NO toca fences ni diffs). Sin anotación manual.

## Resultado (métricas oficiales, macro por tarea → macro por repo)

| Estrategia | M4 Recall@5 tít | M4 Recall@5 **full** | M5 MRR tít | M5 MRR **full** |
|---|---:|---:|---:|---:|
| **clcr**  | 0.333 | **0.556** | 0.185 | **0.556** |
| **hybrid**| 0     | **0.556** | 0.051 | **0.481** |
| ictd      | 0     | 0.222 | 0.022 | 0.122 |
| rpr       | 0     | 0     | 0     | 0     |

- **Mejor estrategia: clcr y hybrid empatan en R@5 = 0.556** (5/9), vs 0.333 (clcr) del
  baseline. MRR de clcr casi se triplica (0.185 → 0.556).
- M3 Precision@5 ≤ 0.2 por diseño (1 solo nodo gold por tarea); clcr/hybrid = 0.111.
- M7 latencia ~2.8s (vs ~2.6s): query más larga, embedding un pelo más lento. Trivial.

## Qué se recuperó y qué sigue duro

Rangos del gold (mejor estrategia), baseline → fulltext:

```
RECUPERADAS (entran a top-5):  510 3→1 · 906 3→1 · 1116 -→1 · 1227 -→1 · 1923 1→1
SIGUEN FUERA de todo pool:     728 -→- · 907 -→- · 1310 -→- · 2185 -→-
```

**5/9 recuperadas solo con el texto del issue.** Las **4 que siguen duras** (728, 907,
1310, 2185) son el objetivo limpio del grounding: p.ej. `svelte-1310` y `svelte-906`
comparten el mismo gold (`Selector.ts#attributeMatches`) pero 906 entró a rank 1 y 1310
sigue fuera → el texto de 1310 describe el bug sin nombrar el símbolo. Ese es
exactamente el caso "prompt vago" que el grounding debe cerrar.

## Validez

- Mismo gold (derivado del patch, sin cambios), mismo índice Jina, misma partición de 9
  instancias → apples-to-apples, única variable = la query.
- svelte-3151 sigue fuera (no está en el lock; `npm install` falló en el smoke previo).
- `rpr` sigue en 0: devuelve pools chicos (4–24) y nunca contiene el gold — problema
  estructural de esa estrategia con gold de 1 nodo sin multi-hop, no de la query.

## Próximo

- **Brazo grounding** sobre estas mismas 9 (cuando cierre el build del perfil): la pregunta
  neta es si recupera parte de las 4 duras (728/907/1310/2185) partiendo del texto del issue.
- Decidir si `embedding_input`=texto-completo pasa a ser el canónico del dir `swe-polybench/`
  (hoy vive en `swe-polybench-fulltext/` para no pisar el baseline).
