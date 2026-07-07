> **OBSOLETO (2026-07-05).** Este informe compara contra `2026-07-05-slm-active`,
> que ejecutaba el SLM una vez por estrategia y registraba mal la variante. Usar en
> su lugar `2026-07-05-m3-m7-sanitizer-delta-slm-fixed.md` (run `slm-fixed`, sanitizer
> congelado por tarea y naming corregido). Se conserva solo por trazabilidad.

# Delta M3-M7: sanitizer deterministico vs. intermediario SLM

Fecha del analisis: 2026-07-05.

Este informe compara el run baseline `2026-07-05-natural`, que inyecto el
contrato de sanitizer deterministico, con `2026-07-05-slm-active`, que ejecuto
`AgentIntermediary1` y su SLM local. Es un resultado de retrieval independiente
del piloto M1/M2 de generacion.

## Alcance y comparabilidad

- 6 tareas con gold `ready`: dos de Zod, dos de Inversify y dos de RxJS.
- 4 estrategias: `hybrid`, `ictd`, `clcr` y `rpr`.
- 24 ejecuciones exitosas por run y ninguna tarea excluida de M3-M6.
- Ambos runs usan los mismos commits: Zod `7baee4e17f86f4017e09e12b0acdee36a5b1c087`,
  Inversify `be5d342a` y RxJS `e5351d02e225e275ac0e497c7b66eaa5f0c88791`.
- La agregacion es macro por tarea dentro de cada repositorio y despues macro
  entre repositorios, conforme a `retrieval-metrics.json`.

Fuentes: `eval/runs/2026-07-05-natural/retrieval-metrics.json` y
`eval/runs/2026-07-05-slm-active/retrieval-metrics.json`. Los `retrieval.jsonl`
se usaron para revisar las consultas efectivas y las latencias por celda.

## Resultado global

| Metrica | Deterministico | SLM real | Delta absoluto | Cambio relativo |
|---|---:|---:|---:|---:|
| M3 Precision@5 | 0.158333 | 0.075000 | -0.083333 | -52.6% |
| M4 Recall@5 | 0.075821 | 0.036048 | -0.039773 | -52.5% |
| M5 MRR | 0.397851 | 0.218023 | -0.179828 | -45.2% |
| M6 Multi-hop Recall@20 | 0.127976 | 0.165427 | +0.037450 | +29.3% |
| M7 latencia observada (ms) | 541.667 | 2108.208 | +1566.542 | +289.2% (3.89x) |

El intermediario SLM empeoro de forma marcada la calidad de los primeros
resultados: M3 y M4 cayeron aproximadamente a la mitad y M5 cayo 45.2%. Al
mismo tiempo, M6 aumento 29.3%. La lectura conjunta es que el SLM desplazo
evidencia relevante fuera de las primeras posiciones, pero algunas expansiones
de grafo alcanzaron mas dependencias multi-hop dentro del corte 20.

## Delta por estrategia

| Estrategia | M3 det. -> SLM | M4 det. -> SLM | M5 det. -> SLM | M6 det. -> SLM | M7 det. -> SLM |
|---|---:|---:|---:|---:|---:|
| `hybrid` | 0.166667 -> 0.033333 | 0.080303 -> 0.016667 | 0.411111 -> 0.072294 | 0.113095 -> 0.110119 | 529.833 -> 2718.167 ms |
| `ictd` | 0.233333 -> 0.200000 | 0.109343 -> 0.094192 | 0.685185 -> 0.577953 | 0.234127 -> 0.282738 | 550.333 -> 1894.667 ms |
| `clcr` | 0.200000 -> 0.033333 | 0.096970 -> 0.016667 | 0.415741 -> 0.092214 | 0.089286 -> 0.189484 | 545.333 -> 1909.833 ms |
| `rpr` | 0.033333 -> 0.033333 | 0.016667 -> 0.016667 | 0.079365 -> 0.129630 | 0.075397 -> 0.079365 | 541.167 -> 1910.167 ms |

`ictd` fue la estrategia mas robusta: conservo la mayor parte de M3-M5 y
mejoro M6. `clcr` duplico M6, pero perdio gran parte de su precision temprana.
`hybrid` sufrio la mayor degradacion de ranking y su latencia media quedo
afectada por una ejecucion de Zod de 7120 ms. `rpr` ya partia de valores bajos
en M3-M6; el SLM no cambio M3/M4 y mejoro ligeramente M5/M6.

## Delta por repositorio

| Repositorio | Delta M3 | Delta M4 | Delta M5 | Delta M6 | Factor M7 |
|---|---:|---:|---:|---:|---:|
| Inversify | 0.000000 | 0.000000 | -0.000622 | +0.046875 | 3.56x |
| RxJS | -0.100000 | -0.050000 | -0.181944 | +0.065476 | 3.30x |
| Zod | -0.150000 | -0.069318 | -0.356916 | 0.000000 | 4.80x |

La perdida global de M3-M5 se concentra en Zod y RxJS. Inversify mantiene su
calidad top-5, aunque desde un baseline bajo, y mejora M6. Zod explica tambien
la mayor parte del incremento extraordinario de latencia.

## Cambios observados en la consulta

El baseline deterministico produjo consultas compactas y orientadas a simbolos.
El SLM tendio a reescribirlas como instrucciones completas en espanol. El caso
extremo opuesto fue `rxjs-002`, cuyo `cleanQuery` se redujo a `scheduling` para
las cuatro estrategias. Esa perdida de especificidad coincide con descensos de
M3-M5 en Hybrid, ICTD y CLCR para esa tarea.

Ademas, el SLM no produjo exactamente el mismo sanitizer para todas las
estrategias de una misma tarea:

- `inversify-002`: Hybrid recibio una variante distinta de ICTD/CLCR/RPR.
- `rxjs-001`: Hybrid recibio una variante distinta de ICTD/CLCR/RPR.

Por ello, esas ocho celdas no aislan completamente el efecto de la estrategia:
parte del delta entre estrategias puede proceder de una clasificacion diferente.

## Limitaciones y lectura valida

1. Este es un piloto de 6 tareas. Los deltas son descriptivos y no prueban
   significancia estadistica.
2. M7 no debe presentarse todavia como P95 definitivo. El manifiesto exige 100
   repeticiones y 5 warmups, pero estos runs contienen una observacion por
   combinacion. Aqui se reporta la latencia observada agregada con el pipeline
   actual, que incluye el costo del intermediario SLM.
3. `2026-07-05-slm-active` registra `sanitizer_source: agent_intermediary`, pero
   conserva `sanitizer_variant: deterministic`. La fuente permite identificar
   correctamente el run; el nombre de variante es confuso y debe corregirse en
   futuras corridas.
4. El SLM se ejecuto por cada estrategia. Para una comparacion controlada debe
   materializarse una sola salida de `AgentIntermediary1` por tarea y reutilizarla
   en todas las estrategias.

## Conclusion para la tesis

En este piloto, reemplazar el sanitizer deterministico por el intermediario SLM
real no mejoro la relevancia temprana: redujo M3, M4 y M5 y multiplico por 3.89
la latencia observada. Si aporto una mejora de cobertura multi-hop en M6,
principalmente mediante ICTD y CLCR. El hallazgo no es simplemente que el SLM
sea peor: muestra una tension entre precision de ranking y cobertura estructural,
y evidencia que la forma de `clean_query` condiciona de manera distinta a cada
familia de estrategia.

Antes de convertirlo en resultado definitivo se debe repetir el experimento con
sanitizer congelado por tarea, mediciones M7 con warmup/repeticiones y un campo
de variante que distinga sin ambiguedad `deterministic` de `agent_intermediary`.
