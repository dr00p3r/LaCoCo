import type { Dimension } from "../../../domain/dimensions.js";
import type { IntentTag } from "../../models/utilities/types.js";

export type DimensionWeights = Record<Dimension, number>;

const INTENT_WEIGHTS: Readonly<Record<IntentTag, DimensionWeights>> = {
  debug: { SYS: 0.30, CPG: 0.40, DTG: 0.30 },
  refactor: { SYS: 0.40, CPG: 0.40, DTG: 0.20 },
  create: { SYS: 0.50, CPG: 0.30, DTG: 0.20 },
  integrate: { SYS: 0.30, CPG: 0.20, DTG: 0.50 },
  understand: { SYS: 0.35, CPG: 0.35, DTG: 0.30 },
  unknown: { SYS: 0.34, CPG: 0.33, DTG: 0.33 },
};

export function getIntentWeights(
  intent: IntentTag,
  dimensions: readonly Dimension[] = [],
): DimensionWeights {
  const weights = { ...INTENT_WEIGHTS[intent] };
  if (dimensions.length > 0 && dimensions.length < 3) {
    for (const dimension of dimensions) weights[dimension] *= 1.5;
  }

  const total = weights.SYS + weights.CPG + weights.DTG;
  if (total > 0) {
    weights.SYS /= total;
    weights.CPG /= total;
    weights.DTG /= total;
  }
  return weights;
}

export function getDominantDimension(
  intent: IntentTag,
  dimensions: readonly Dimension[] = [],
): Dimension {
  const weights = getIntentWeights(intent, dimensions);
  return (Object.entries(weights) as [Dimension, number][])
    .sort((left, right) => right[1] - left[1])[0]![0];
}
