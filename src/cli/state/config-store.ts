import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "./json-store.js";
import { STRATEGY_NAMES } from "../../retriever/strategies/strategy-names.js";

export type ConfigScope = "default" | "global" | "local" | "env";
export type WritableConfigScope = "global" | "local";

export interface ConfigEntry {
  key: ConfigKey;
  value: ConfigValue;
  source: ConfigScope;
}

interface ConfigFile {
  version: 1;
  values: ConfigTreeNode;
}

export interface ConfigTreeNode {
  [key: string]: ConfigValue | ConfigTreeNode;
}

type ConfigType = "string" | "number" | "boolean";

interface ConfigDefinition {
  type: ConfigType;
  defaultValue: ConfigValue;
  env?: string;
  validate?: (value: ConfigValue) => string | null;
}

export type ConfigKey = keyof typeof CONFIG_DEFINITIONS;
export type ConfigValue = string | number | boolean;

const CONFIG_VERSION = 1;
const STRATEGIES = new Set<string>(STRATEGY_NAMES);

const CONFIG_DEFINITIONS = {
  "agent.endpoint": {
    type: "string",
    defaultValue: "http://localhost:11434",
    env: "LACOCO_AGENT_ENDPOINT",
    validate: (value) =>
      typeof value === "string" && value.trim().length > 0
        ? null
        : "agent.endpoint debe ser una URL no vacía",
  },
  "agent.model": {
    // 4B es la línea base vigente (ver AGENTS.md §"Modelo de build del Project
    // Semantic Profile"): es 2.74× más rápido que el 7B en build de perfil con
    // métricas idénticas, y produce JSON estructurado válido en prompts de
    // retrieval (a diferencia del 1.5B que entra en bucle de repetición).
    type: "string",
    defaultValue: "qwen3:4b-instruct",
    env: "LACOCO_AGENT_MODEL",
    validate: (value) =>
      typeof value === "string" && value.trim().length > 0
        ? null
        : "agent.model debe ser un nombre no vacío",
  },
  "intermediary.model": {
    type: "string",
    defaultValue: "",
    env: "LACOCO_INTERMEDIARY_MODEL",
    validate: (value) =>
      typeof value === "string"
        ? null
        : "intermediary.model debe ser un string (vacío = hereda agent.model)",
  },
  "strategy.default": {
    type: "string",
    defaultValue: "hybrid",
    env: "LACOCO_STRATEGY",
    validate: (value) =>
      typeof value === "string" && STRATEGIES.has(value)
        ? null
        : `strategy.default debe ser una de: ${Array.from(STRATEGIES).join(", ")}`,
  },
  "retrieval.annOverfetch": {
    type: "number",
    defaultValue: 1,
    env: "LACOCO_ANN_OVERFETCH",
    validate: (value) =>
      typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 5
        ? null
        : "retrieval.annOverfetch debe ser un entero entre 1 y 5 (1 = ANN plano actual)",
  },
  "hyde.enabled": {
    type: "boolean",
    defaultValue: false,
    env: "LACOCO_HYDE",
  },
  "hyde.model": {
    type: "string",
    defaultValue: "",
    env: "LACOCO_HYDE_MODEL",
    validate: (value) =>
      typeof value === "string"
        ? null
        : "hyde.model debe ser un string (vacío = hereda intermediary.model)",
  },
  "hyde.mode": {
    type: "string",
    defaultValue: "replace",
    env: "LACOCO_HYDE_MODE",
    validate: (value) =>
      value === "replace" || value === "concat"
        ? null
        : "hyde.mode debe ser 'replace' (solo snippet) o 'concat' (snippet + query)",
  },
  "timeout.ms": {
    type: "number",
    defaultValue: 30_000,
    env: "LACOCO_TIMEOUT_MS",
    validate: (value) =>
      typeof value === "number" && Number.isInteger(value) && value > 0
        ? null
        : "timeout.ms debe ser un entero positivo",
  },
  "watcher.debounceMs": {
    type: "number",
    defaultValue: 80,
    env: "LACOCO_WATCHER_DEBOUNCE_MS",
    validate: (value) =>
      typeof value === "number" && Number.isInteger(value) && value >= 0
        ? null
        : "watcher.debounceMs debe ser un entero mayor o igual a cero",
  },
  "profile.groundingEnabled": {
    type: "boolean",
    defaultValue: false,
    env: "LACOCO_PROFILE_GROUNDING",
  },
  "profile.enrichConcurrency": {
    type: "number",
    defaultValue: 4,
    env: "LACOCO_ENRICH_CONCURRENCY",
    validate: (value) =>
      typeof value === "number" && Number.isInteger(value) && value > 0
        ? null
        : "profile.enrichConcurrency debe ser un entero positivo",
  },
  "paths.data": {
    type: "string",
    defaultValue: ".lacoco",
    env: "LACOCO_DATA_DIR",
  },
  "paths.logs": {
    type: "string",
    defaultValue: ".lacoco/logs",
    env: "LACOCO_LOGS_DIR",
  },
  "paths.state": {
    type: "string",
    defaultValue: ".lacoco/state",
    env: "LACOCO_STATE_DIR",
  },
} as const satisfies Record<string, ConfigDefinition>;

export function listConfig(): ConfigEntry[] {
  return configKeys().map((key) => resolveConfig(key));
}

export function resolveConfig(key: string): ConfigEntry {
  const configKey = assertConfigKey(key);
  const definition = getDefinition(configKey);
  const globalFile = readConfigFile(getConfigPath("global"));
  const localFile = readConfigFile(getConfigPath("local"));

  const globalValue = getNested(globalFile.values, configKey);
  const localValue = getNested(localFile.values, configKey);
  const envValue = readEnvValue(configKey);

  if (envValue !== undefined) return { key: configKey, value: envValue, source: "env" };
  if (localValue !== undefined) return { key: configKey, value: castStoredValue(configKey, localValue), source: "local" };
  if (globalValue !== undefined) return { key: configKey, value: castStoredValue(configKey, globalValue), source: "global" };

  return { key: configKey, value: definition.defaultValue, source: "default" };
}

export function setConfig(key: string, rawValue: string, scope: WritableConfigScope): void {
  const configKey = assertConfigKey(key);
  const value = parseConfigValue(configKey, rawValue);
  const configPath = getConfigPath(scope);
  const file = readConfigFile(configPath);
  setNested(file.values, configKey, value);
  writeJsonFileAtomic(configPath, file);
}

export function unsetConfig(key: string, scope: WritableConfigScope): void {
  const configKey = assertConfigKey(key);
  const configPath = getConfigPath(scope);
  const file = readConfigFile(configPath);
  unsetNested(file.values, configKey);
  writeJsonFileAtomic(configPath, file);
}

export function getConfigPath(scope: WritableConfigScope): string {
  return scope === "global" ? globalConfigPath() : localConfigPath();
}

export function configKeys(): ConfigKey[] {
  return Object.keys(CONFIG_DEFINITIONS) as ConfigKey[];
}

function readConfigFile(filePath: string): ConfigFile {
  const file = readJsonFile<ConfigFile>(filePath, {
    version: CONFIG_VERSION,
    values: {},
  });

  if (file.version !== CONFIG_VERSION || typeof file.values !== "object" || file.values === null) {
    throw new Error(`Configuración corrupta o versión no soportada: ${filePath}`);
  }

  return file;
}

function assertConfigKey(key: string): ConfigKey {
  if (!Object.prototype.hasOwnProperty.call(CONFIG_DEFINITIONS, key)) {
    throw new Error(`Clave de configuración desconocida: ${key}`);
  }
  return key as ConfigKey;
}

function parseConfigValue(key: ConfigKey, rawValue: string): ConfigValue {
  const definition = getDefinition(key);
  let value: ConfigValue;

  switch (definition.type) {
    case "number":
      value = Number(rawValue);
      break;
    case "boolean": {
      // Acepta formas comunes truthy/falsy además de true/false, para que flags
      // vía env como `LACOCO_HYDE=1` funcionen sin footguns (case-insensitive).
      const normalized = rawValue.trim().toLowerCase();
      const truthy = normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
      const falsy = normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off";
      if (!truthy && !falsy) {
        throw new Error(`${key} debe ser booleano (true/false, 1/0, yes/no, on/off)`);
      }
      value = truthy;
      break;
    }
    case "string":
      value = rawValue;
      break;
  }

  const validationError = definition.validate?.(value) ?? null;
  if (validationError) throw new Error(validationError);
  return value;
}

function castStoredValue(key: ConfigKey, value: unknown): ConfigValue {
  const definition = getDefinition(key);
  if (typeof value !== definition.type) {
    throw new Error(`Valor inválido para ${key}: se esperaba ${definition.type}`);
  }

  const typedValue = value as ConfigValue;
  const validationError = definition.validate?.(typedValue) ?? null;
  if (validationError) throw new Error(validationError);
  return typedValue;
}

function readEnvValue(key: ConfigKey): ConfigValue | undefined {
  const env = getDefinition(key).env;
  if (!env) return undefined;

  const rawValue = process.env[env];
  if (rawValue === undefined) return undefined;
  return parseConfigValue(key, rawValue);
}

function getDefinition(key: ConfigKey): ConfigDefinition {
  return CONFIG_DEFINITIONS[key];
}

function globalConfigPath(): string {
  return path.join(
    process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"),
    "lacoco",
    "config.json",
  );
}

function localConfigPath(): string {
  return path.join(process.cwd(), ".lacoco", "config.json");
}

function getNested(values: ConfigTreeNode, key: string): ConfigValue | ConfigTreeNode | undefined {
  let current: ConfigValue | ConfigTreeNode | undefined = values;
  for (const part of key.split(".")) {
    if (!isConfigTreeNode(current)) return undefined;
    current = current[part];
  }
  return current;
}

function setNested(values: ConfigTreeNode, key: string, value: ConfigValue): void {
  const parts = key.split(".");
  let current = values;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      current[part] = {};
    }
    current = current[part] as ConfigTreeNode;
  }
  current[parts[parts.length - 1]!] = value;
}

function unsetNested(values: ConfigTreeNode, key: string): void {
  const parts = key.split(".");
  let current = values;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (typeof child !== "object" || child === null || Array.isArray(child)) return;
    current = child as ConfigTreeNode;
  }
  delete current[parts[parts.length - 1]!];
}

function isConfigTreeNode(value: unknown): value is ConfigTreeNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
