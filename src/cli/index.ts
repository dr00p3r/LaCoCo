#!/usr/bin/env node

import { Command } from "commander";
import { pathToFileURL } from "node:url";
import { registerIndexingCommands } from "./commands/indexing-commands.js";
import { registerRetrievalCommands } from "./commands/retrieval-commands.js";
import { registerStateCommands } from "./commands/state-commands.js";
import { registerWatchCommands } from "./commands/watch-command.js";
import { formatError } from "./formatters.js";

export const program = new Command();
program
  .name("lacoco")
  .description("LaCoCo — Recuperador de Contexto de Grandes Bases de Código (RAG local)")
  .version("1.0.0");

registerStateCommands(program);
registerRetrievalCommands(program);
registerWatchCommands(program);
registerIndexingCommands(program);

export {
  runRetrieve,
  runContextExport,
  type RetrieveCliOptions,
  type ContextExportCliOptions,
  type CliStreams,
  type RetrieveIntermediary,
  type RetrieveRuntime,
  type RetrieveJsonResult,
  type RetrieveJsonSuccess,
  type RetrieveJsonFailure,
} from "./pipeline.js";

if (isMainModule()) {
  program.parseAsync(process.argv).catch((error: unknown) => {
    console.error("[CLI] Error fatal:", formatError(error));
    process.exitCode = 1;
  });
}

function isMainModule(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}
