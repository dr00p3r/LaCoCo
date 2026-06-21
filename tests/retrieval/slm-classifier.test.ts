import { describe, expect, it, vi } from "vitest";
import { SlmClassifier } from "../../src/retriever/utilities/mini-agents/agent-intermediary/classifier.js";
import type { OllamaService } from "../../src/slms/ollama-service.js";

function createClassifier(response: string): SlmClassifier {
  const ollama = {
    chat: vi.fn().mockResolvedValue(response),
  } as unknown as OllamaService;
  return new SlmClassifier(ollama);
}

function createRetryingClassifier(
  firstResponse: string,
  secondResponse: string
): { classifier: SlmClassifier; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn()
    .mockResolvedValueOnce(firstResponse)
    .mockResolvedValueOnce(secondResponse);
  const ollama = { chat } as unknown as OllamaService;
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
    expect(chat).toHaveBeenNthCalledWith(1, expect.any(Array), { format: "json" });
    expect(chat).toHaveBeenNthCalledWith(2, expect.any(Array), { format: "json" });
  });
});
