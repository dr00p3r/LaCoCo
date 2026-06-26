export type Dimension = "SYS" | "CPG" | "DTG";

export const DIMENSIONS = ["SYS", "CPG", "DTG"] as const satisfies readonly Dimension[];

export const RELATION_TO_DIM: Readonly<Record<string, Dimension>> = {
  EXTENDS: "SYS",
  IMPLEMENTS: "SYS",
  IMPORTS_EXTERNAL: "SYS",
  INJECTS: "CPG",
  CALLS: "CPG",
  INSTANTIATES: "CPG",
  CONSUMES_DATA: "DTG",
  PRODUCES: "DTG",
  MUTATES_STATE: "DTG",
};

export const KIND_TO_DIM: Readonly<Record<string, Dimension>> = {
  CLASS: "SYS",
  INTERFACE: "SYS",
  METHOD: "CPG",
  FUNCTION: "CPG",
  ARROW_FUNCTION: "CPG",
  PROPERTY: "DTG",
  VARIABLE: "DTG",
};

export const KIND_TO_SUBTYPE: Readonly<Record<string, string>> = {
  CLASS: "class",
  METHOD: "method",
  FUNCTION: "function",
  ARROW_FUNCTION: "arrow_function",
  VARIABLE: "variable",
  INTERFACE: "interface",
  TYPE: "type_alias",
  ENUM: "enum",
  ENUM_MEMBER: "enum_member",
  PROPERTY: "property",
  ACCESSOR: "accessor",
  EXTERNAL_LIB: "package",
};
