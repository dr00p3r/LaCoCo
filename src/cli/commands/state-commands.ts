import type { Command } from "commander";
import {
  configKeys,
  getConfigPath,
  listConfig,
  resolveConfig,
  setConfig,
  unsetConfig,
} from "../state/config-store.js";
import {
  getProjectsPath,
  inspectProject,
  listProjects,
  registerCurrentProject,
  removeProject,
} from "../state/project-registry.js";
import { formatProjectList, formatTable } from "../formatters.js";
import {
  resolveWritableScope,
  runCliCommand,
  writeProjectResult,
  type ConfigScopeOptions,
  type JsonOption,
} from "./common.js";

export function registerStateCommands(program: Command): void {
  program
    .command("init [project-path]")
    .description("Registra el proyecto actual en el estado persistente de LaCoCo.")
    .option("--json", "Imprime JSON válido", false)
    .action((projectPath: string | undefined, options: JsonOption) => {
      runCliCommand(() => {
        const project = registerCurrentProject(projectPath ?? process.cwd());
        writeProjectResult(project, options.json);
      });
    });

  program
    .command("status [project]")
    .description("Muestra el estado registrado de un proyecto.")
    .option("--json", "Imprime JSON válido", false)
    .action((project: string | undefined, options: JsonOption) => {
      runCliCommand(() => {
        const record = project ? inspectProject(project) : inspectProject(process.cwd());
        writeProjectResult(record, options.json);
      });
    });

  registerConfigCommands(program);
  registerProjectCommands(program);
}

function registerConfigCommands(program: Command): void {
  const command = program
    .command("config")
    .description("Consulta y modifica configuración de LaCoCo.");

  command
    .command("list")
    .description("Lista las claves de configuración resueltas y su origen.")
    .option("--json", "Imprime JSON válido", false)
    .action((options: JsonOption) => {
      runCliCommand(() => {
        const entries = listConfig();
        if (options.json) {
          console.log(JSON.stringify(entries, null, 2));
          return;
        }
        console.log(formatTable(["KEY", "VALUE", "SOURCE"], entries.map((entry) => [
          entry.key,
          String(entry.value),
          entry.source,
        ])));
      });
    });

  command
    .command("get <key>")
    .description("Muestra una clave de configuración resuelta.")
    .option("--json", "Imprime JSON válido", false)
    .action((key: string, options: JsonOption) => {
      runCliCommand(() => {
        const entry = resolveConfig(key);
        console.log(options.json ? JSON.stringify(entry, null, 2) : `${entry.value} (${entry.source})`);
      });
    });

  command
    .command("set <key> <value>")
    .description("Guarda una clave de configuración en el alcance seleccionado.")
    .option("--global", "Escribe en la configuración global del usuario", false)
    .option("--local", "Escribe en la configuración local del proyecto", false)
    .option("--json", "Imprime JSON válido", false)
    .action((key: string, value: string, options: ConfigScopeOptions) => {
      runCliCommand(() => {
        const scope = resolveWritableScope(options);
        setConfig(key, value, scope);
        const entry = resolveConfig(key);
        console.log(options.json
          ? JSON.stringify({ scope, entry }, null, 2)
          : `${key}=${entry.value} escrito en ${scope}`);
      });
    });

  command
    .command("unset <key>")
    .description("Elimina una clave de configuración del alcance seleccionado.")
    .option("--global", "Elimina desde la configuración global del usuario", false)
    .option("--local", "Elimina desde la configuración local del proyecto", false)
    .option("--json", "Imprime JSON válido", false)
    .action((key: string, options: ConfigScopeOptions) => {
      runCliCommand(() => {
        const scope = resolveWritableScope(options);
        unsetConfig(key, scope);
        console.log(options.json
          ? JSON.stringify({ key, scope, unset: true }, null, 2)
          : `${key} eliminado de ${scope}`);
      });
    });

  command
    .command("path")
    .description("Muestra la ruta de archivo para configuración global o local.")
    .option("--global", "Muestra la ruta global", false)
    .option("--local", "Muestra la ruta local", false)
    .option("--json", "Imprime JSON válido", false)
    .action((options: ConfigScopeOptions) => {
      runCliCommand(() => {
        const scope = resolveWritableScope(options);
        const filePath = getConfigPath(scope);
        console.log(options.json
          ? JSON.stringify({ scope, path: filePath }, null, 2)
          : filePath);
      });
    });

  command
    .command("keys")
    .description("Lista las claves de configuración válidas.")
    .action(() => runCliCommand(() => console.log(configKeys().join("\n"))));
}

function registerProjectCommands(program: Command): void {
  const command = program
    .command("project")
    .description("Administra el registro persistente de proyectos.");

  command
    .command("list")
    .description("Lista los proyectos registrados.")
    .option("--json", "Imprime JSON válido", false)
    .action((options: JsonOption) => {
      runCliCommand(() => {
        const projects = listProjects();
        console.log(options.json ? JSON.stringify(projects, null, 2) : formatProjectList(projects));
      });
    });

  command
    .command("inspect <project>")
    .description("Muestra el detalle de un proyecto registrado.")
    .option("--json", "Imprime JSON válido", false)
    .action((project: string, options: JsonOption) => {
      runCliCommand(() => writeProjectResult(inspectProject(project), options.json));
    });

  command
    .command("remove <project>")
    .description("Elimina un proyecto del registro.")
    .option("--json", "Imprime JSON válido", false)
    .action((project: string, options: JsonOption) => {
      runCliCommand(() => {
        const removed = removeProject(project);
        console.log(options.json
          ? JSON.stringify({ removed }, null, 2)
          : `Proyecto eliminado: ${removed.name} (${removed.id})`);
      });
    });

  command
    .command("path")
    .description("Muestra la ruta del registro persistente de proyectos.")
    .action(() => runCliCommand(() => console.log(getProjectsPath())));
}
