import os from "node:os";
import path from "node:path";
import { readJsonFile, writeJsonFileAtomic } from "./json-store.js";

export type ConfigScope = "default" | "global" | "local" | "env";
export type WritableConfigScope = "global" | "local";

export interface ConfigEntry {
  key: ConfigKey;
  value: ConfigValue;
  source: ConfigScope;
}

interface ConfigFile {
  version: 1;
  values: Record<string, unknown>;
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
const STRATEGIES = new Set(["hybrid", "agentic", "ictd", "clcr", "rpr"]);
const LOG_LEVELS = new Set(["error", "warn", "info", "debug"]);
const OUTPUT_FORMATS = new Set(["text", "json"]);

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
  "strategy.default": {
    type: "string",
    defaultValue: "hybrid",
    env: "LACOCO_STRATEGY",
    validate: (value) =>
      typeof value === "string" && STRATEGIES.has(value)
        ? null
        : `strategy.default debe ser una de: ${Array.from(STRATEGIES).join(", ")}`,
  },
  "logging.level": {
    type: "string",
    defaultValue: "info",
    env: "LACOCO_LOG_LEVEL",
    validate: (value) =>
      typeof value === "string" && LOG_LEVELS.has(value)
        ? null
        : `logging.level debe ser uno de: ${Array.from(LOG_LEVELS).join(", ")}`,
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
  "output.format": {
    type: "string",
    defaultValue: "text",
    env: "LACOCO_OUTPUT_FORMAT",
    validate: (value) =>
      typeof value === "string" && OUTPUT_FORMATS.has(value)
        ? null
        : `output.format debe ser uno de: ${Array.from(OUTPUT_FORMATS).join(", ")}`,
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
    case "boolean":
      if (rawValue !== "true" && rawValue !== "false") {
        throw new Error(`${key} debe ser true o false`);
      }
      value = rawValue === "true";
      break;
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

function getNested(values: Record<string, unknown>, key: string): unknown {
  let current: unknown = values;
  for (const part of key.split(".")) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function setNested(values: Record<string, unknown>, key: string, value: ConfigValue): void {
  const parts = key.split(".");
  let current = values;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (typeof child !== "object" || child === null || Array.isArray(child)) {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]!] = value;
}

function unsetNested(values: Record<string, unknown>, key: string): void {
  const parts = key.split(".");
  let current = values;
  for (const part of parts.slice(0, -1)) {
    const child = current[part];
    if (typeof child !== "object" || child === null || Array.isArray(child)) return;
    current = child as Record<string, unknown>;
  }
  delete current[parts[parts.length - 1]!];
}
