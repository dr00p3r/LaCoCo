import { Buffer } from "node:buffer";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { SanitizerOutput } from "../../src/retriever/models/utilities/types.js";
import {
  getStrategyEntry,
  type StrategyRuntimeOptions,
} from "../../src/retriever/strategies/registry.js";
import type { LlmClient } from "../../src/slms/llm-client.js";
import { runRetrieve, type RetrieveRuntime } from "../../src/cli/pipeline.js";
import { isEntrypoint } from "./lib/cli.js";

const INTENTS = new Set(["understand", "refactor", "create", "debug", "integrate", "unknown"]);
const DIMENSIONS = new Set(["SYS", "CPG", "DTG"]);

class DisabledLlmClient implements LlmClient {
  abort(): void {}
  async isAvailable(): Promise<boolean> { return false; }
  async generate(): Promise<string> { throw new Error("LLM disabled in deterministic retrieval"); }
  async chat(): Promise<string> { throw new Error("LLM disabled in deterministic retrieval"); }
}

function parseSanitizer(encoded: string): SanitizerOutput {
  const value: unknown = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (typeof value !== "object" || value === null) {
    throw new Error("deterministic sanitizer payload must be an object");
  }
  const record = value as Record<string, unknown>;
  if (record.route !== "RAG") throw new Error("deterministic sanitizer route must be RAG");
  if (typeof record.clean_query !== "string" || record.clean_query.trim().length === 0) {
    throw new Error("deterministic sanitizer clean_query must be a non-empty string");
  }
  if (typeof record.embedding_input !== "string" || record.embedding_input.trim().length === 0) {
    throw new Error("deterministic sanitizer embedding_input must be a non-empty string");
  }
  if (typeof record.intent !== "string" || !INTENTS.has(record.intent)) {
    throw new Error(`unsupported deterministic sanitizer intent: ${String(record.intent)}`);
  }
  if (!Array.isArray(record.dimensions) || record.dimensions.some(
    (dimension) => typeof dimension !== "string" || !DIMENSIONS.has(dimension),
  )) {
    throw new Error("deterministic sanitizer dimensions must contain only SYS, CPG, or DTG");
  }
  if (typeof record.confidence !== "number" || !Number.isFinite(record.confidence)) {
    throw new Error("deterministic sanitizer confidence must be a finite number");
  }
  return value as SanitizerOutput;
}

function createRuntime(sanitized: SanitizerOutput): RetrieveRuntime {
  const disabledLlm = new DisabledLlmClient();
  return {
    createDatabase: (dbPath) => new LaCoCoDatabase(dbPath),
    createOllama: () => disabledLlm,
    createIntermediary: () => ({ sanitize: async () => sanitized }),
    createStrategy: async (
      strategyName,
      db,
      lanceDbPath,
      ollamaEndpoint,
      ollamaTimeoutMs,
      ollama,
      strategyOptions: StrategyRuntimeOptions = {},
    ) => {
      const entry = getStrategyEntry(strategyName);
      const lanceDb = entry.needsLanceDb ? new LaCoCoLanceDb(lanceDbPath) : undefined;
      try {
        if (lanceDb) await lanceDb.connect();
        return {
          strategy: entry.create({
            db,
            ...(lanceDb ? { lanceDb } : {}),
            ollamaEndpoint,
            ...(ollamaTimeoutMs === undefined ? {} : { ollamaTimeoutMs }),
            ollama: ollama ?? disabledLlm,
          }, strategyOptions),
          ...(lanceDb ? { connectedLanceDb: lanceDb } : {}),
        };
      } catch (error) {
        if (lanceDb) await lanceDb.close();
        throw error;
      }
    },
  };
}

export async function runDeterministicRetrieve(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length !== 4) {
    throw new Error(
      "usage: deterministic-retrieve <project> <query> <strategy> <sanitizer-base64url>",
    );
  }
  const [project, query, strategy, encodedSanitizer] = argv as [string, string, string, string];
  const sanitized = parseSanitizer(encodedSanitizer);
  return runRetrieve(
    query,
    { strategy, verbose: false, json: true, grounding: false },
    { stdout: process.stdout, stderr: process.stderr },
    createRuntime(sanitized),
    project,
  );
}

if (isEntrypoint(import.meta.url)) {
  runDeterministicRetrieve()
    .then((exitCode) => { process.exitCode = exitCode; })
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
