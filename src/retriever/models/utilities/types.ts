export type IntentTag =
  | "understand"
  | "refactor"
  | "create"
  | "debug"
  | "integrate"
  | "unknown";

export interface SanitizerOutput {
  route: "RAG" | "LLM_DIRECT";
  clean_query: string;
  embedding_input: string;
  dimensions: ("SYS" | "CPG" | "DTG")[];
  intent: IntentTag;
  confidence: number;
}
