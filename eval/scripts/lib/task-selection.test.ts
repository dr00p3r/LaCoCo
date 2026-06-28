import { describe, expect, it } from "vitest";
import { loadManifests } from "./load-manifests.js";
import { selectTasks } from "./task-selection.js";

describe("selectTasks", () => {
  const tasks = loadManifests().tasks.tasks;

  it("combines repository and task filters", () => {
    expect(selectTasks(tasks, { repoId: "zod", taskId: "zod-001" }).map(({ id }) => id))
      .toEqual(["zod-001"]);
  });

  it("fails clearly when filters do not match", () => {
    expect(() => selectTasks(tasks, { taskId: "missing" }))
      .toThrow("task filter matched no entries: missing");
    expect(() => selectTasks(tasks, { repoId: "zod", taskId: "rxjs-001" }))
      .toThrow("no tasks matched the combined filters");
  });
});
