# Benchmark multi-repo (benchmulti) — análisis de retrieval de todas las estrategias

**Run:** `2026-07-10-benchmulti` · **Bundle:** `eval/manifests/swe-polybench-multi` ·
**Split ejecutado:** `benchvalid_{mui,svelte,prettier}` (mergeados) ·
**Cobertura real:** 14 tareas / 3 familias de repo (mui×5, svelte×5, prettier×4) × **8 estrategias
deterministas** · **Régimen:** SWE-PolyBench "easy" `is_func_only && num_nodes==1` (single-hop).

> Nota de alcance honesta: el plan apuntaba a 22 instancias / 5 familias (+ serverless×5,
> code-server×2). El indexado por embedding (Jina 768d) de esos repos nuevos **no se completó en
> este entorno** — procesos largos (>2–3 min) son terminados (foreground topa a 2 min; los jobs de
> background se matan). serverless/code-server prepararon bien (clone-reuse validado) pero su
> `index_vectors` no pudo correr a término. mui/svelte/prettier ya tenían índice de bench15.
> vscode/three.js/angular quedaron fuera por ser gigantes asset-heavy (costo de infra, no retrieval).

## 1. Resultado por estrategia (macro por tarea → macro por repo, 14 tareas)

| Estrategia | EditSiteHit@10 | MRR | ExternalNoiseRate |
|---|---:|---:|---:|
| **clcr** | 0.571 | **0.381** | 0.071 |
| **connector (SCR)** | 0.571 | 0.341 | 0.036 |
| hybrid | 0.571 | 0.341 | 0.043 |
| repograph | 0.571 | 0.341 | 0.043 |
| consensus | 0.571 | 0.322 | 0.021 |
| ictd | 0.500 | 0.274 | 0.043 |
| ppr | 0.429 | 0.173 | 0.093 |
| rpr | 0.214 | 0.050 | **0.500** |

Global EditSiteHit@10 = 0.50 · MRR = 0.278 (14 tareas, 112 celdas).

## 2. Matriz repo × estrategia (EditSiteHit@10; 1=hit, 0=miss)

```
repo                 hybr ictd clcr  rpr cons repo  ppr conn
material-ui-11451       1    1    1    1    1    1    1    1
material-ui-11858       1    1    1    0    1    1    1    1
material-ui-12406       1    1    1    0    1    1    1    1
material-ui-13690       1    1    1    1    1    1    1    1
material-ui-13778       0    0    0    0    0    0    0    0   ← todos 0
prettier-12930          0    0    0    0    0    0    0    0   ← todos 0
prettier-14400          0    1    1    0    0    0    0    0   (parcial)
prettier-4667           1    1    1    0    1    1    0    1
prettier-5025           0    0    0    0    0    0    0    0   ← todos 0
svelte-510              1    1    1    0    1    1    1    1
svelte-728              0    0    0    0    0    0    0    0   ← todos 0
svelte-906              1    1    1    0    1    1    1    1
svelte-1116             1    1    1    1    1    1    1    1
svelte-907              0    0    0    0    0    0    0    0   ← todos 0
```

## 3. Hallazgos

**H1 — En single-hop, connector NO se separa de los baselines fuertes.** connector, hybrid, clcr,
consensus y repograph **empatan** en EditSiteHit (0.571) y aciertan/fallan **juntos** repo por repo.
Es esperable y **inherente al régimen**: cuando el gold es un único nodo `num_nodes==1`, el gold
suele SER el ancla (lo encuentra ya el BM25+ANN+RRF de `hybrid`); la expansión de grafo — el
mecanismo propio de connector (conectividad tipada entre anclas) — **no tiene multi-hop que
resolver**. El delta documentado de connector estaba en `mh12` (multi-hop). *Este benchmark, tal
cual, no ejercita la hipótesis de connector.* (clcr saca un pelín más de MRR por su cascade cross-layer.)

**H2 — El cuello de botella está en el ANCLAJE compartido, no en la expansión.** 5 repos dan **0 en
las 8 estrategias** (mui-13778, prettier-12930/5025, svelte-728/907). Diagnóstico por celda:
- `svelte-728`: gold `Component.ts` **ausente** de los 30 candidatos de connector (rank −1).
- `mui-13778`: gold `ModalManager.js` **ausente** (top-5 = símbolos `styles` de otros componentes).
- `prettier-14400`: gold `language-html/utils/index.js` **ausente** (top-5 = format/printer).
- `svelte-907`: gold `Generator.ts` **presente pero en rank 16** (>K=10).

Como las 8 estrategias comparten el BM25+ANN+RRF, un gold ausente del pool de anclas **no puede ser
rescatado por ninguna** expansión — salvo que connector lo inyecte por conectividad, cosa que aquí no
ocurrió (el gold no cae en un camino mínimo entre dos anclas dentro del presupuesto de hops).

**H3 — rpr es el perdedor claro y por causa inherente.** EditSiteHit 0.214 y **ExternalNoiseRate
0.50**: su caminata relacional termina en nodos externos (`lib#…`), ensuciando el top-K. Es una
propiedad del mecanismo, no un knob. ppr también flojea (ranking difuso por centralidad agnóstica a
intención).

## 4. Taxonomía: ARREGLABLE vs INHERENTE

| Caso | Evidencia | Clase | Acción |
|---|---|---|---|
| Empate connector≈baselines | single-hop, gold=ancla | **INHERENTE al régimen** | Correr split **multi-hop** (`--only-mixed`, num_nodes 2–4) donde el mecanismo aplica |
| svelte-907 gold@16 | en pool, rank>K | **ARREGLABLE** | mejor ranking / K mayor / re-ranqueo por confluencia |
| svelte-728, mui-13778, prettier-14400 gold ausente | no en 25–30 anclas | **ARREGLABLE (anclaje)** | recall del ancla: HyDE, query-expansion, `LACOCO_ANN_OVERFETCH`, embedding |
| mui-13778 símbolo | `removeContainerStyle` en `ModalManager.js` no aflora | **ARREGLABLE (gold/index)** | verificar indexado del `.js` (override `.d.ts` ya aplicado); posible artefacto de traducción |
| rpr ExternalNoiseRate 0.5 | termina en `lib#` | **INHERENTE (parcial)** | filtro de externos mitiga, pero el sesgo del walk es del mecanismo |
| ppr ranking débil | centralidad agnóstica | **INHERENTE (parcial)** | es el punto de la tesis: consenso estructural > PageRank agnóstico |

## 5. Recomendaciones (priorizadas)

1. **Correr un split multi-hop** para que el benchmark discrimine: reimportar con `--only-mixed`
   (num_nodes 2–4) o reusar `swe-polybench-mh12`, y comparar las 8 estrategias ahí. Es el cambio
   #1 — el single-hop es ciego a connector por diseño.
2. **Atacar el recall del anclaje** (afecta a las 8 por igual): A/B con `LACOCO_ANN_OVERFETCH∈{1,3}`
   y HyDE sobre los 4 repos de gold-ausente; es la palanca de mayor techo (5/14 = 0 vienen de aquí).
3. **Completar la cobertura de repos** (serverless/code-server) en un entorno que sostenga el
   `index_vectors` — el bundle, el split y el mecanismo de clone-reuse ya están listos.
4. Revisar los golds `=0` (mui-13778, prettier-12930/5025) por artefacto de traducción símbolo→nodo
   antes de contarlos como fallos de retrieval.

## 6. Estado de infraestructura entregado

- **Reutilización de clones** (Parte A): mirror blobless por URL + `git clone --reference
  --filter=blob:none --no-checkout` + fast-path (skip fetch si HEAD==ref). Implementado y testeado
  (16/16 en `git.test.ts`); validado end-to-end en serverless/code-server (objetos compartidos vía
  `alternates`, `.git` sigue directorio, checkout correcto). Rescata el problema de N clones por URL.
- **Bundle** `swe-polybench-multi` (Parte B): 39 tareas importadas (override `.d.ts` para mui),
  splits `benchmulti`/`benchvalid*`, 8 estrategias, manifests validados.
