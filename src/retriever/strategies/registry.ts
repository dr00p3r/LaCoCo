import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { LlmClient } from "../../slms/llm-client.js";
import type { RecoveryStrategy } from "../models/strategies/types.js";
import { AGENTIC_DEFAULT_CONFIG, AgenticStrategy, type AgenticConfig } from "./agentic-strategy.js";
import { CLCR_DEFAULT_CONFIG, ClcrStrategy, type ClcrConfig } from "./clcr-strategy.js";
import { HYBRID_DEFAULT_CONFIG, HybridStrategy, type HybridConfig } from "./hybrid-strategy.js";
import { ICTD_DEFAULT_CONFIG, IctdStrategy, type IctdConfig } from "./ictd-strategy.js";
import { RPR_DEFAULT_CONFIG, RprStrategy, type RprConfig } from "./rpr-strategy.js";
import { isStrategyName, STRATEGY_NAMES, type StrategyName } from "./strategy-names.js";

export { isStrategyName, STRATEGY_NAMES, type StrategyName };

export interface StrategyDeps {
  db: LaCoCoDatabase;
  lanceDb?: LaCoCoLanceDb;
  ollamaEndpoint: string;
  ollamaTimeoutMs?: number;
  ollama?: LlmClient;
}

export interface StrategyRuntimeOptions {
  chunks?: number;
}

export type StrategyParameters = Record<string, number>;

export interface StrategyEntry {
  name: StrategyName;
  needsLanceDb: boolean;
  defaultParameters: Readonly<StrategyParameters>;
  chunkLimitParameter: string;
  create(deps: StrategyDeps, options?: StrategyRuntimeOptions): RecoveryStrategy;
}

function requireLanceDb(strategyName: StrategyName, lanceDb: LaCoCoLanceDb | undefined): LaCoCoLanceDb {
  if (!lanceDb) throw new Error(`LanceDB requerido para ${strategyName} strategy`);
  return lanceDb;
}

export const STRATEGY_REGISTRY: Readonly<Record<StrategyName, StrategyEntry>> = {
  hybrid: {
    name: "hybrid",
    needsLanceDb: true,
    defaultParameters: HYBRID_DEFAULT_CONFIG,
    chunkLimitParameter: "anchorLimit",
    create: ({ db, lanceDb }, options) => new HybridStrategy(
      db,
      requireLanceDb("hybrid", lanceDb),
      getEffectiveStrategyParameters("hybrid", options) as unknown as HybridConfig,
    ),
  },
  agentic: {
    name: "agentic",
    needsLanceDb: false,
    defaultParameters: AGENTIC_DEFAULT_CONFIG,
    chunkLimitParameter: "chunkLimit",
    create: ({ db, ollama }, options) => {
      if (!ollama) throw new Error("LlmClient requerido para agentic strategy");
      return new AgenticStrategy(
        db,
        ollama,
        getEffectiveStrategyParameters("agentic", options) as unknown as AgenticConfig,
      );
    },
  },
  ictd: {
    name: "ictd",
    needsLanceDb: true,
    defaultParameters: ICTD_DEFAULT_CONFIG,
    chunkLimitParameter: "chunkLimit",
    create: ({ db, lanceDb }, options) => new IctdStrategy(
      db,
      requireLanceDb("ictd", lanceDb),
      getEffectiveStrategyParameters("ictd", options) as unknown as IctdConfig,
    ),
  },
  clcr: {
    name: "clcr",
    needsLanceDb: true,
    defaultParameters: CLCR_DEFAULT_CONFIG,
    chunkLimitParameter: "chunkLimit",
    create: ({ db, lanceDb }, options) => new ClcrStrategy(
      db,
      requireLanceDb("clcr", lanceDb),
      getEffectiveStrategyParameters("clcr", options) as unknown as ClcrConfig,
    ),
  },
  rpr: {
    name: "rpr",
    needsLanceDb: true,
    defaultParameters: RPR_DEFAULT_CONFIG,
    chunkLimitParameter: "chunkLimit",
    create: ({ db, lanceDb }, options) => new RprStrategy(
      db,
      requireLanceDb("rpr", lanceDb),
      getEffectiveStrategyParameters("rpr", options) as unknown as RprConfig,
    ),
  },
};

export function getStrategyEntry(strategyName: string): StrategyEntry {
  if (!isStrategyName(strategyName)) {
    throw new Error(`Estrategia no soportada: ${strategyName}`);
  }
  return STRATEGY_REGISTRY[strategyName];
}

export function getEffectiveStrategyParameters(
  strategyName: StrategyName,
  options: StrategyRuntimeOptions = {},
): StrategyParameters {
  const entry = STRATEGY_REGISTRY[strategyName];
  const parameters = { ...entry.defaultParameters };
  if (options.chunks !== undefined) {
    if (!Number.isInteger(options.chunks) || options.chunks <= 0) {
      throw new Error("chunks debe ser un entero positivo");
    }
    parameters[entry.chunkLimitParameter] = options.chunks;
  }
  return parameters;
}
