export function decayScore(score: number, decay: number, hops: number): number {
  if (!Number.isInteger(hops) || hops < 0) {
    throw new Error("hops debe ser un entero no negativo");
  }
  if (!Number.isFinite(decay) || decay < 0 || decay > 1) {
    throw new Error("decay debe estar entre 0 y 1");
  }
  return score * Math.pow(decay, hops);
}
