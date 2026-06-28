import type { TaskDefinition } from "./types.js";

export interface TaskSelection {
  repoId?: string;
  taskId?: string;
}

export function selectTasks(
  tasks: TaskDefinition[],
  selection: TaskSelection,
): TaskDefinition[] {
  if (selection.repoId !== undefined && !tasks.some(({ repo_id }) => repo_id === selection.repoId)) {
    throw new Error(`repository filter matched no tasks: ${selection.repoId}`);
  }
  if (selection.taskId !== undefined && !tasks.some(({ id }) => id === selection.taskId)) {
    throw new Error(`task filter matched no entries: ${selection.taskId}`);
  }
  const selected = tasks.filter((task) =>
    (selection.repoId === undefined || task.repo_id === selection.repoId) &&
    (selection.taskId === undefined || task.id === selection.taskId),
  );
  if (selected.length === 0) {
    throw new Error("no tasks matched the combined filters");
  }
  return selected;
}
