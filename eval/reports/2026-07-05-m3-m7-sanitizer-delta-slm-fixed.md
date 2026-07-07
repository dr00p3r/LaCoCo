# Delta M3-M7: sanitizer determinista vs. intermediario SLM (run corregido)

Fecha del analisis: 2026-07-05.

Este informe **reemplaza** a `2026-07-05-m3-m7-sanitizer-delta.md`, que comparaba
contra `2026-07-05-slm-active`. Aquel run tenia dos defectos: ejecutaba el SLM una
vez por estrategia (no aislaba el efecto de la estrategia) y registraba
`sanitizer_variant: deterministic` pese a usar el intermediario. Ambos estan
corregidos en `2026-07-05-slm-fixed`, que congela una unica salida de
`AgentIntermediary1` por tarea y la reutiliza en las 4 estrategias, y registra
`sanitizer_variant: agent_intermediary` con `sanitizer_source: agent_intermediary`.

## Alcance y comparabilidad

- 6 tareas con gold `ready`: zod-001, zod-002, inversify-001, inversify-002,
  rxjs-001, rxjs-002.
- 4 estrategias: `hybrid`, `ictd`, `clcr`, `rpr`. 24 celdas por run, 0 excluidas de M3-M6.
- **Embedding identico en ambos runs: Xenova/all-MiniLM-L6-v2 (384d, quantizado).**
  Confirmado por: `embedding-metadata.json` del baseline; el `lancedb` en disco
  (indices de Jul 4, MiniLM); el default de `embedding-config.ts` (MiniLM salvo
  env vars `LACOCO_EMBEDDING_*`); y el orden temporal (slm-fixed retrieval 20:13,
  anterior al reindex de Jina de 21:04). Esto aisla el sanitizer del embedding.
- Mismos commits: Zod `7baee4e17`, Inversify `be5d342a`, RxJS `e5351d02e`.
- **Baseline determinista**: `retrieval_input.query` (query natural en ingles, sin
  simbolos del gold). **SLM**: `AgentIntermediary1` sobre `task.prompt` (espanol).
- Agregacion: macro por tarea dentro de cada repo, luego macro entre repos.

Fuentes: `eval/runs/2026-07-05-natural/retrieval-metrics.json` y
`eval/runs/2026-07-05-slm-fixed/retrieval-metrics.json`.

## Resultado global

| Metrica | Determinista | SLM (frozen) | Delta abs. | Cambio rel. |
|---|---:|---:|---:|---:|
| M3 Precision@5 | 0.158333 | 0.083333 | -0.075000 | -47.4% |
| M4 Recall@5 | 0.075821 | 0.039520 | -0.036301 | -47.9% |
| M5 MRR | 0.397851 | 0.218465 | -0.179386 | -45.1% |
| M6 Multi-hop Recall@20 | 0.127976 | 0.158482 | +0.030506 | +23.8% |
| M7 latencia observada (ms) | 541.667 | 2411.292 | +1869.625 | +345.2% (4.45x) |

El intermediario SLM **reduce a la mitad la relevancia temprana** (M3, M4 y M5
caen ~45-48%) y **multiplica la latencia por 4.45**. A cambio, gana 23.8% en
cobertura multi-hop (M6). Es la misma tension que reportaba el analisis anterior,
pero ahora sin el ruido del bug per-estrategia.

## Delta por estrategia (esto es lo nuevo e importante)

| Estrategia | M3 det.->SLM | M4 det.->SLM | M5 det.->SLM | M6 det.->SLM | M7 factor |
|---|---:|---:|---:|---:|---:|
| `hybrid` | 0.167->0.033 (-80%) | 0.080->0.017 (-79%) | 0.411->0.072 (-82%) | 0.113->0.110 (-3%) | 4.54x |
| `ictd`   | 0.233->0.200 (-14%) | 0.109->0.094 (-14%) | 0.685->0.578 (-16%) | 0.234->0.199 (-15%) | 4.38x |
| `clcr`   | 0.200->0.033 (-83%) | 0.097->0.017 (-83%) | 0.416->0.079 (-81%) | 0.089->0.162 (+81%) | 4.42x |
| `rpr`    | 0.033->0.067 (+100%)| 0.017->0.031 (+83%) | 0.079->0.144 (+82%) | 0.075->0.163 (+116%)| 4.47x |

Lectura por familia:

- **`ictd` es de lejos la mas robusta al SLM**: solo pierde ~14-16% en M3-M5 (las
  demas se desploman ~80%). Su expansion por grafo compensa parcialmente la
  degradacion lexica de la query. Aun asi tambien pierde M6 (-15%).
- **`clcr`** cambia de naturaleza: sacrifica casi toda la precision temprana
  (-83%) pero **duplica M6 (+81%)**. Con queries difusas se vuelve un expansor
  estructural puro.
- **`hybrid`** es el peor matrimonio con el SLM: -80% en M3-M5 y **ni siquiera
  gana M6**. Su componente lexico/vectorial depende de una query nitida y el SLM
  se la degrada sin aportar cobertura de grafo.
- **`rpr`** mejora en todo, pero desde un piso pesimo (M3 0.033): su query
  determinista era mala y casi cualquier reescritura ayuda. No es una victoria del
  SLM sino una debilidad del baseline de rpr.

## Delta por repositorio

| Repo | M3 | M4 | M5 | M6 | M7 factor |
|---|---:|---:|---:|---:|---:|
| Zod | -0.150 (-75%) | -0.069 (-74%) | -0.357 (-68%) | 0.000 (0%) | 7.64x (4202 ms) |
| RxJS | -0.100 (-40%) | -0.050 (-41%) | -0.181 (-37%) | +0.045 (+16%) | 2.74x |
| Inversify | +0.025 (+100%) | +0.010 (+100%) | +0.000 (0%) | +0.047 (+112%) | 2.90x |

La perdida de M3-M5 se concentra en **Zod**, que tambien dispara la latencia
(4202 ms de media, ejecuciones de varios segundos por el SLM). **Inversify**
mejora porque su query natural determinista ya era debil (M3 0.025). RxJS queda
en medio.

## Por que degrada: forma de la `clean_query`

El SLM produjo dos patologias opuestas, ambas dañinas para un retrieval que
espera queries compactas orientadas a simbolos de codigo (ingles):

- **Sub-saneado (devuelve casi la oracion completa en espanol)**: zod-001,
  zod-002 e inversify-001 recibieron practicamente el `prompt` integro. Ej.
  zod-001 -> *"Implementa una mejora pequeña en la validacion de strings para
  permitir un helper que rechace cadenas vacias luego de aplicar trim..."*. Frente
  a la query determinista compacta en ingles, esto diluye la señal lexica/vectorial.
- **Sobre-colapso**: rxjs-002 -> `"scheduling"` para las 4 estrategias. Perdida
  total de especificidad; coincide con su fuerte caida en M3-M5.

Esto es exactamente el problema que el **semantic-profile-grounding** debe atacar:
anclar la query a terminos que existen en el proyecto para evitar tanto el
sub-saneado en espanol como el colapso a una sola palabra generica.

## Limitaciones

1. Piloto de 6 tareas. Los deltas son descriptivos; no hay prueba de significancia.
2. **M7 no es P95 definitivo**: es una observacion por celda, no las 100 rep + 5
   warmup que exige `metrics.yaml`. Ademas incluye el costo del SLM. Reportar como
   "latencia observada", no como M7 oficial.
3. El baseline determinista usa `retrieval_input.query` (ingles). Parte del delta
   es efecto idioma/forma, no solo "SLM vs no-SLM". Es la comparacion valida
   igualmente, porque representa el pipeline real (prompt en NL -> sanitizer).

## Conclusion para la tesis

Con el sanitizer congelado por tarea y el naming corregido, el hallazgo se
sostiene y se afina: reemplazar el contrato determinista por el intermediario SLM
**no mejora la relevancia temprana** (M3/M4/M5 -45%) y **cuadruplica la latencia**,
aportando solo una ganancia parcial de cobertura multi-hop (M6 +24%) concentrada
en `clcr` y `rpr`. El efecto depende fuertemente de la estrategia: `ictd` resiste,
`hybrid` colapsa. La causa raiz es la forma de la `clean_query` que produce el SLM
(espanol largo o colapso a una palabra), lo que motiva el grounding basado en el
Project Semantic Profile como siguiente paso.
</content>
</invoke>
