import type { GraphEdge } from "../../../persistence/lacoco-graph-manager/model/types.js";

export interface PageRankOptions {
  /** Factor de amortiguación (probabilidad de seguir una arista vs reiniciar). Canónico: 0.85. */
  damping: number;
  /** Tope de iteraciones de la caminata de potencia. */
  iterations: number;
  /** Corte por convergencia: para cuando el cambio L1 entre iteraciones cae bajo este umbral. */
  tolerance: number;
}

/**
 * PageRank personalizado (Personalized PageRank) sobre un grafo DIRIGIDO.
 *
 * El rango fluye `source -> target` a lo largo de las aristas. En cada paso, con
 * probabilidad `damping` la masa se distribuye uniformemente entre los sucesores
 * de un nodo; con probabilidad `1 - damping` (y desde nodos COLGANTES sin
 * sucesores) reinicia hacia el vector de personalización. Sesgar la
 * personalización hacia las anclas (query-hits) convierte esto en la centralidad
 * condicionada a la query del repo-map de Aider, pero sobre aristas del compilador.
 *
 * Determinista: sin números aleatorios, mismo grafo + misma personalización → mismo
 * resultado. Puro: no toca I/O ni estado externo.
 *
 * @param nodes Universo de nodos del subgrafo (incluye anclas y vecinos).
 * @param edges Aristas dirigidas; se ignoran las que apuntan fuera de `nodes`.
 * @param personalization Vector de reinicio (p. ej. score de cada ancla). Se
 *   normaliza a suma 1 internamente. Si está vacío o suma 0, se usa el uniforme.
 * @returns Score PageRank por nodo (suma ≈ 1 sobre `nodes`).
 */
export function personalizedPageRank(
  nodes: readonly string[],
  edges: readonly GraphEdge[],
  personalization: ReadonlyMap<string, number>,
  options: PageRankOptions,
): Map<string, number> {
  const result = new Map<string, number>();
  const n = nodes.length;
  if (n === 0) return result;

  const nodeSet = new Set(nodes);

  // Sucesores por nodo (solo aristas internas al subgrafo).
  const successors = new Map<string, string[]>();
  for (const id of nodes) successors.set(id, []);
  for (const edge of edges) {
    if (edge.sourceId === edge.targetId) continue; // sin auto-lazos
    if (!nodeSet.has(edge.sourceId) || !nodeSet.has(edge.targetId)) continue;
    successors.get(edge.sourceId)!.push(edge.targetId);
  }

  // Vector de personalización / reinicio, normalizado a suma 1.
  const restart = normalizeRestart(nodes, personalization);

  // Distribución inicial = reinicio (arranca donde apuntan las anclas).
  let rank = new Map(restart);

  for (let iteration = 0; iteration < options.iterations; iteration++) {
    const next = new Map<string, number>();
    for (const id of nodes) next.set(id, 0);

    // Masa colgante: nodos sin sucesores reparten toda su masa vía reinicio.
    let dangling = 0;
    for (const id of nodes) {
      const outs = successors.get(id)!;
      const mass = rank.get(id) ?? 0;
      if (outs.length === 0) {
        dangling += mass;
        continue;
      }
      const share = (options.damping * mass) / outs.length;
      for (const target of outs) next.set(target, (next.get(target) ?? 0) + share);
    }

    // Teletransporte: (1 - damping) del total + toda la masa colgante amortiguada,
    // repartidos según el vector de reinicio.
    const teleport = 1 - options.damping + options.damping * dangling;
    for (const id of nodes) {
      next.set(id, (next.get(id) ?? 0) + teleport * (restart.get(id) ?? 0));
    }

    // Convergencia: cambio L1 respecto de la iteración previa.
    let delta = 0;
    for (const id of nodes) delta += Math.abs((next.get(id) ?? 0) - (rank.get(id) ?? 0));
    rank = next;
    if (delta < options.tolerance) break;
  }

  return rank;
}

/**
 * Normaliza el vector de reinicio a suma 1 sobre `nodes`. Ignora entradas fuera de
 * `nodes` o no positivas. Sin masa útil → uniforme (PageRank global).
 */
function normalizeRestart(
  nodes: readonly string[],
  personalization: ReadonlyMap<string, number>,
): Map<string, number> {
  const restart = new Map<string, number>();
  let total = 0;
  for (const id of nodes) {
    const weight = personalization.get(id) ?? 0;
    if (weight > 0) {
      restart.set(id, weight);
      total += weight;
    }
  }

  if (total <= 0) {
    const uniform = 1 / nodes.length;
    for (const id of nodes) restart.set(id, uniform);
    return restart;
  }

  for (const id of nodes) restart.set(id, (restart.get(id) ?? 0) / total);
  return restart;
}
