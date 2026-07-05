import { asRecord, asString } from "./config.js";

export interface RankedNode {
  rank: number;
  chunk_id: string;
  node_id: string;
  score: number;
  source: string;
  text: string;
  filepath?: string;
  kind?: string;
  duplicate_count?: number;
}

export interface ParsedRetrievalOutput {
  rankedNodes: RankedNode[];
  effectiveParameters: Record<string, number> | null;
  error: RetrievalError | null;
}

export interface RetrievalError {
  type: "cli_error" | "invalid_json" | "invalid_contract" | "command_error";
  message: string;
  stage?: string;
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return asString(value, path);
}

function finiteNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number`);
  }
  return value;
}

export function parseRetrievalJson(stdout: string): ParsedRetrievalOutput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    return {
      rankedNodes: [],
      effectiveParameters: null,
      error: {
        type: "invalid_json",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  try {
    const root = asRecord(parsed, "retrieve JSON");
    if (root.schemaVersion !== 1) {
      throw new Error("retrieve JSON.schemaVersion must be 1");
    }
    if (root.ok === false) {
      const error = asRecord(root.error, "retrieve JSON.error");
      return {
        rankedNodes: [],
        effectiveParameters: null,
        error: {
          type: "cli_error",
          stage: asString(error.stage, "retrieve JSON.error.stage"),
          message: asString(error.message, "retrieve JSON.error.message"),
        },
      };
    }
    if (root.ok !== true) {
      throw new Error("retrieve JSON.ok must be a boolean");
    }
    const retrieval = asRecord(root.retrieval, "retrieve JSON.retrieval");
    if (!Array.isArray(retrieval.chunks)) {
      throw new Error("retrieve JSON.retrieval.chunks must be an array");
    }
    const parameters = asRecord(
      retrieval.strategyParameters,
      "retrieve JSON.retrieval.strategyParameters",
    );
    const effectiveParameters = Object.fromEntries(
      Object.entries(parameters).map(([key, value]) => [
        key,
        finiteNumber(value, `retrieve JSON.retrieval.strategyParameters.${key}`),
      ]),
    );
    const rankedNodes = retrieval.chunks.map((value, index) => {
      const path = `retrieve JSON.retrieval.chunks[${index}]`;
      const chunk = asRecord(value, path);
      const filepath = optionalString(chunk.filepath, `${path}.filepath`);
      const kind = optionalString(chunk.kind, `${path}.kind`);
      const diagnostics = chunk.diagnostics === undefined
        ? undefined
        : asRecord(chunk.diagnostics, `${path}.diagnostics`);
      const duplicateCount = diagnostics?.duplicateCount === undefined
        ? undefined
        : finiteNumber(diagnostics.duplicateCount, `${path}.diagnostics.duplicateCount`);
      return {
        rank: index + 1,
        chunk_id: asString(chunk.chunkId, `${path}.chunkId`),
        node_id: asString(chunk.nodeId, `${path}.nodeId`),
        score: finiteNumber(chunk.score, `${path}.score`),
        source: asString(chunk.source, `${path}.source`),
        text: asString(chunk.text, `${path}.text`),
        ...(filepath === undefined ? {} : { filepath }),
        ...(kind === undefined ? {} : { kind }),
        ...(duplicateCount === undefined ? {} : { duplicate_count: duplicateCount }),
      } satisfies RankedNode;
    });
    return { rankedNodes, effectiveParameters, error: null };
  } catch (error) {
    return {
      rankedNodes: [],
      effectiveParameters: null,
      error: {
        type: "invalid_contract",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
