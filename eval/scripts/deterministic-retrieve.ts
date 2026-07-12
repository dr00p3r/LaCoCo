import { Buffer } from "node:buffer";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { SanitizerOutput } from "../../src/retriever/models/utilities/types.js";
import { assertRagSanitizer } from "../../src/retriever/utilities/structured-query.js";
import {
  getStrategyEntry,
  type StrategyRuntimeOptions,
} from "../../src/retriever/strategies/registry.js";
import type { LlmClient } from "../../src/slms/llm-client.js";
import { runRetrieve, type RetrieveRuntime } from "../../src/cli/pipeline.js";
import { resolveNumberConfig, resolveStringConfig } from "../../src/cli/config.js";
import { OllamaService } from "../../src/slms/ollama-service.js";
import { isEntrypoint } from "./lib/cli.js";

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
  // Misma validación que el modo tool (MCP): route RAG + campos completos.
  return assertRagSanitizer(value as Record<string, unknown>);
}

function createRuntime(sanitized: SanitizerOutput): RetrieveRuntime {
  const disabledLlm = new DisabledLlmClient();
  return {
    createDatabase: (dbPath) => new LaCoCoDatabase(dbPath),
    // Cliente Ollama REAL (igual que el runtime de producción en pipeline.ts).
    // Solo la estrategia `agentic` lo usa para planificar; las demás estrategias
    // operan sobre el sanitizer YA CONGELADO (createIntermediary), así que esto no
    // reintroduce variabilidad en hybrid/ictd/clcr/rpr. Honra LACOCO_AGENT_ENDPOINT
    // y LACOCO_AGENT_MODEL vía config. Si Ollama no está, `agentic` fallará con un
    // error claro y el resto de estrategias sigue intacto.
    createOllama: (endpoint) =>
      new OllamaService(
        endpoint ?? resolveStringConfig("agent.endpoint"),
        resolveStringConfig("agent.model"),
        resolveNumberConfig("timeout.ms"),
      ),
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
