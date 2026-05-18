/**
 * Tipos compartidos del esquema LanceDB para embeddings de nodos del grafo.
 *
 * Los metadatos redundantes (dimension, sub_type, file_path) permiten
 * filtros pre-ANN antes del ranking vectorial, reduciendo round-trips
 * a SQLite y latencia de búsqueda.
 */

export interface NodeEmbeddingRecord {
  /** FK hacia SQLite.nodes.id */
  node_id: string;

  /** Vector de embedding (all-MiniLM-L6-v2, 384 dimensiones) */
  embedding: Float32Array;

  /** Dimensión semántica del grafo multirrelacional */
  dimension: "SYS" | "CPG" | "DTG";

  /** Sub-tipo semántico: "function" | "class" | "package" | "interface" | ... */
  sub_type: string;

  /** Ruta del archivo fuente para filtrado por módulo */
  file_path: string;

  /** Solo DTG: nombre del paquete npm (ej. "@nestjs/common") */
  package_name?: string;

  /** Solo DTG: versión exacta del paquete */
  package_version?: string;
}
