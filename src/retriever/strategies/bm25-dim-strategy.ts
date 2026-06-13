/**
 * BM25DimFilterStrategy — BM25 dirigido por dimensión sugerida por el intermediario.
 *
 * Usa las dimensiones sugeridas por AgentIntermediary1 para limitar
 * el espacio de búsqueda a nodos de la dimensión relevante.
 */

import {
  type RecoveryStrategy,
  type ContextChunk,
} from "../models/strategies/types.js";
import type { SanitizerOutput } from "../models/utilities/types.js";
import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";

export class BM25DimFilterStrategy implements RecoveryStrategy {
  constructor(
    private readonly db: LaCoCoDatabase,
  ) {}

  /**
   * Recupera nodos filtrando primero por dimensión, luego aplicando BM25.
   *
   * @param query Salida sanitizada del intermediario
   * @returns Chunks de nodos que coinciden en dimensión y relevancia BM25
   */
  async retrieve(query: SanitizerOutput): Promise<ContextChunk[]> {
    const dimensions = query.dimensions;

    // Obtener todos los nodos de las dimensiones detectadas
    const candidateIds = new Set<string>();
    for (const dim of dimensions) {
      const nodes = this.db.getNodesByDimension(dim, 200);
      for (const n of nodes) {
        candidateIds.add(n.id);
      }
    }

    // Ejecutar BM25 global
    const bm25Results = this.db.searchBM25(query.clean_query, 100);

    // Intersecar con candidatos dimensionales
    const filtered = bm25Results.filter((r) => candidateIds.has(r.node_id));

    const signatures = this.db.getNodeSignatures(filtered.map((r) => r.node_id));

    return filtered.map((r) => ({
      nodeId: r.node_id,
      score: Math.max(0, 1 - Math.abs(r.score)),
      text: signatures.get(r.node_id) ?? r.node_id,
      source: "BM25+DimFilter",
    }));
  }
}
