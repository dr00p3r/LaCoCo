import { describe, it, expect, vi } from "vitest";
import { HydeGenerator, applyHyde } from "../../src/retriever/utilities/mini-agents/agent-intermediary/hyde-generator.js";
import type { LlmClient } from "../../src/slms/llm-client.js";
import type { SanitizerOutput } from "../../src/retriever/models/utilities/types.js";

function mockClient(responses: string[]): LlmClient {
  let call = 0;
  return {
    abort: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn(),
    chat: vi.fn().mockImplementation(() => Promise.resolve(responses[call++] ?? "")),
  };
}

function ragQuery(embeddingInput = "por qué falla save"): SanitizerOutput {
  return {
    route: "RAG",
    clean_query: '"save"',
    embedding_input: embeddingInput,
    dimensions: ["CPG"],
    intent: "debug",
    confidence: 0.9,
  };
}

describe("HydeGenerator", () => {
  it("extrae el snippet del JSON del SLM", async () => {
    const client = mockClient([JSON.stringify({ snippet: "function save(x: Order) { repo.persist(x); }" })]);
    const snippet = await new HydeGenerator(client).generate("por qué falla save");
    expect(snippet).toContain("function save");
  });

  it("repara una vez ante salida inválida", async () => {
    const client = mockClient(["no soy json", JSON.stringify({ snippet: "const x = 1;" })]);
    const snippet = await new HydeGenerator(client).generate("crea x");
    expect(snippet).toBe("const x = 1;");
    expect(client.chat).toHaveBeenCalledTimes(2);
  });

  it("lanza si ambos intentos fallan", async () => {
    const client = mockClient(["basura", "mas basura"]);
    await expect(new HydeGenerator(client).generate("algo")).rejects.toThrow();
  });
});

describe("applyHyde", () => {
  it("reemplaza embedding_input y deja clean_query intacto en RAG", async () => {
    const client = mockClient([JSON.stringify({ snippet: "class OrderService { createOrder() {} }" })]);
    const query = ragQuery();
    const outcome = await applyHyde(query, "crea OrderService", client);
    expect(outcome.applied).toBe(true);
    expect(outcome.sanitizer.embedding_input).toContain("OrderService");
    expect(outcome.sanitizer.clean_query).toBe('"save"'); // canal BM25 sin tocar
  });

  it("cae de vuelta al embedding_input original si el SLM falla", async () => {
    const client = mockClient(["no-json", "tampoco-json"]);
    const query = ragQuery("texto original");
    const outcome = await applyHyde(query, "algo", client);
    expect(outcome.applied).toBe(false);
    expect(outcome.error).toBeDefined();
    expect(outcome.sanitizer.embedding_input).toBe("texto original");
  });

  it("no toca sanitizers LLM_DIRECT (no llama al SLM)", async () => {
    const client = mockClient([]);
    const query: SanitizerOutput = { ...ragQuery(), route: "LLM_DIRECT", clean_query: "", dimensions: [] };
    const outcome = await applyHyde(query, "qué es typescript", client);
    expect(outcome.applied).toBe(false);
    expect(client.chat).not.toHaveBeenCalled();
  });
});
