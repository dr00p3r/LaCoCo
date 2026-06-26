import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentIntermediary1 } from "../../src/retriever/utilities/mini-agents/agent-intermediary/index.js";
import { SlmClassifier } from "../../src/retriever/utilities/mini-agents/agent-intermediary/classifier.js";

const { classifyMock } = vi.hoisted(() => ({
  classifyMock: vi.fn(),
}));

vi.mock("../../src/retriever/utilities/mini-agents/agent-intermediary/classifier.js", () => {
  class MockSlmClassifier {
    classify = classifyMock;
  }
  return { SlmClassifier: MockSlmClassifier };
});

describe("AgentIntermediary1", () => {
  beforeEach(() => {
    classifyMock.mockReset();
  });

  it("delega al SLM la transformación completa del prompt", async () => {
    const slmOutput = {
      route: "RAG",
      clean_query: '"OrderService" OR "async" OR "await"',
      embedding_input: "Refactorizar OrderService para usar async/await",
      dimensions: ["CPG"],
      intent: "refactor",
      confidence: 0.96,
    };
    classifyMock.mockResolvedValue(slmOutput);

    const result = await new AgentIntermediary1(new SlmClassifier()).sanitize(
      "  refactoriza OrderService para usar async/await  "
    );

    expect(classifyMock).toHaveBeenCalledOnce();
    expect(classifyMock).toHaveBeenCalledWith("refactoriza OrderService para usar async/await");
    expect(result).toBe(slmOutput);
  });

  it("propaga fallos del SLM sin aplicar fallback local", async () => {
    classifyMock.mockRejectedValue(new Error("SLM no disponible"));

    await expect(
      new AgentIntermediary1(new SlmClassifier()).sanitize("explica OrderService")
    ).rejects.toThrow("SLM no disponible");
  });

  it("rechaza prompts vacíos antes de invocar el modelo", async () => {
    await expect(new AgentIntermediary1(new SlmClassifier()).sanitize("   ")).rejects.toThrow(
      "El prompt no puede estar vacío"
    );
    expect(classifyMock).not.toHaveBeenCalled();
  });
});
