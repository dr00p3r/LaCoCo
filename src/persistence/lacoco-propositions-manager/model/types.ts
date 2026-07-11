import type { Dimension } from "../../../domain/dimensions.js";

/**
 * Fila de la tabla LanceDB `node_propositions` (canal doc-side de C2).
 *
 * Cada nodo de código genera 1..N proposiciones en lenguaje de issue; cada una
 * es una fila con su propio embedding. `prop_id` (clave primaria) es
 * `"<real_node_id>#prop<K>"` para no colisionar con `node_embeddings`, y
 * `real_node_id` mapea de vuelta al nodo de código real cuando la fila aflora
 * como ancla (ver `LaCoCoPropositionsDb.search`).
 */
export interface NodePropositionRecord {
  prop_id: string;
  real_node_id: string;
  embedding: Float32Array;
  /** Texto de la proposición (lenguaje de issue) que se embebió. */
  text: string;
  dimension: Dimension;
  file_path: string;
}
