export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  filepath: string;
  signature: string;
  isDeprecated: number;
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  relation: string;
}
