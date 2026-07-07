import type { GraphEdge, GraphNodeWithMetadata } from "../../persistence/lacoco-graph-manager/model/types.js";

export type Focus = "SYS" | "CPG" | "DTG" | "ALL";
export type InspectMode = "default" | "scores" | "tensor";
export type InspectNode = GraphNodeWithMetadata;
export type InspectEdge = GraphEdge;

export interface InspectOptions {
  rootNode: string;
  db: string;
  budget: number;
  focus: Focus;
  output: string;
  cdn: boolean;
}

export interface InspectQueryOptions {
  prompt: string;
  db: string;
  lancedb: string;
  budget: number;
  strategy: string;
  mode: InspectMode;
  output: string;
  cdn: boolean;
  ollama: string;
  model: string;
  timeoutMs?: number;
  chunks?: number;
  grounding: boolean;
}

export interface InspectStats {
  totalNodes: number;
  totalEdges: number;
  byDim: Record<string, number>;
  byKind: Record<string, number>;
  anchorCount: number;
}

export interface CytoscapeNodeElement {
  data: {
    id: string;
    label: string;
    color: string;
    shape: string;
    score: number;
    anchor: 0 | 1;
    dim: string;
    kind: string;
    file: string;
    signature: string;
    borderWidth: number;
    borderColor: string;
  };
}

export interface CytoscapeEdgeElement {
  data: {
    id: string;
    source: string;
    target: string;
    label: string;
    color: string;
    edgeDim: string;
  };
}
