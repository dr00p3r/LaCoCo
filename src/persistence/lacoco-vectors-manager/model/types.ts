export interface NodeEmbeddingRecord {
  node_id: string;
  embedding: Float32Array;
  dimension: "SYS" | "CPG" | "DTG";
  sub_type: string;
  file_path: string;
  package_name?: string;
  package_version?: string;
}
