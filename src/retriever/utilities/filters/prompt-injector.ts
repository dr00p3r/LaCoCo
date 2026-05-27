/**
 * PromptInjector — Inyecta chunks de contexto recuperado en un prompt template versionado.
 *
 * Mantiene el prompt original intacto y añade una sección estructurada
 * con el contexto del proyecto para que el LLM pueda generar código
 * compatible con el ecosistema local.
 */

import { type ContextChunk } from "../../models/strategies/types.js";

/** Templates de inyección versionados */
const TEMPLATES: Record<string, (chunks: ContextChunk[]) => string> = {
  v1: (chunks) => {
    const blocks = chunks
      .map((c, i) => `[${i + 1}] ${c.source} | ${c.nodeId}\n${c.text}`)
      .join("\n\n---\n\n");

    return `### Contexto del Proyecto (recuperado automáticamente)
Los siguientes fragmentos de código fueron recuperados del repositorio actual
como contexto para tu consulta. Úsalos como referencia absoluta de firmas,
tipos y dependencias locales. No inventes símbolos que no aparezcan aquí.

${blocks}

### Fin del Contexto
`;
  },
};

export class PromptInjector {
  /**
   * Inyecta chunks de contexto en el prompt original.
   *
   * @param originalPrompt Prompt del usuario (sin modificar)
   * @param chunks Chunks recuperados y agregados
   * @param version Versión del template de inyección (default "v1")
   * @returns Prompt enriquecido con contexto del proyecto
   */
  inject(
    originalPrompt: string,
    chunks: ContextChunk[],
    version = "v1"
  ): string {
    const templateFn = TEMPLATES[version];
    if (!templateFn) {
      throw new Error(`Template de inyección desconocido: ${version}`);
    }

    if (chunks.length === 0) {
      // Sin contexto recuperado: no inyectamos nada, pasamos directo
      return originalPrompt;
    }

    const contextBlock = templateFn(chunks);
    return `${contextBlock}\n${originalPrompt}`;
  }
}
