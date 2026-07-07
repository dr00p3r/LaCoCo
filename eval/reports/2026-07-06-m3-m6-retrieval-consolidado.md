# M3–M6 retrieval: reporte consolidado del piloto

Fecha del análisis: 2026-07-06.

Consolida los resultados de recuperación **sin LLM** (M3–M6) del piloto sobre un
único diseño experimental: **6 tareas gold-`ready` × 4 estrategias = 24 celdas**,
con dos ejes de variación medidos contra una **misma línea base**. Reemplaza como
lectura de referencia a los dos informes previos, que quedan como fuentes de
detalle:

- `2026-07-05-m3-m7-sanitizer-delta-slm-fixed.md` — eje *sanitizer* (determinista → SLM).
- `2026-07-05-jina-code/comparison-vs-baseline.md` — eje *embedding* (MiniLM → Jina).
- `2026-07-05-m3-m7-sanitizer-delta.md` — **obsoleto**, conservado solo por trazabilidad.

## Diseño y línea base común

Los tres runs comparten tareas, estrategias, commits y política de agregación
(`macro_by_task_then_repo`). El run **`2026-07-05-natural`** es el ancla común
(MiniLM + sanitizer determinista); cada uno de los otros dos cambia **una sola
variable**:

| Run | Embedding | Sanitizer | Variable aislada |
|---|---|---|---|
| `2026-07-05-natural` | Xenova/all-MiniLM-L6-v2 (384d, quant.) | determinista | — (ancla) |
| `2026-07-05-slm-fixed` | Xenova/all-MiniLM-L6-v2 (384d, quant.) | `AgentIntermediary1` (SLM, congelado por tarea) | **sanitizer** |
| `2026-07-05-jina-code` | jinaai/jina-embeddings-v2-base-code (768d, fp32) | determinista | **embedding** |

- Tareas: zod-001, zod-002, inversify-001, inversify-002, rxjs-001, rxjs-002.
- Estrategias: `hybrid`, `ictd`, `clcr`, `rpr`. 0 celdas excluidas de M3–M6.
- Commits idénticos: Zod `7baee4e17`, Inversify `be5d342a`, RxJS `e5351d02e`.
- Scope de índice verificado idéntico entre embeddings (nodos: zod 595=595,
  inversify 549=549, rxjs 2648=2648; `dist/types` de rxjs recompilado en el
  worktree jina para igualar 2648).

Fuentes: `retrieval-metrics.json` de cada run (`summary.global`, `by_strategy`,
`by_repo`).

## Resultado global — los dos ejes contra el ancla

| Métrica | natural (ancla) | SLM · Δrel | Jina · Δrel |
|---|---:|---:|---:|
| M3 Precision@5 | 0.1583 | 0.0833 · **−47.4%** | 0.2583 · **+63.2%** |
| M4 Recall@5 | 0.0758 | 0.0395 · **−47.9%** | 0.1211 · **+59.7%** |
| M5 MRR | 0.3979 | 0.2185 · **−45.1%** | 0.5398 · **+35.7%** |
| M6 Multi-hop Recall@20 | 0.1280 | 0.1585 · **+23.8%** | 0.2054 · **+60.5%** |
| M7 latencia observada (ms) | 541.7 | 2411.3 · +345% (4.45×) | 1955.1 · +261% (3.61×) |

**Lectura central: los dos ejes empujan en direcciones opuestas.**

- El **embedding code-aware (Jina)** mejora **las cuatro métricas de calidad** —
  precisión temprana *y* cobertura multi-hop — sin tocar el sanitizer.
- El **intermediario SLM** hace lo contrario en relevancia temprana: parte a la
  mitad M3/M4/M5 y solo recupera algo en M6 (+24%).
- Ambos ejes cuestan latencia, pero por motivos distintos: Jina por el modelo
  más pesado (768d fp32 en CPU), el SLM por la inferencia del intermediario.

La mejor configuración observada del piloto es **Jina + sanitizer determinista +
`ictd`** (M3 0.367, M5 0.917). El SLM no aparece en ninguna configuración ganadora
de relevancia temprana.

## Por estrategia (macro sobre 6 tareas)

| Estrategia | Métrica | natural | SLM | Jina |
|---|---|---:|---:|---:|
| `hybrid` | M3 / M5 / M6 | 0.167 / 0.411 / 0.113 | 0.033 / 0.072 / 0.110 | 0.200 / 0.462 / **0.232** |
| `ictd`   | M3 / M5 / M6 | 0.233 / 0.685 / 0.234 | 0.200 / 0.578 / 0.199 | **0.367 / 0.917 / 0.266** |
| `clcr`   | M3 / M5 / M6 | 0.200 / 0.416 / 0.089 | 0.033 / 0.079 / 0.162 | 0.333 / 0.543 / 0.184 |
| `rpr`    | M3 / M5 / M6 | 0.033 / 0.079 / 0.075 | 0.067 / 0.144 / 0.163 | 0.133 / 0.237 / 0.140 |

- **`ictd` es la estrategia dominante en las tres condiciones** y la que más gana
  con Jina (M5 0.685 → 0.917). También es la más robusta al SLM (solo −14/16%
  frente al −80% de `hybrid`/`clcr`).
- **`hybrid` y `clcr`** dependen de una query nítida: colapsan con el SLM (−80%)
  pero se benefician de Jina. `clcr` bajo SLM se vuelve un expansor estructural
  puro (sacrifica M3 pero sube M6).
- **`rpr`** es la más débil en todas las condiciones — es un problema de la
  estrategia, no del embedding ni del sanitizer. Cualquier reescritura la ayuda
  porque su baseline determinista ya es malo.

## Por repositorio (macro sobre estrategias)

| Repo | Métrica | natural | SLM | Jina |
|---|---|---:|---:|---:|
| Zod | M3 / M5 | 0.200 / 0.521 | 0.050 / 0.164 | **0.400 / 0.764** |
| RxJS | M3 / M5 | 0.250 / 0.494 | 0.150 / 0.313 | 0.275 / 0.564 |
| Inversify | M3 / M5 | 0.025 / 0.179 | 0.050 / 0.179 | 0.100 / 0.292 |

- **Zod** es el más sensible a ambos ejes: se desploma con el SLM (y dispara la
  latencia a 4202 ms) y es el que más sube con Jina (M3 ×2, M5 +47%).
- **Inversify** parte de un piso muy bajo (M3 0.025). Jina lo duplica pero sigue
  siendo el repo más difícil; su query natural determinista ya era pobre.
- **RxJS** es el más estable frente a los dos ejes.

## Por qué el SLM degrada (motiva el grounding)

El SLM produjo dos patologías opuestas en `clean_query`, ambas dañinas para un
retrieval que espera queries compactas orientadas a símbolos de código en inglés:

- **Sub-saneado**: devuelve casi la oración completa en español (zod-001/002,
  inversify-001) → diluye la señal léxica/vectorial.
- **Sobre-colapso**: rxjs-002 → `"scheduling"` para las 4 estrategias → pérdida
  total de especificidad.

Esto es exactamente lo que el **semantic-profile-grounding** debe atacar: anclar
la query a términos que existen en el proyecto, evitando tanto el español largo
como el colapso a una palabra genérica — idealmente conservando la ganancia
multi-hop del SLM (M6) sin su pérdida de precisión temprana.

## Limitaciones (aplican a todo el piloto)

1. **Piloto de 6 tareas.** Los deltas son descriptivos; no hay prueba de
   significancia estadística.
2. **M7 no es P95 oficial.** Es una observación por celda, no las 100 rep + 5
   warmup de `metrics.yaml`. En `slm-fixed` incluye el costo del SLM; en `jina`
   refleja el modelo de embedding más pesado. Reportar como "latencia observada".
3. **El baseline determinista usa `retrieval_input.query` en inglés.** Parte del
   delta del SLM es efecto idioma/forma. Es la comparación válida igualmente,
   porque representa el pipeline real (prompt NL → sanitizer).
4. Los dos ejes se midieron por separado; **no hay una celda Jina+SLM** que mida
   su interacción.

## Conclusión y siguiente paso

Sobre el mismo diseño de 24 celdas, el piloto de retrieval deja dos señales
limpias y de signo opuesto:

- **Migrar el embedding a uno code-aware (Jina) está justificado**: mejora las
  cuatro métricas en todas las estrategias, con mayor efecto en `ictd`/`clcr` y en
  el MRR. El costo es ~3.6× de latencia observada, a evaluar contra una medición
  M7 formal.
- **El intermediario SLM, tal como está, no mejora la relevancia temprana**: la
  reduce ~45% por la forma de su `clean_query`. Su único aporte (M6 +24%) es lo
  que el **grounding basado en el Project Semantic Profile** debe preservar
  mientras corrige la degradación léxica.

Estado del piloto de retrieval: **M3–M6 cerrado y citable**. Próximos frentes en
este carril: (a) medición M7 formal con warmup/repeticiones para cuantificar el
costo real de Jina, y (b) A/B de semantic-profile-grounding (`split
semantic_profile_ab`, variantes `baseline` vs `grounded`).

> **Actualización 2026-07-07.** El A/B de grounding (b) está cerrado para zod en
> `2026-07-07-grounding-ab-zod.md`: el grounding recupera profundidad de ranking
> (M5/MRR y M6/multihop) sin tocar la precisión temprana, a +~1.65 s. Además, dos
> notas de validez sobre los números Jina de este consolidado: (1) fueron
> calculados con el gold en rutas **absolutas** (era previa a la migración a rutas
> relativas), por lo que son válidos tal como están publicados; (2) **recomputarlos
> hoy** requiere el fix de `compute-retrieval-metrics.ts` que resuelve el gold
> contra el `repoPath` del *lock del run* (árbol `repos-jina/`) en vez de
> `paths.repos` — sin ese fix, el gold relativo se resuelve contra `repos/` y M3–M6
> dan 0 en todas las celdas **sin error**.
