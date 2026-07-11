export const STRATEGY_NAMES = ["hybrid", "agentic", "ictd", "clcr", "rpr", "consensus", "repograph", "ppr"] as const;

export type StrategyName = (typeof STRATEGY_NAMES)[number];

export function isStrategyName(value: string): value is StrategyName {
  return (STRATEGY_NAMES as readonly string[]).includes(value);
}
