import { describe, expect, it, vi } from "vitest";
import { SlmClassifier } from "../../src/retriever/utilities/mini-agents/agent-intermediary/classifier.js";
import type { LlmClient } from "../../src/slms/llm-client.js";

function createClassifier(response: string): SlmClassifier {
  const ollama = {
    chat: vi.fn().mockResolvedValue(response),
  } as unknown as LlmClient;
  return new SlmClassifier(ollama);
}

function createRetryingClassifier(
  firstResponse: string,
  secondResponse: string
): { classifier: SlmClassifier; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn()
    .mockResolvedValueOnce(firstResponse)
    .mockResolvedValueOnce(secondResponse);
  const ollama = { chat } as unknown as LlmClient;
  return { classifier: new SlmClassifier(ollama), chat };
}

describe("SlmClassifier", () => {
  it("acepta la transformación completa emitida por el SLM", async () => {
    const output = {
      route: "RAG",
      clean_query: '"OrderService" OR "save"',
      embedding_input: "Depurar OrderService save",
      dimensions: ["CPG", "DTG"],
      intent: "debug",
      confidence: 0.92,
    };

    await expect(
      createClassifier(JSON.stringify(output)).classify("por qué falla save")
    ).resolves.toEqual(output);
  });

  it("rechaza respuestas sin consultas generadas por el SLM", async () => {
    const incomplete = {
      route: "RAG",
      dimensions: ["CPG"],
      intent: "understand",
      confidence: 0.9,
    };

    await expect(
      createClassifier(JSON.stringify(incomplete)).classify("explica OrderService")
    ).rejects.toThrow("después de dos intentos");
  });

  it("rechaza valores semánticos inválidos sin reemplazarlos", async () => {
    const invalid = {
      route: "MAYBE",
      clean_query: '"OrderService"',
      embedding_input: "Explicar OrderService",
      dimensions: ["CPG"],
      intent: "understand",
      confidence: 0.9,
    };

    await expect(
      createClassifier(JSON.stringify(invalid)).classify("explica OrderService")
    ).rejects.toThrow("después de dos intentos");
  });

  it("rechaza una ruta RAG sin consulta FTS5", async () => {
    const invalid = {
      route: "RAG",
      clean_query: "",
      embedding_input: "Explicar OrderService",
      dimensions: ["CPG"],
      intent: "understand",
      confidence: 0.9,
    };

    await expect(
      createClassifier(JSON.stringify(invalid)).classify("explica OrderService")
    ).rejects.toThrow("después de dos intentos");
  });

  it("pide al SLM reparar una primera respuesta con comillas simples", async () => {
    const malformed = `{'route':'RAG','clean_query':'"HybridStrategy"','embedding_input':'Explicar HybridStrategy','dimensions':['CPG'],'intent':'understand','confidence':0.9}`;
    const valid = {
      route: "RAG",
      clean_query: '"HybridStrategy"',
      embedding_input: "Explicar HybridStrategy",
      dimensions: ["CPG"],
      intent: "understand",
      confidence: 0.9,
    };
    const { classifier, chat } = createRetryingClassifier(
      malformed,
      JSON.stringify(valid)
    );

    await expect(classifier.classify("explica hybrid strategy")).resolves.toEqual(valid);
    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat).toHaveBeenNthCalledWith(1, expect.any(Array), structuredOptions());
    expect(chat).toHaveBeenNthCalledWith(2, expect.any(Array), structuredOptions());
  });

  it("pide al SLM verificar cualquier decisión LLM_DIRECT", async () => {
    const direct = {
      route: "LLM_DIRECT",
      clean_query: "",
      embedding_input: "Modify hybrid recovery chunks",
      dimensions: [],
      intent: "refactor",
      confidence: 0.98,
    };
    const corrected = {
      route: "RAG",
      clean_query: '"recovery chunks" OR "hybrid" OR "strategies"',
      embedding_input: "Modify hybrid-based recovery strategies to return only 20 chunks",
      dimensions: ["CPG"],
      intent: "refactor",
      confidence: 0.99,
    };
    const { classifier, chat } = createRetryingClassifier(
      JSON.stringify(direct),
      JSON.stringify(corrected),
    );

    await expect(classifier.classify(
      "modify the recovery chunks of the strategies based on hybrid to be only 20",
    )).resolves.toEqual(corrected);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(chat.mock.calls[1]?.[0]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        role: "user",
        content: expect.stringContaining("Verifica de forma independiente"),
      }),
    ]));
  });
});

function structuredOptions(): ReturnType<typeof expect.objectContaining> {
  return expect.objectContaining({
    format: expect.objectContaining({
      type: "object",
      additionalProperties: false,
      required: [
        "route",
        "clean_query",
        "embedding_input",
        "dimensions",
        "intent",
        "confidence",
      ],
    }),
    options: { temperature: 0, seed: 42, num_predict: 256 },
  });
}
