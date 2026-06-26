import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { AgenticStrategy } from "../../src/retriever/strategies/agentic-strategy.js";
import type { LlmClient } from "../../src/slms/llm-client.js";
import { createGraphDb, makeQuery } from "./test-helpers.js";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";

function createFakeLlm(chatResponses: string[] = []): LlmClient & { chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn();
  for (const r of chatResponses) {
    chat.mockResolvedValueOnce(r);
  }
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn(),
    chat,
  };
}

describe("AgenticStrategy", () => {
  let db: LaCoCoDatabase;

  beforeEach(() => {
    db = createGraphDb();
  });

  afterEach(() => {
    db.close();
  });

  it("usa el fallback deterministico cuando Ollama no esta disponible", async () => {
    const ollama = createFakeLlm();
    ollama.isAvailable = vi.fn().mockResolvedValue(false);

    const strategy = new AgenticStrategy(db, ollama);
    const chunks = await strategy.retrieve(makeQuery("OrderService", ["CPG"]));

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.source === "AGENTIC")).toBe(true);
    expect(ollama.isAvailable).toHaveBeenCalledOnce();
    expect(ollama.chat).not.toHaveBeenCalled();
  });

  it("recupera semillas BM25 y vecinos en modo determinista", async () => {
    const ollama = createFakeLlm();
    ollama.isAvailable = vi.fn().mockResolvedValue(false);

    const strategy = new AgenticStrategy(db, ollama);
    const chunks = await strategy.retrieve(makeQuery("OrderService", ["CPG"]));

    const nodeIds = chunks.map((c) => c.nodeId);
    expect(nodeIds).toContain("file1#OrderService");
    expect(nodeIds.length).toBeGreaterThan(1);
  });

  it("no duplica nodos entre iteraciones del fallback", async () => {
    const ollama = createFakeLlm();
    ollama.isAvailable = vi.fn().mockResolvedValue(false);

    const strategy = new AgenticStrategy(db, ollama);
    const chunks = await strategy.retrieve(makeQuery("OrderService", ["CPG"]));

    const ids = chunks.map((c) => c.nodeId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("planea herramientas con el SLM y ejecuta get_neighbors", async () => {
    const ollama = createFakeLlm([
      JSON.stringify({ name: "get_neighbors", params: { node_id: "file1#OrderService" } }),
      JSON.stringify({ name: "get_neighbors", params: { node_id: "file1#OrderService.createOrder" } }),
      JSON.stringify({ done: true }),
    ]);

    const strategy = new AgenticStrategy(db, ollama);
    const chunks = await strategy.retrieve(makeQuery("OrderService", ["CPG"]));

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((c) => c.source === "AGENTIC")).toBe(true);
    expect(ollama.chat).toHaveBeenCalled();
  });

  it("planea herramientas con el SLM y ejecuta get_node_by_symbol", async () => {
    const ollama = createFakeLlm([
      JSON.stringify({ name: "get_node_by_symbol", params: { name: "OrderService" } }),
      JSON.stringify({ done: true }),
    ]);

    const strategy = new AgenticStrategy(db, ollama);
    const chunks = await strategy.retrieve(makeQuery("OrderService", ["CPG"]));

    expect(chunks.some((c) => c.nodeId === "file1#OrderService")).toBe(true);
  });

  it("detiene el ciclo cuando el SLM devuelve done", async () => {
    const ollama = createFakeLlm([
      JSON.stringify({ done: true }),
    ]);

    const strategy = new AgenticStrategy(db, ollama);
    const chunks = await strategy.retrieve(makeQuery("OrderService", ["CPG"]));

    expect(ollama.chat).toHaveBeenCalledTimes(1);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("maneja respuestas SLM invalidas sin crashear", async () => {
    const ollama = createFakeLlm([
      "respuesta invalida sin JSON",
      JSON.stringify({ done: true }),
    ]);

    const strategy = new AgenticStrategy(db, ollama);
    const chunks = await strategy.retrieve(makeQuery("OrderService", ["CPG"]));

    expect(ollama.chat).toHaveBeenCalledOnce();
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("ordena chunks por score descendente", async () => {
    const ollama = createFakeLlm();
    ollama.isAvailable = vi.fn().mockResolvedValue(false);

    const strategy = new AgenticStrategy(db, ollama);
    const chunks = await strategy.retrieve(makeQuery("OrderService", ["CPG"]));

    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i - 1]!.score).toBeGreaterThanOrEqual(chunks[i]!.score);
    }
  });
});
