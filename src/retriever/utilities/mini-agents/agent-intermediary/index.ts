import type { SanitizerOutput } from "../../../models/utilities/types.js";
import { SlmClassifier } from "./classifier.js";
import { logClassification } from "./logger.js";

export class AgentIntermediary1 {

  private readonly classifier: SlmClassifier;

  constructor(classifier: SlmClassifier) {
    this.classifier = classifier;
  }

  /**
   * Delega al SLM la transformación completa del prompt para retrieval.
   *
   * @param prompt Prompt original del usuario.
   * @returns Ruta, consultas, dimensiones, intención y confianza emitidas por el SLM.
   */
  async sanitize(prompt: string): Promise<SanitizerOutput> {

    const trimmed = prompt.trim();
    if (trimmed.length === 0) throw new Error("El prompt no puede estar vacío");

    const output = await this.classifier.classify(trimmed);
    logClassification(trimmed, output);
    
    return output;
  }
}
