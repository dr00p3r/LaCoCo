import { describe, expect, it } from "vitest";
import { loadManifests } from "./load-manifests.js";
import {
  deduplicateCandidates,
  renderGroundTruthWorksheet,
  validateTaskGold,
  type RetrievalCandidate,
} from "./gold.js";

describe("ground truth helpers", () => {
  const baseTask = loadManifests().tasks.tasks[0]!;
  const pendingTask = {
    ...baseTask,
    gold: {
      ...baseTask.gold,
      status: "pending_manual_annotation",
      relevant_nodes: [],
      multihop_nodes: [],
      annotation_notes: "",
    },
  };

  it("renders candidates and an editable annotation without promoting candidates", () => {
    const candidates: RetrievalCandidate[] = [{
      strategyId: "hybrid",
      rank: 1,
      nodeId: "src/foo.ts#Foo",
      score: 0.9,
      source: "hybrid",
      text: "class Foo {}",
      filepath: "src/foo.ts",
      kind: "class",
    }];
    const worksheet = renderGroundTruthWorksheet(pendingTask, candidates);
    expect(worksheet).toContain("src/foo.ts#Foo");
    expect(worksheet).toContain("No copiar automaticamente todos los nodos recuperados.");
    expect(worksheet).toContain('    - ""');
    expect(worksheet).toContain("multihop_nodes` debe ser subconjunto");
  });

  it("deduplicates repeated candidates per strategy", () => {
    const candidates: RetrievalCandidate[] = [
      { strategyId: "hybrid", rank: 3, nodeId: "node", score: 0.8, source: "hybrid", text: "a" },
      { strategyId: "hybrid", rank: 1, nodeId: "node", score: 0.7, source: "hybrid", text: "b" },
    ];
    expect(deduplicateCandidates(candidates)).toEqual([candidates[1]]);
  });

  it("reports pending gold and graph absence as a warning", () => {
    const result = validateTaskGold(pendingTask, null, "/repo");
    expect(result.status).toBe("pending");
    expect(result.issues).toContainEqual(expect.objectContaining({
      level: "warning",
      code: "graph_unavailable",
    }));
  });

  it("rejects ready gold without nodes or target tests", () => {
    const task = {
      ...baseTask,
      target_tests: [],
      gold: { ...baseTask.gold, status: "ready", relevant_nodes: [], multihop_nodes: [] },
    };
    const result = validateTaskGold(task, null, "/repo");
    expect(result.status).toBe("invalid");
    expect(result.issues.map(({ code }) => code)).toContain("ready_without_relevant_nodes");
    expect(result.issues.map(({ code }) => code)).toContain("ready_without_target_tests");
  });

  it("requires multihop nodes to be relevant", () => {
    const task = {
      ...baseTask,
      target_tests: ["test"],
      gold: {
        ...baseTask.gold,
        status: "ready",
        relevant_nodes: ["node-a"],
        multihop_nodes: ["node-b"],
      },
    };
    expect(validateTaskGold(task, null, "/repo").issues.map(({ code }) => code))
      .toContain("multihop_not_relevant");
  });

  it("rejects empty strings in annotated lists", () => {
    const task = {
      ...baseTask,
      target_tests: [""],
      gold: {
        ...baseTask.gold,
        relevant_nodes: [""],
        multihop_nodes: [""],
      },
    };
    const result = validateTaskGold(task, null, "/repo");
    expect(result.status).toBe("invalid");
    expect(result.issues.filter(({ code }) => code === "empty_string")).toHaveLength(3);
  });
});
