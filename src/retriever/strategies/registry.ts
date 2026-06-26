import type { LaCoCoDatabase } from "../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { LaCoCoLanceDb } from "../../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { LlmClient } from "../../slms/llm-client.js";
import type { RecoveryStrategy } from "../models/strategies/types.js";
import { AgenticStrategy } from "./agentic-strategy.js";
import { ClcrStrategy } from "./clcr-strategy.js";
import { HybridStrategy } from "./hybrid-strategy.js";
import { IctdStrategy } from "./ictd-strategy.js";
import { RprStrategy } from "./rpr-strategy.js";
import { isStrategyName, STRATEGY_NAMES, type StrategyName } from "./strategy-names.js";

export { isStrategyName, STRATEGY_NAMES, type StrategyName };

export interface StrategyDeps {
  db: LaCoCoDatabase;
  lanceDb?: LaCoCoLanceDb;
  ollamaEndpoint: string;
  ollamaTimeoutMs?: number;
  ollama?: LlmClient;
}

export interface StrategyEntry {
  name: StrategyName;
  needsLanceDb: boolean;
  create(deps: StrategyDeps): RecoveryStrategy;
}

function requireLanceDb(strategyName: StrategyName, lanceDb: LaCoCoLanceDb | undefined): LaCoCoLanceDb {
  if (!lanceDb) throw new Error(`LanceDB requerido para ${strategyName} strategy`);
  return lanceDb;
}

export const STRATEGY_REGISTRY: Readonly<Record<StrategyName, StrategyEntry>> = {
  hybrid: {
    name: "hybrid",
    needsLanceDb: true,
    create: ({ db, lanceDb }) => new HybridStrategy(db, requireLanceDb("hybrid", lanceDb)),
  },
  agentic: {
    name: "agentic",
    needsLanceDb: false,
    create: ({ db, ollama }) => {
      if (!ollama) throw new Error("LlmClient requerido para agentic strategy");
      return new AgenticStrategy(db, ollama);
    },
  },
  ictd: {
    name: "ictd",
    needsLanceDb: true,
    create: ({ db, lanceDb }) => new IctdStrategy(db, requireLanceDb("ictd", lanceDb)),
  },
  clcr: {
    name: "clcr",
    needsLanceDb: true,
    create: ({ db, lanceDb }) => new ClcrStrategy(db, requireLanceDb("clcr", lanceDb)),
  },
  rpr: {
    name: "rpr",
    needsLanceDb: true,
    create: ({ db, lanceDb }) => new RprStrategy(db, requireLanceDb("rpr", lanceDb)),
  },
};

export function getStrategyEntry(strategyName: string): StrategyEntry {
  if (!isStrategyName(strategyName)) {
    throw new Error(`Estrategia no soportada: ${strategyName}`);
  }
  return STRATEGY_REGISTRY[strategyName];
}
