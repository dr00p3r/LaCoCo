# LaCoCo — Retrieval Proposals & Design Considerations

---

## Proposal 1: ICTD (Intent-Conditioned Tensor Diffusion)

**Status:** Implemented (`src/retriever/strategies/ictd-strategy.ts`, CLI flag `--strategy ictd`)

### Summary

Relevance diffuses from BM25 anchor nodes through the 3-layer tensor (SYS/CPG/DTG),
weighted by query intent. Nodes with the highest final temperature form the
retrieved context.

### Algorithm

1. Compute per-dimension weights from `query.intent` + dimension hints
2. Identify anchors via BM25 on `query.clean_query` (top 30)
3. Bidirectional BFS from anchors (max 2 hops) to build local subgraph
4. Initialize heat vector with normalized BM25 scores on anchors; rest = 0
5. Iterative diffusion (max 10 iterations, ε = 1e-6):
   - Each edge propagates heat proportionally to its dimension weight
   - Bidirectional: `u → v` (forward) and `v → u` (backward) both contribute
   - Forward normalization: per-dimension out-degree of source node
   - Backward normalization: per-dimension in-degree of target node
   - Restart probability α = 0.20 teleports heat back to anchors
6. Rank by final temperature, return top 50 as ContextChunks

### Intent → Dimension Weight Mapping

```
debug:      SYS=0.30  CPG=0.40  DTG=0.30   (trace execution + data flow)
refactor:   SYS=0.40  CPG=0.40  DTG=0.20   (structural + control)
create:     SYS=0.50  CPG=0.30  DTG=0.20   (ecosystem fit)
integrate:  SYS=0.30  CPG=0.20  DTG=0.50   (package + data flow)
understand: SYS=0.35  CPG=0.35  DTG=0.30   (balanced)
unknown:    SYS=0.34  CPG=0.33  DTG=0.33   (balanced)
```

Dimension hints from `query.dimensions` boost matching dims ×1.5 before
re-normalization to sum=1.

### Configuration (tunable via constructor)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `anchorLimit` | 30 | Max BM25 anchors for seeding |
| `maxIterations` | 10 | Max diffusion iterations |
| `restartProb` (α) | 0.20 | Anchor teleport probability |
| `epsilon` | 1e-6 | Convergence threshold |
| `chunkLimit` | 50 | Max chunks returned |
| `bfsMaxNodes` | 5000 | BFS subgraph node cap |
| `maxHops` | 2 | BFS depth from anchors |

### Considerations

- **α (restart probability):** 0.20 means 20% of heat returns to anchors each
  iteration. Lower α (0.10–0.15) spreads farther from anchors; higher α
  (0.25–0.30) stays more local. Tunable via constructor config.

- **LanceDB anchor enhancement:** Currently BM25-only. A future variant could
  use LanceDB ANN + RRF fusion (like HybridStrategy) for richer anchor seeds,
  then run the same tensor diffusion. This would add an optional `LaCoCoLanceDb`
  dependency to the constructor.

- **Bidirectional vs directional:** Bidirectional diffusion (heat flows both
  `u→v` and `v→u`) captures richer structural context but may dilute signal on
  high-degree hub nodes. If precision degrades with large graphs, consider
  switching to directional (source→target only) or adding a degree-based damping
  factor.

- **Intent weight mapping:** The current mapping is heuristic. A data-driven
  approach could tune weights via grid search over benchmark metrics
  (Recall@K, Context Precision) on labeled queries.

- **BFS depth:** Currently 2 hops. Most codebases have graph diameters in the
  3–6 range, so 2 hops captures enough neighborhood for meaningful diffusion
  without explosive node growth. Configurable if needed.

- **In-degree normalization for backward flow:** When heat diffuses backward
  (target → source), it's normalized by the target's in-degree per dimension,
  ensuring high in-degree nodes (e.g., widely-used utility functions) don't
  disproportionately dominate the diffusion.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No anchors found (BM25 returns 0) | Return empty chunks |
| BFS yields 0 edges (orphan anchors) | Anchors returned as-is, source="ICTD" |
| Single anchor | Diffusion includes anchor + 1-hop neighbors |
| BFS exceeds `bfsMaxNodes` | Truncated; warning via console.warn |
| All dims zero weight | Fallback to uniform (1/3, 1/3, 1/3) |
| Convergence reached before maxIter | Early exit, no wasted computation |

---

## Proposal 2: CLCR (Cross-Layer Cascade Retrieval)

**Status:** Implemented (`src/retriever/strategies/clcr-strategy.ts`, CLI flag `--strategy clcr`)

### Summary

Los nodos que conectan múltiples dimensiones del tensor (SYS/CPG/DTG) representan
dependencias críticas que un retrieval puramente textual no detecta. CLCR identifica
estos puentes cross-layer mediante expansión por capas: una capa primaria (dominante
según el intent) se expande 2 hops, y desde ella se hace cascade hacia las otras
2 dimensiones (1 hop c/u). Los nodos alcanzados desde múltiples capas reciben
un boost proporcional.

### Algorithm

1. Determinar dimensión dominante = argmax(intent→weights)
2. Anchors via BM25 on `query.clean_query` (top 30)
3. **Capa primaria:** BFS desde anchors usando solo edges de la dim dominante
   (2 hops). Puntajes base propagados con decaimiento: score × 0.5^hop.
4. **Cascade:** Desde el conjunto primario, BFS de 1 hop usando edges de
   cada dimensión no-dominante. Se registra qué dims alcanzan cada nodo.
5. **Cross-layer count:** Para cada nodo, contar en cuántas dimensiones
   distintas tiene edges (incoming + outgoing), consultando la tabla `edges`.
   Mínimo = 1 (la capa dominante).
6. **Boost:** `finalScore = baseScore × (1 + λ × (layerCount − 1))`, λ = 0.25
7. Top 50 por finalScore → ContextChunks

| Layer count | Boost (λ=0.25) |
|-------------|----------------|
| 1 dim | ×1.00 |
| 2 dims | ×1.25 |
| 3 dims | ×1.50 |

### Intent → Dominant Dimension

```
debug:      CPG (trace execution flow)
refactor:   CPG (control + structural)
create:     SYS (ecosystem fit)
integrate:  DTG (package + data flow)
understand: highest weight dimension
unknown:    CPG (fallback)
```

### Configuration (tunable via constructor)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `anchorLimit` | 30 | Max BM25 anchors for seeding |
| `primaryHops` | 2 | BFS depth in dominant dimension |
| `cascadeHops` | 1 | BFS depth in non-dominant dimensions |
| `chunkLimit` | 50 | Max chunks returned |
| `bfsMaxNodes` | 5000 | Total node cap across all phases |
| `lambda` (λ) | 0.25 | Cross-layer boost coefficient |

### Considerations

- **λ (boost coefficient):** 0.25 gives moderate preference to bridge nodes
  (+25% for 2-layer, +50% for 3-layer). Lower λ (0.10–0.15) keeps the
  ranking closer to BM25 baseline; higher λ (0.35–0.50) strongly favors
  cross-layer hubs. Tunable via constructor config.

- **Primary vs cascade depth:** Primary layer gets 2 hops for thorough
  expansion in the dominant dimension. Cascade layers get only 1 hop to
  target immediate bridge connections. If recall is low, increasing
  cascade hops or primary hops may help at the cost of noise.

- **Cross-layer counting:** CLCR queries the original `edges` table to count
  distinct dimensions per node, which is an additional SQL cost proportional
  to the number of discovered nodes. For very large subgraphs, this can
  be the dominant cost. A cached/materialized per-node dimension count
  in `node_metadata` would eliminate this query.

- **Dominant dimension selection:** Same `INTENT_WEIGHTS` mapping as ICTD
  for consistency. The dominant dimension drives the primary BFS; all 3
  dimensions are explored in total, just with different depth budgets.

- **LanceDB anchor enhancement:** Same future option as ICTD — could use
  hybrid anchors before the cascade, without changing the core algorithm.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No anchors (BM25 returns 0) | Return `[]` |
| 0 edges in dominant dim | Anchors returned as-is, layerCount=1, ×1.0 |
| Cascade reaches 0 new nodes | Only primary nodes scored; some may already be bridge nodes |
| BFS exceeds `bfsMaxNodes` | Truncate; no new nodes beyond cap |
| Node with 0 edges in DB | layerCount = 1, receives no cross-layer boost |

---

## Proposal 3: RPR (Relational Path Retrieval)

**Status:** Implemented (`src/retriever/strategies/rpr-strategy.ts`, CLI flag `--strategy rpr`)

### Summary

En generación de código, el significado rara vez está en nodos aislados; está en
las secuencias de relaciones que los conectan. RPR recupera trayectorias relacionales
completas como unidad de contexto, no nodos independientes.

### Algorithm

1. Anchors via BM25 on `query.clean_query` (top 30)
2. Subgrafo local via BFS bidireccional (2 hops, como ICTD), almacenando solo
   aristas salientes (source→target) para enumeración de caminos dirigidos
3. DFS desde cada anchor (maxDepth=3, sin ciclos, solo salientes) → caminos
4. Scoring: `pathScore = avgNodeRelevance × uniqueDims`
   - `avgNodeRelevance`: media de relevancias de nodos del camino
   - `uniqueDims`: cuántas dimensiones distintas cruza el camino (1–3)
5. Deduplicación por hash de camino (`n₀→n₁→...|rel₁,rel₂,...`)
6. Top 50 caminos → ContextChunks con trayectoria completa como texto

### Path Scoring

| uniqueDims | Boost | Interpretación |
|------------|-------|----------------|
| 1 | ×1.0 | Camino monocapa — sin bonus estructural |
| 2 | ×2.0 | Cruza una frontera dimensional |
| 3 | ×3.0 | Atraviesa las 3 capas — máxima riqueza |

Sin hiperparámetros de scoring. La fórmula es `avgNodeRelevance × uniqueDims`,
la más simple posible.

### Chunk Text Format

```
OrderController.create --CALLS--> PaymentService.process --PRODUCES--> PaymentResult | dims: CPG→DTG | relations: CALLS, PRODUCES
```

Cada chunk incluye la trayectoria completa, dimensiones cruzadas y relaciones
involucradas, para que el LLM entienda no solo *qué* nodos son relevantes sino
*cómo se conectan*.

### Configuration (tunable via constructor)

| Parameter | Default | Description |
|-----------|---------|-------------|
| `anchorLimit` | 30 | Max BM25 anchors |
| `subgraphMaxHops` | 2 | BFS depth para subgrafo local |
| `bfsMaxNodes` | 5000 | Cap de nodos en subgrafo |
| `maxDepth` | 3 | Aristas máximas en cada camino |
| `maxCandidates` | 5000 | Cap total de caminos enumerados |
| `chunkLimit` | 50 | Máximo de chunks retornados |
| `decayPerHop` | 0.5 | Decaimiento de relevancia por salto |

### Considerations

- **Scoring minimal:** `avgNodeRelevance × uniqueDims` es la formulación más
  simple posible. Si experimentos muestran que el boost ×2 y ×3 es demasiado
  agresivo para dimensiones altas, suavizar con:
  - `ln(1 + uniqueDims)` → boosts ~0.69 / 1.10 / 1.39 (rendimientos decrecientes)
  - `1 + (uniqueDims − 1) × λ` con λ=0.5 → boosts 1.0 / 1.5 / 2.0
  La ventaja de empezar con la fórmula más simple es que los hiperparámetros
  pueden añadirse después si los datos lo piden, no antes.

- **LanceDB anchor enhancement:** Actualmente BM25-only. Una variante futura
  podría usar embeddings + ANN para enriquecer los anchors iniciales antes de
  la enumeración de caminos, sin modificar el algoritmo core.

- **Solo salientes:** Los caminos siguen la dirección de las aristas
  (source→target), preservando causalidad semántica (CALLS, PRODUCES,
  IMPLEMENTS tienen direccionalidad). Explorar caminos bidireccionales
  duplicaría combinatoria y mezclaría causalidades.

- **Subgrafo compartido:** El BFS construye un único subgrafo alrededor de
  todos los anchors, permitiendo que caminos conecten anchors distintos.
  Sin esto, `CheckoutController → PaymentService → StripeService` no podría
  descubrirse si StripeService no está en el vecindario de CheckoutController.

- **Depth=3:** Captura patrones arquitectónicos (ej. Controller→Service→Repo→Entity)
  sin introducir ruido. Depth=4+ suele diluir la relevancia semántica.

### Edge Cases

| Scenario | Behavior |
|----------|----------|
| No anchors (BM25 returns 0) | Return `[]` |
| No outgoing edges from any anchor | Anchors returned as individual chunks |
| BFS exceeds `bfsMaxNodes` | Subgrafo truncado; warning vía console.warn |
| DFS exceeds `maxCandidates` | Enumeración truncada tras alcanzar el cap |
| Anchor sin aristas salientes | Se omite en DFS; otros anchors siguen |
| Camino idéntico generado desde anchors distintos | Deduplicado por hash, se conserva el de mayor score |

---

> Last updated: 2026-06-07

