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
