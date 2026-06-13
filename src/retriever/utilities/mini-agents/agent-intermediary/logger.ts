import type { ClassificationResult } from "./types.js";

export function logClassification(
  prompt: string,
  result: ClassificationResult
): void {
  const timestamp = new Date().toISOString();
  const sanitizedPrompt = prompt.replace(/"/g, "'").substring(0, 200);
  console.log(
    `[AgentIntermediary1] CLASSIFY | ${timestamp} | ` +
    `prompt="${sanitizedPrompt}" | ` +
    `route=${result.route} | ` +
    `intent=${result.intent} | ` +
    `dimensions=${result.dimensions.join(",") || "none"} | ` +
    `confidence=${result.confidence.toFixed(2)}`
  );
}
