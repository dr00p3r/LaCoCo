import type { IntentTag } from "../../../models/utilities/types.js";

export interface ClassificationResult {
  route: "RAG" | "LLM_DIRECT";
  intent: IntentTag;
  dimensions: ("SYS" | "CPG" | "DTG")[];
  confidence: number;
}
