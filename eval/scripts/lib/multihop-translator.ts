/**
 * multihop-translator.ts
 *
 * Deriva nodos multihop (distancia >= 2 del primary_anchor) directamente
 * desde la base de datos del grafo LaCoCo (tensor.sqlite) usando BFS
 * sobre aristas filtradas por tipo. Es la fuente de verdad para el campo
 * `multihop_nodes` cuando `multihop_status: "auto"` en tasks.yaml.
 *
 * Contrato:
 *  - BFS no dirigido sobre la tabla `edges` filtrada por `relation IN (...)`.
 *  - Excluye el propio anchor y todos los nodos a distancia < depthMin.
 *  - Ordena los candidatos por degree centrality dentro de los
 *    alcanzables (top-K estable) y emite los K mejores.
 *  - Devuelve IDs repo-relativos (formato "<relpath>#<symbol>") para
 *    portabilidad del manifest entre maquinas.
 *  - Si no encuentra nada, devuelve []; el caller decide el status.
 *
 * Por que no usar EdgeDao directamente: el BFS requiere multiples
 * saltos y un filtro por relation consistente. EdgeDao.getBfsNeighbors
 * (`src/persistence/lacoco-graph-manager/dao/edge-dao.ts:74-83`) es
 * 1-hop sin filtro, y getNeighborhood no soporta depth. Hacer el BFS
 * en SQL puro (CTE recursivo) es mas simple y portable.
 */

import Database, { type Database as DatabaseType } from "better-sqlite3";
import { isAbsolute, join } from "node:path";

/** Default edge kinds: CALLS + REFERENCES + DECLARES (1 CPG + 1 DTG + 1 CPG). */
export const DEFAULT_MULTIHOP_EDGE_KINDS: readonly string[] = [
  "CALLS",
  "REFERENCES",
  "DECLARES",
] as const;

export interface ExtractMultihopOptions {
  /** Ruta absoluta al tensor.sqlite del repo. */
  dbPath: string;
  /** Anchor en formato repo-relativo ("src/foo.ts#Foo") o absoluto. */
  primaryAnchor: string;
  /** Ruta absoluta al repo, para convertir anchor relativo -> absoluto. */
  repoPath: string;
  /** Tipos de arista a seguir. Default: CALLS, REFERENCES, DECLARES. */
  edgeKinds?: readonly string[];
  /** Distancia minima (inclusiva). Default: 2 (multihop estricto). */
  depthMin?: number;
  /** Distancia maxima (inclusiva). Default: 3 (cap para evitar explosion). */
  depthMax?: number;
  /** Numero maximo de nodos a devolver. Default: 5. */
  topK?: number;
  /** Nodos a excluir ademas del anchor (ej. relevant_nodes para no repetir). */
  excludeNodes?: readonly string[];
}

export interface MultihopCandidate {
  nodeId: string;
  distance: number;
  degree: number;
}

export interface MultihopExtractionResult {
  /** IDs repo-relativos de los top-K nodos multihop (puede ser vacio). */
  multihopNodes: string[];
  /** Todos los candidatos antes del top-K, ordenados por (distance, -degree). */
  candidates: MultihopCandidate[];
  /** Numero de saltos BFS ejecutados. */
  hopsExplored: number;
  /** Anchor en formato absoluto que se uso para el BFS. */
  resolvedAnchor: string;
}

/**
 * Convierte un node-id (relativo o absoluto) a absoluto respecto a repoPath.
 * Si ya es absoluto, no lo toca.
 */
function resolveToAbsolute(nodeId: string, repoPath: string): string {
  const hashIndex = nodeId.indexOf("#");
  const pathPart = hashIndex === -1 ? nodeId : nodeId.slice(0, hashIndex);
  const symbolPart = hashIndex === -1 ? "" : nodeId.slice(hashIndex);
  if (isAbsolute(pathPart)) return nodeId;
  return `${join(repoPath, pathPart)}${symbolPart}`;
}

/** Convierte un node-id absoluto a repo-relativo respecto a repoPath. */
function toRelative(nodeId: string, repoPath: string): string {
  const hashIndex = nodeId.indexOf("#");
  const pathPart = hashIndex === -1 ? nodeId : nodeId.slice(0, hashIndex);
  const symbolPart = hashIndex === -1 ? "" : nodeId.slice(hashIndex);
  if (isAbsolute(pathPart) && pathPart.startsWith(`${repoPath}/`)) {
    return `${pathPart.slice(repoPath.length + 1)}${symbolPart}`;
  }
  // Si no es absoluto o no empieza con repoPath, devolver tal cual
  // (el caller puede decidir si esto es un error).
  return nodeId;
}

/**
 * BFS recursivo en SQL usando un Common Table Expression. Mucho mas
 * eficiente que iterar en TypeScript hop por hop, y respeta el
 * filtro `relation IN (...)` en cada nivel.
 *
 * Devuelve un Map<nodeId, distance> para todos los alcanzables hasta
 * maxHops. El anchor se incluye con distancia 0.
 */
function bfsWithEdgeFilter(
  db: DatabaseType,
  anchor: string,
  edgeKinds: readonly string[],
  maxHops: number,
): Map<string, number> {
  // Parametrizar edgeKinds como placeholders.
  const placeholders = edgeKinds.map(() => "?").join(",");
  const query = `
    WITH RECURSIVE bfs(nodeId, distance) AS (
      SELECT ?, 0
      UNION ALL
      SELECT
        CASE WHEN e.sourceId = bfs.nodeId THEN e.targetId ELSE e.sourceId END,
        bfs.distance + 1
      FROM bfs
      JOIN edges e ON (e.sourceId = bfs.nodeId OR e.targetId = bfs.nodeId)
      WHERE bfs.distance < ?
        AND e.relation IN (${placeholders})
    )
    SELECT nodeId, MIN(distance) AS distance
    FROM bfs
    GROUP BY nodeId
  `;
  const stmt = db.prepare(query);
  const rows = stmt.all(anchor, maxHops, ...edgeKinds) as Array<{
    nodeId: string;
    distance: number;
  }>;
  const distances = new Map<string, number>();
  for (const row of rows) {
    distances.set(row.nodeId, row.distance);
  }
  return distances;
}

/**
 * Calcula degree centrality (undirected) de un conjunto de nodos usando
 * una sola query. Devuelve Map<nodeId, degree>.
 */
function degreeOf(
  db: DatabaseType,
  nodeIds: readonly string[],
  edgeKinds: readonly string[],
): Map<string, number> {
  if (nodeIds.length === 0) return new Map();
  const placeholders = nodeIds.map(() => "?").join(",");
  const edgePlaceholders = edgeKinds.map(() => "?").join(",");
  const query = `
    SELECT nodeId, COUNT(*) AS degree
    FROM (
      SELECT sourceId AS nodeId FROM edges
        WHERE targetId IN (${placeholders}) AND relation IN (${edgePlaceholders})
      UNION ALL
      SELECT targetId AS nodeId FROM edges
        WHERE sourceId IN (${placeholders}) AND relation IN (${edgePlaceholders})
    )
    WHERE nodeId IN (${placeholders})
    GROUP BY nodeId
  `;
  const stmt = db.prepare(query);
  const rows = stmt.all(
    ...nodeIds,
    ...edgeKinds,
    ...nodeIds,
    ...edgeKinds,
    ...nodeIds,
  ) as Array<{ nodeId: string; degree: number }>;
  const out = new Map<string, number>();
  for (const id of nodeIds) out.set(id, 0);
  for (const row of rows) out.set(row.nodeId, row.degree);
  return out;
}

export function extractMultihopFromGraph(
  options: ExtractMultihopOptions,
): MultihopExtractionResult {
  const edgeKinds = options.edgeKinds ?? DEFAULT_MULTIHOP_EDGE_KINDS;
  const depthMin = options.depthMin ?? 2;
  const depthMax = options.depthMax ?? 3;
  const topK = options.topK ?? 5;
  const exclude = new Set<string>(options.excludeNodes ?? []);

  if (edgeKinds.length === 0) {
    throw new Error("extractMultihopFromGraph: edgeKinds must contain at least one kind");
  }
  if (depthMin < 1) {
    throw new Error("extractMultihopFromGraph: depthMin must be >= 1");
  }
  if (depthMax < depthMin) {
    throw new Error("extractMultihopFromGraph: depthMax must be >= depthMin");
  }
  if (topK < 1) {
    throw new Error("extractMultihopFromGraph: topK must be >= 1");
  }

  const resolvedAnchor = resolveToAbsolute(options.primaryAnchor, options.repoPath);
  // Tambien excluimos el anchor (en su forma absoluta) y los nodos
  // excluidos (en ambas formas para tolerar mezclas).
  const excludeAbs = new Set<string>([resolvedAnchor]);
  for (const id of exclude) {
    excludeAbs.add(id);
    excludeAbs.add(resolveToAbsolute(id, options.repoPath));
  }

  const db = new Database(options.dbPath, { readonly: true, fileMustExist: true });
  try {
    const distances = bfsWithEdgeFilter(db, resolvedAnchor, edgeKinds, depthMax);
    // Filtrar distancia >= depthMin y excluir anchor / exclude.
    const candidateAbs: MultihopCandidate[] = [];
    for (const [nodeId, distance] of distances) {
      if (distance < depthMin) continue;
      if (excludeAbs.has(nodeId)) continue;
      candidateAbs.push({ nodeId, distance, degree: 0 });
    }
    if (candidateAbs.length === 0) {
      return {
        multihopNodes: [],
        candidates: [],
        hopsExplored: depthMax,
        resolvedAnchor,
      };
    }
    // Computar degree centrality solo para los candidatos.
    const degrees = degreeOf(
      db,
      candidateAbs.map((c) => c.nodeId),
      edgeKinds,
    );
    for (const candidate of candidateAbs) {
      candidate.degree = degrees.get(candidate.nodeId) ?? 0;
    }
    // Orden: (distance ASC, degree DESC) y desempate estable por nodeId.
    candidateAbs.sort((left, right) => {
      if (left.distance !== right.distance) return left.distance - right.distance;
      if (left.degree !== right.degree) return right.degree - left.degree;
      return left.nodeId.localeCompare(right.nodeId);
    });
    const top = candidateAbs.slice(0, topK);
    return {
      multihopNodes: top.map((c) => toRelative(c.nodeId, options.repoPath)),
      candidates: candidateAbs,
      hopsExplored: depthMax,
      resolvedAnchor,
    };
  } finally {
    db.close();
  }
}
