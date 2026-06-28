import type { ProjectRecord } from "./state/project-registry.js";

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => row[column]?.length ?? 0)),
  );
  const formatRow = (row: string[]) =>
    row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd();
  return [
    formatRow(headers),
    formatRow(widths.map((width) => "-".repeat(width))),
    ...rows.map(formatRow),
  ].join("\n");
}

export function formatProjectList(projects: ProjectRecord[]): string {
  if (projects.length === 0) return "No hay proyectos registrados.";
  return formatTable(
    ["PROJECT", "STATUS", "PID", "PATH"],
    projects.map((project) => [
      project.name,
      project.watcher.status,
      project.watcher.pid === null ? "-" : String(project.watcher.pid),
      project.path,
    ]),
  );
}

export function formatProjectDetails(project: ProjectRecord): string {
  return formatTable(["FIELD", "VALUE"], [
    ["id", project.id], ["name", project.name], ["path", project.path],
    ["repoRoot", project.repoRoot], ["registeredAt", project.registeredAt],
    ["lastIndexedAt", project.lastIndexedAt ?? "-"],
    ["lastIndexStatus", project.lastIndexStatus],
    ["storageDbPath", project.storage.dbPath ?? "-"],
    ["storageLanceDbPath", project.storage.lanceDbPath ?? "-"],
    ["watcherStatus", project.watcher.status],
    ["watcherPid", project.watcher.pid === null ? "-" : String(project.watcher.pid)],
    ["watcherDbPath", project.watcher.dbPath ?? "-"],
    ["watcherLanceDbPath", project.watcher.lanceDbPath ?? "-"],
  ]);
}
