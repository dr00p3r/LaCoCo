import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { StrategyDefinition, TaskDefinition } from "./lib/types.js";
import {
  buildPrompt,
  hasAgentSkillRetrieveEvidence,
  loadRequiredEnrichedPrompt,
  parseOpenCodeCost,
  validateRetrievalContexts,
  type RetrievalJsonlRecord,
} from "./run-generation.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "lacoco-generation-context-"));
  temporaryDirectories.push(directory);
  return directory;
}

function task(): TaskDefinition {
  return {
    id: "task-001",
    repo_id: "repo",
    title: "Task",
    type: "bugfix",
    difficulty: "small",
    prompt: "Fix the task",
    deterministic_input: {
      retrieval_input: { query: "task" },
      oracle_input: null,
      embedding_input: "Fix the task",
      intent: "debug",
      dimensions: ["CPG"],
    },
    expected_areas: [],
    target_tests: [],
    gold: {
      status: "ready",
      primary_anchor: null,
      relevant_nodes: ["src/task.ts#task"],
      multihop_nodes: [],
      annotation_notes: "fixture",
    },
    translation_gold: {
      status: "pending_manual_annotation",
      relevant_terms: [],
      annotation_notes: "fixture",
    },
  };
}

function strategy(id: string): StrategyDefinition {
  return {
    id,
    label: id,
    kind: id === "no_context" ? "baseline" : "retrieval",
    enabled: true,
    lacoco_strategy: id === "no_context" ? null : id,
    requires_lancedb: id !== "no_context",
    requires_ollama: false,
    retrieval_enabled: id !== "no_context",
    generation_enabled: true,
    parameters: {},
  };
}

function record(contextPath: string): RetrievalJsonlRecord {
  return {
    run_id: "run",
    task_id: "task-001",
    repo_id: "repo",
    strategy_id: "hybrid",
    artifact_paths: { context_json: contextPath },
  };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("generation retrieval context preflight", () => {
  it("keeps the Option B placeholder only for no_context", () => {
    const prompt = buildPrompt(task(), strategy("no_context"), null);

    expect(prompt).toContain("No hay contexto recuperado para esta tarea.");
    expect(prompt).not.toContain("context.json no encontrado");
  });

  it("loads a successful enriched prompt", () => {
    const directory = temporaryDirectory();
    const contextPath = join(directory, "context.json");
    writeFileSync(contextPath, JSON.stringify({ ok: true, enrichedPrompt: "retrieved evidence" }));

    expect(loadRequiredEnrichedPrompt(record(contextPath))).toBe("retrieved evidence");
    expect(buildPrompt(task(), strategy("hybrid"), record(contextPath)))
      .toContain("# Contexto recuperado por LaCoCo\n\nretrieved evidence");
  });

  it("renders the regression section when regressionInfo is provided", () => {
    const t = task();
    t.regression = {
      base_commit: "abcdef0123456789abcdef0123456789abcdef01",
      broken_patch: "regression/zod-001.broken.diff",
      grading_tests: ["trim"],
    };
    const prompt = buildPrompt(
      t,
      strategy("no_context"),
      null,
      {
        id: t.id,
        baseline_failing_tests: ["trim", "nested should also fail"],
        base_commit: t.regression.base_commit,
      },
    );

    expect(prompt).toContain("# Estado del repositorio");
    expect(prompt).toContain("abcdef0");
    expect(prompt).toContain("- trim");
    expect(prompt).toContain("- nested should also fail");
    // The prompt must NOT contain the broken_patch path or the word "trim()" as a leaked symbol.
    expect(prompt).not.toContain("regression/zod-001.broken.diff");
    expect(prompt).not.toContain("trim()");
  });

  it("regression section is also rendered for retrieval strategies", () => {
    const t = task();
    t.regression = {
      base_commit: "abcdef0123456789abcdef0123456789abcdef01",
      broken_patch: "regression/zod-001.broken.diff",
      grading_tests: ["trim"],
    };
    const directory = temporaryDirectory();
    const contextPath = join(directory, "context.json");
    writeFileSync(contextPath, JSON.stringify({ ok: true, enrichedPrompt: "evidence" }));
    const prompt = buildPrompt(
      t,
      strategy("ictd"),
      record(contextPath),
      {
        id: t.id,
        baseline_failing_tests: ["trim"],
        base_commit: t.regression.base_commit,
      },
    );
    expect(prompt).toContain("# Estado del repositorio");
    expect(prompt).toContain("trim");
  });

  it("fails before generation when a required context is missing", () => {
    const contextPath = join(temporaryDirectory(), "missing", "context.json");

    expect(() => validateRetrievalContexts(
      [record(contextPath)],
      [task()],
      [strategy("no_context"), strategy("hybrid")],
    )).toThrow(/required context\.json is missing/);
  });

  it("rejects unsuccessful or empty retrieval contexts", () => {
    const directory = temporaryDirectory();
    mkdirSync(directory, { recursive: true });
    const failedPath = join(directory, "failed.json");
    const emptyPath = join(directory, "empty.json");
    writeFileSync(failedPath, JSON.stringify({ ok: false, enrichedPrompt: "ignored" }));
    writeFileSync(emptyPath, JSON.stringify({ ok: true, enrichedPrompt: "" }));

    expect(() => loadRequiredEnrichedPrompt(record(failedPath))).toThrow(/not a successful retrieval/);
    expect(() => loadRequiredEnrichedPrompt(record(emptyPath))).toThrow(/has no enrichedPrompt/);
  });

  it("rejects the old mislabeled per-strategy SLM records", () => {
    const directory = temporaryDirectory();
    const contextPath = join(directory, "context.json");
    const sanitizerPath = join(directory, "sanitizer.json");
    writeFileSync(contextPath, JSON.stringify({ ok: true, enrichedPrompt: "evidence" }));
    writeFileSync(sanitizerPath, JSON.stringify({ output: { route: "RAG" } }));
    const oldRecord: RetrievalJsonlRecord = {
      ...record(contextPath),
      sanitizer_source: "agent_intermediary",
      sanitizer_variant: "deterministic",
      artifact_paths: { context_json: contextPath, sanitizer_json: sanitizerPath },
    };

    expect(() => validateRetrievalContexts(
      [oldRecord],
      [task()],
      [strategy("hybrid")],
    )).toThrow(/agent_intermediary cannot be deterministic/);
  });

  it("marca la celda para saltar (sin lanzar) cuando la tarea no tiene registro de retrieval", () => {
    // svelte-3151 style: la tarea no entró al retrieval → 0 registros. No debe
    // abortar el run; se devuelve la celda en el set de skip (continue_on_task_failure).
    const skip = validateRetrievalContexts([], [task()], [strategy("no_context"), strategy("hybrid")]);
    expect(skip.has("task-001__hybrid")).toBe(true);
    // no_context no requiere registro → no entra al set.
    expect(skip.has("task-001__no_context")).toBe(false);
  });
});

describe("OpenCode cost parsing", () => {
  it("sums provider-reported step costs", () => {
    const stdout = [
      JSON.stringify({ type: "step_finish", part: { cost: 0.25 } }),
      JSON.stringify({ type: "tool_use", part: { cost: 99 } }),
      "not json",
      JSON.stringify({ type: "step_finish", part: { cost: 0.75 } }),
    ].join("\n");

    expect(parseOpenCodeCost(stdout)).toBe(1);
  });

  it("returns null when the provider reports no cost", () => {
    expect(parseOpenCodeCost('{"type":"step_start"}')).toBeNull();
  });

  it("detects agent-skill retrieval evidence", () => {
    const stdout = [
      JSON.stringify({
        type: "tool_use",
        part: {
          type: "tool",
          tool: "bash",
          state: {
            input: { command: "printf '%s' '{}' | lacoco retrieve /repo --json" },
            output: '{ "ok": true, "contextBlock": "evidence" }',
          },
        },
      }),
    ].join("\n");
    const noContextBlock = [
      JSON.stringify({
        type: "tool_use",
        part: {
          type: "tool",
          tool: "bash",
          state: {
            input: { command: "printf '%s' '{}' | lacoco retrieve /repo --json" },
            output: '{ "ok": true, "chunks": [] }',
          },
        },
      }),
    ].join("\n");

    expect(hasAgentSkillRetrieveEvidence(stdout)).toBe(true);
    expect(hasAgentSkillRetrieveEvidence(noContextBlock)).toBe(false);
  });
});
