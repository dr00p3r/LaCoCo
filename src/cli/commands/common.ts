import type { WritableConfigScope } from "../state/config-store.js";
import type { ProjectRecord } from "../state/project-registry.js";
import { formatError, formatProjectDetails } from "../formatters.js";

export interface JsonOption { json: boolean; }

export interface ConfigScopeOptions extends JsonOption {
  global: boolean;
  local: boolean;
}

export function runCliCommand(action: () => void | Promise<void>): Promise<void> {
  return Promise.resolve().then(action).catch((error: unknown) => {
    console.error(formatError(error));
    process.exitCode = 1;
  });
}

export function resolveWritableScope(options: ConfigScopeOptions): WritableConfigScope {
  if (options.global && options.local) throw new Error("Usa solo uno de --global o --local");
  return options.global ? "global" : "local";
}

export function writeProjectResult(project: ProjectRecord, json: boolean): void {
  console.log(json ? JSON.stringify(project, null, 2) : formatProjectDetails(project));
}
