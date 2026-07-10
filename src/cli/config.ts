import { resolveConfig } from "./state/config-store.js";

export function resolveStringConfig(key: string): string {
  const entry = resolveConfig(key);
  if (typeof entry.value !== "string") {
    throw new Error(`La configuración ${key} debe ser string`);
  }
  return entry.value;
}

export function resolveNumberConfig(key: string): number {
  const entry = resolveConfig(key);
  if (typeof entry.value !== "number") {
    throw new Error(`La configuración ${key} debe ser number`);
  }
  return entry.value;
}

export function resolveBooleanConfig(key: string): boolean {
  const entry = resolveConfig(key);
  if (typeof entry.value !== "boolean") {
    throw new Error(`La configuración ${key} debe ser boolean`);
  }
  return entry.value;
}

/**
 * Modelo del agente intermediario (clasificador). `intermediary.model` vacío
 * hereda `agent.model`, de modo que por defecto se usa el mismo SLM en todo el
 * pipeline y basta con `lacoco config set intermediary.model <tag>` para darle
 * uno propio (p. ej. gemma4:e4b) sin tocar la generación ni el enriquecedor.
 */
export function resolveIntermediaryModel(): string {
  const explicit = resolveStringConfig("intermediary.model").trim();
  return explicit.length > 0 ? explicit : resolveStringConfig("agent.model");
}

/**
 * Modelo del generador HyDE. `hyde.model` vacío hereda `intermediary.model`
 * (que a su vez hereda `agent.model`), de modo que HyDE usa por defecto el
 * mismo SLM local que el clasificador y basta con `hyde.model <tag>` para
 * probar un modelo distinto (p. ej. uno de nube) sin tocar el resto.
 */
export function resolveHydeModel(): string {
  const explicit = resolveStringConfig("hyde.model").trim();
  return explicit.length > 0 ? explicit : resolveIntermediaryModel();
}
