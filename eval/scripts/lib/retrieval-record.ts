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
  classification: ParsedClassification | null;
  grounding: ParsedGrounding | null;
  error: RetrievalError | null;
}

export interface ParsedClassification {
  cleanQuery: string;
  embeddingInput: string;
}

export interface ParsedGrounding {
  enabled: boolean;
  profileBuildId: string | null;
  candidateTermIds: string[];
  candidateTerms: string[];
  usedTermIds: string[];
  initialUnsupportedClauses: string[];
  repairCount: number;
  durationMs: number | null;
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
      classification: null,
      grounding: null,
      error: {
        type: "invalid_json",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }

  try {
    const root = asRecord(parsed, "retrieve JSON");
    if (root.schemaVersion !== 2) {
      throw new Error("retrieve JSON.schemaVersion must be 2");
    }
    if (root.ok === false) {
      const error = asRecord(root.error, "retrieve JSON.error");
      return {
        rankedNodes: [],
        effectiveParameters: null,
        classification: null,
        grounding: null,
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
    const classificationRecord = asRecord(root.classification, "retrieve JSON.classification");
    const classification = {
      cleanQuery: asString(classificationRecord.cleanQuery, "retrieve JSON.classification.cleanQuery"),
      embeddingInput: asString(classificationRecord.embeddingInput, "retrieve JSON.classification.embeddingInput"),
    };
    const groundingRecord = asRecord(root.grounding, "retrieve JSON.grounding");
    const groundingCandidates = groundingRecord.candidates;
    if (!Array.isArray(groundingCandidates)) throw new Error("retrieve JSON.grounding.candidates must be an array");
    const usedTermIds = groundingRecord.usedTermIds;
    const unsupported = groundingRecord.initialUnsupportedClauses;
    if (!Array.isArray(usedTermIds) || !Array.isArray(unsupported)) {
      throw new Error("retrieve JSON grounding term arrays are invalid");
    }
    const durationMs = groundingRecord.durationMs === null
      ? null
      : finiteNumber(groundingRecord.durationMs, "retrieve JSON.grounding.durationMs");
    const grounding: ParsedGrounding = {
      enabled: groundingRecord.enabled === true,
      profileBuildId: groundingRecord.profileBuildId === null
        ? null
        : asString(groundingRecord.profileBuildId, "retrieve JSON.grounding.profileBuildId"),
      candidateTermIds: groundingCandidates.map((candidate, index) =>
        asString(asRecord(candidate, `retrieve JSON.grounding.candidates[${index}]`).termId,
          `retrieve JSON.grounding.candidates[${index}].termId`)),
      candidateTerms: groundingCandidates.map((candidate, index) =>
        asString(asRecord(candidate, `retrieve JSON.grounding.candidates[${index}]`).canonicalTerm,
          `retrieve JSON.grounding.candidates[${index}].canonicalTerm`)),
      usedTermIds: usedTermIds.map((value, index) => asString(value, `retrieve JSON.grounding.usedTermIds[${index}]`)),
      initialUnsupportedClauses: unsupported.map((value, index) =>
        asString(value, `retrieve JSON.grounding.initialUnsupportedClauses[${index}]`)),
      repairCount: finiteNumber(groundingRecord.repairCount, "retrieve JSON.grounding.repairCount"),
      durationMs,
    };
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
    return { rankedNodes, effectiveParameters, classification, grounding, error: null };
  } catch (error) {
    return {
      rankedNodes: [],
      effectiveParameters: null,
      classification: null,
      grounding: null,
      error: {
        type: "invalid_contract",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
