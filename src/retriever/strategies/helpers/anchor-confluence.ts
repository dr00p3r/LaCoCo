/**
 * Anchor confluence — puntuación de nodos por CONECTIVIDAD tipada entre anclas.
 *
 * Motivación (reparación de programas): el edit-site suele ser el nodo que
 * CONECTA los síntomas — un punto de articulación, una dependencia compartida o
 * un ancestro común de los símbolos que la query toca. En vez de esparcir masa
 * desde las anclas (difusión/voto/proximidad), este helper puntúa cada nodo por
 * cuánto yace en los caminos más cortos ENTRE pares de anclas, sobre un grafo
 * NO dirigido con costo de arista tipado (aristas de la dimensión relevante a la
 * intención son "más baratas" → los caminos prefieren la dimensión correcta).
 *
 * Puro y determinista: sin I/O, sin aleatoriedad.
 */

export interface WeightedEdge {
  a: string;
  b: string;
  /** Costo NO negativo (Dijkstra). Menor = conexión más fuerte/relevante. */
  weight: number;
}

export interface ConfluenceAnchor {
  id: string;
  score: number;
}

export interface ConfluenceOptions {
  /** Decaimiento por longitud del camino: contribución × pathDecay^hopCount. */
  pathDecay: number;
  /** Fuerza de la penalización por grado incidente (hub). 0 = desactivada. */
  hubDampening: number;
}

interface Adjacency {
  get(node: string): ReadonlyArray<{ to: string; weight: number }> | undefined;
}

/** Min-heap binario sobre (prioridad, nodo). Suficiente para Dijkstra. */
class MinHeap {
  private readonly heap: Array<{ key: number; node: string }> = [];

  get size(): number {
    return this.heap.length;
  }

  push(key: number, node: string): void {
    const heap = this.heap;
    heap.push({ key, node });
    let index = heap.length - 1;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (heap[parent]!.key <= heap[index]!.key) break;
      [heap[parent], heap[index]] = [heap[index]!, heap[parent]!];
      index = parent;
    }
  }

  pop(): { key: number; node: string } | undefined {
    const heap = this.heap;
    const top = heap[0];
    if (top === undefined) return undefined;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let index = 0;
      for (;;) {
        const left = 2 * index + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && heap[left]!.key < heap[smallest]!.key) smallest = left;
        if (right < heap.length && heap[right]!.key < heap[smallest]!.key) smallest = right;
        if (smallest === index) break;
        [heap[smallest], heap[index]] = [heap[index]!, heap[smallest]!];
        index = smallest;
      }
    }
    return top;
  }
}

/** Adyacencia NO dirigida; entre dos nodos conserva la arista de MENOR costo. */
export function buildUndirectedAdjacency(edges: readonly WeightedEdge[]): Map<string, { to: string; weight: number }[]> {
  const best = new Map<string, Map<string, number>>();
  const link = (from: string, to: string, weight: number): void => {
    let row = best.get(from);
    if (row === undefined) {
      row = new Map();
      best.set(from, row);
    }
    const prev = row.get(to);
    if (prev === undefined || weight < prev) row.set(to, weight);
  };
  for (const edge of edges) {
    if (edge.a === edge.b) continue;
    link(edge.a, edge.b, edge.weight);
    link(edge.b, edge.a, edge.weight);
  }
  const adjacency = new Map<string, { to: string; weight: number }[]>();
  for (const [from, row] of best) {
    adjacency.set(from, [...row].map(([to, weight]) => ({ to, weight })));
  }
  return adjacency;
}

/**
 * Dijkstra desde `source`. Devuelve distancia y predecesor por nodo (para
 * reconstruir el camino más corto hacia `source`).
 */
export function dijkstra(
  adjacency: Adjacency,
  source: string,
): { dist: Map<string, number>; prev: Map<string, string | null> } {
  const dist = new Map<string, number>([[source, 0]]);
  const prev = new Map<string, string | null>([[source, null]]);
  const settled = new Set<string>();
  const heap = new MinHeap();
  heap.push(0, source);

  while (heap.size > 0) {
    const { key, node } = heap.pop()!;
    if (settled.has(node)) continue;
    if (key > (dist.get(node) ?? Infinity)) continue;
    settled.add(node);
    for (const { to, weight } of adjacency.get(node) ?? []) {
      if (settled.has(to)) continue;
      const candidate = key + weight;
      if (candidate < (dist.get(to) ?? Infinity)) {
        dist.set(to, candidate);
        prev.set(to, node);
        heap.push(candidate, to);
      }
    }
  }
  return { dist, prev };
}

/**
 * Acumula, por cada NODO INTERNO de los caminos más cortos entre pares de anclas,
 * un score de confluencia ponderado por los scores de las anclas y decaído por la
 * longitud del camino, con penalización opcional de hubs.
 *
 * @param edges Aristas NO dirigidas con costo tipado (>= 0).
 * @param anchors Anclas semilla (se recomienda acotar a las top-M por score).
 * @param degree Grado incidente por nodo (para amortiguar hubs). Opcional.
 */
export function anchorConfluence(
  edges: readonly WeightedEdge[],
  anchors: readonly ConfluenceAnchor[],
  degree: ReadonlyMap<string, number>,
  opts: ConfluenceOptions,
): Map<string, number> {
  const confluence = new Map<string, number>();
  if (anchors.length < 2) return confluence;

  const adjacency = buildUndirectedAdjacency(edges);
  const sssp = new Map<string, ReturnType<typeof dijkstra>>();
  for (const anchor of anchors) {
    if (!sssp.has(anchor.id)) sssp.set(anchor.id, dijkstra(adjacency, anchor.id));
  }

  for (let i = 0; i < anchors.length; i++) {
    const source = anchors[i]!;
    const { dist, prev } = sssp.get(source.id)!;
    for (let j = i + 1; j < anchors.length; j++) {
      const target = anchors[j]!;
      const distance = dist.get(target.id);
      if (distance === undefined || !Number.isFinite(distance)) continue; // desconectadas

      // Reconstruye el camino target -> ... -> source siguiendo prev.
      const path: string[] = [];
      let cursor: string | null | undefined = target.id;
      let guard = 0;
      const limit = dist.size + 1;
      while (cursor !== null && cursor !== undefined && guard++ < limit) {
        path.push(cursor);
        cursor = prev.get(cursor) ?? null;
      }
      const hopCount = path.length - 1;
      if (hopCount < 2) continue; // adyacentes: no hay nodo interno que conecte

      const contribution = source.score * target.score * Math.pow(opts.pathDecay, hopCount);
      // Internos = todos menos los dos extremos (las anclas ya tienen su score).
      for (let k = 1; k < path.length - 1; k++) {
        const node = path[k]!;
        confluence.set(node, (confluence.get(node) ?? 0) + contribution);
      }
    }
  }

  if (opts.hubDampening > 0) {
    for (const [node, score] of confluence) {
      const damp = 1 + opts.hubDampening * Math.log2(1 + (degree.get(node) ?? 0));
      confluence.set(node, score / damp);
    }
  }

  return confluence;
}

/** Reciprocal Rank Fusion de varias listas rankeadas (ids en orden desc). */
export function reciprocalRankFusion(
  lists: ReadonlyArray<readonly string[]>,
  rrfK: number,
): Map<string, number> {
  const fused = new Map<string, number>();
  for (const list of lists) {
    for (let rank = 0; rank < list.length; rank++) {
      const id = list[rank]!;
      fused.set(id, (fused.get(id) ?? 0) + 1 / (rrfK + rank + 1));
    }
  }
  return fused;
}
