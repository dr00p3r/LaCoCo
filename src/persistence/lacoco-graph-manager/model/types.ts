export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  filepath: string;
  signature: string;
  isDeprecated: number;
  /** Rango de línea 1-indexado del símbolo (null si el nodo no lo tiene). */
  startLine?: number | null;
  endLine?: number | null;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  relation: string;
}

export interface GraphNodeWithMetadata extends GraphNode {
  dim: string | null;
  sub_type: string | null;
}

export function parseGraphNode(value: unknown): GraphNode {
  const row = requireRecord(value, "GraphNode");
  return {
    id: requireString(row.id, "GraphNode.id"),
    kind: requireString(row.kind, "GraphNode.kind"),
    name: requireString(row.name, "GraphNode.name"),
    filepath: requireString(row.filepath, "GraphNode.filepath"),
    signature: row.signature === null
      ? ""
      : requireString(row.signature, "GraphNode.signature"),
    isDeprecated: requireNumber(row.isDeprecated, "GraphNode.isDeprecated"),
    startLine: optionalNumber(row.startLine, "GraphNode.startLine"),
    endLine: optionalNumber(row.endLine, "GraphNode.endLine"),
  };
}

/** Número finito o `null` (columnas nuevas ausentes en filas antiguas). */
export function optionalNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  return requireNumber(value, label);
}

export function parseGraphEdge(value: unknown): GraphEdge {
  const row = requireRecord(value, "GraphEdge");
  return {
    sourceId: requireString(row.sourceId, "GraphEdge.sourceId"),
    targetId: requireString(row.targetId, "GraphEdge.targetId"),
    relation: requireString(row.relation, "GraphEdge.relation"),
  };
}

export function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} inválido`);
  }
  return value as Record<string, unknown>;
}

export function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} debe ser string`);
  return value;
}

export function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} debe ser number`);
  }
  return value;
}
