/**
 * Tipos y constantes compartidos del módulo extractor.
 */

/** Representa un nodo semántico del grafo. */
export interface NodeRow {
  id: string;
  kind: NodeKind;
  name: string;
  filepath: string;
  signature: string;
  isDeprecated: 0 | 1;
}

/** Representa una arista relacional entre nodos. */
export interface EdgeRow {
  sourceId: string;
  targetId: string;
  relation: EdgeRelation;
}

/** Todos los tipos de nodo del tensor. */
export type NodeKind =
  | "CLASS"
  | "METHOD"
  | "FUNCTION"
  | "ARROW_FUNCTION"
  | "VARIABLE"
  | "INTERFACE"
  | "TYPE"
  | "ENUM"
  | "ENUM_MEMBER"
  | "PROPERTY"
  | "ACCESSOR"
  | "EXTERNAL_LIB";

/** Todas las relaciones del tensor. */
export type EdgeRelation =
  // SYS
  | "EXTENDS"
  | "IMPLEMENTS"
  | "IMPORTS_EXTERNAL"
  // CPG
  | "INJECTS"
  | "CALLS"
  | "INSTANTIATES"
  | "DECLARES"
  // DTG
  | "CONSUMES_DATA"
  | "PRODUCES"
  | "MUTATES_STATE"
  | "REFERENCES";

/** Callbacks que los módulos de extracción usan para persistir nodos y aristas. */
export interface ExtractionCallbacks {
  insertNode: (row: NodeRow) => void;
  insertEdge: (sourceId: string, targetId: string, relation: EdgeRelation) => void;
}

/**
 * Métodos que mutan el estado interno de un Array, Map o Set.
 * Cuando se llaman sobre una propiedad de un objeto de dominio, se genera
 * una arista MUTATES_STATE hacia el tipo del receptor.
 */
export const MUTABLE_METHODS = new Set([
  // Array
  "push", "pop", "shift", "unshift", "splice",
  "sort", "reverse", "fill", "copyWithin",
  // Map / WeakMap
  "set", "delete", "clear",
  // Set / WeakSet
  "add",
  // Patrones comunes en DDD (repositorios, agregados)
  "assign", "reset", "merge", "patch",
]);

/**
 * Wrappers genéricos conocidos cuyo tipo interno es el que nos interesa.
 *
 * Ejemplos: Promise<T> → T,  Observable<T> → T,  Result<T, E> → T
 */
export const KNOWN_WRAPPERS = new Set(["Promise", "Observable", "Result", "Either", "Option"]);
