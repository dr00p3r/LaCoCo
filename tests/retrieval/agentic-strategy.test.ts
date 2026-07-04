import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgenticPlanningError,
  AgenticStrategy,
} from "../../src/retriever/strategies/agentic-strategy.js";
import type { LlmClient } from "../../src/slms/llm-client.js";
import { createGraphDb, makeQuery } from "./test-helpers.js";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";

function createFakeLlm(chatResponses: string[] = []): LlmClient & { chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn();
  for (const response of chatResponses) chat.mockResolvedValueOnce(response);
  return {
    abort: vi.fn(),
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

  it("falla explícitamente cuando Ollama no está disponible", async () => {
    const ollama = createFakeLlm();
    ollama.isAvailable = vi.fn().mockResolvedValue(false);

    await expect(
      new AgenticStrategy(db, ollama).retrieve(makeQuery("OrderService", ["CPG"])),
    ).rejects.toThrow("Ollama no disponible");
    expect(ollama.chat).not.toHaveBeenCalled();
  });

  it("acepta done y conserva las semillas BM25", async () => {
    const ollama = createFakeLlm([JSON.stringify({ action: "done" })]);
    const chunks = await new AgenticStrategy(db, ollama)
      .retrieve(makeQuery("OrderService", ["CPG"]));

    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.source === "AGENTIC")).toBe(true);
    expect(ollama.chat).toHaveBeenCalledTimes(1);
    expect(ollama.chat).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({
      format: expect.objectContaining({ oneOf: expect.any(Array) }),
      options: { temperature: 0, seed: 42, num_predict: 128 },
    }));
  });

  it("valida y ejecuta get_neighbors sobre un nodo conocido", async () => {
    const ollama = createFakeLlm([
      JSON.stringify({ action: "get_neighbors", node_id: "file1#OrderService" }),
      JSON.stringify({ action: "done" }),
    ]);
    const chunks = await new AgenticStrategy(db, ollama)
      .retrieve(makeQuery("OrderService", ["CPG"]));

    expect(chunks.some((chunk) => chunk.nodeId === "file1#OrderService.createOrder")).toBe(true);
  });

  it("valida y ejecuta get_node_by_symbol", async () => {
    const ollama = createFakeLlm([
      JSON.stringify({ action: "get_node_by_symbol", name: "CreateOrderDto" }),
      JSON.stringify({ action: "done" }),
    ]);
    const chunks = await new AgenticStrategy(db, ollama)
      .retrieve(makeQuery("OrderService", ["CPG"]));

    expect(chunks.some((chunk) => chunk.nodeId === "file1#CreateOrderDto")).toBe(true);
  });

  it("rechaza parámetros incompletos o mal tipados después del reintento", async () => {
    const ollama = createFakeLlm([
      JSON.stringify({ action: "get_neighbors", node_id: 42 }),
      JSON.stringify({ action: "get_neighbors" }),
    ]);

    await expect(
      new AgenticStrategy(db, ollama).retrieve(makeQuery("OrderService", ["CPG"])),
    ).rejects.toBeInstanceOf(AgenticPlanningError);
    expect(ollama.chat).toHaveBeenCalledTimes(2);
  });

  it("rechaza identificadores inventados por el planificador", async () => {
    const response = JSON.stringify({ action: "get_neighbors", node_id: "inventado" });
    const ollama = createFakeLlm([response, response]);

    await expect(
      new AgenticStrategy(db, ollama).retrieve(makeQuery("OrderService", ["CPG"])),
    ).rejects.toThrow("incumplió el contrato");
  });

  it("rechaza propiedades adicionales aunque Ollama ignore el esquema", async () => {
    const response = JSON.stringify({ action: "done", explanation: "enough" });
    const ollama = createFakeLlm([response, response]);

    await expect(
      new AgenticStrategy(db, ollama).retrieve(makeQuery("OrderService", ["CPG"])),
    ).rejects.toBeInstanceOf(AgenticPlanningError);
  });

  it("no permite ampliar el máximo de iteraciones del contrato", () => {
    expect(() => new AgenticStrategy(db, createFakeLlm(), { maxIterations: 4 }))
      .toThrow("maxIterations no puede superar 3");
  });

  it("aplica un límite final estricto de chunks", async () => {
    const ollama = createFakeLlm();
    const chunks = await new AgenticStrategy(db, ollama, { chunkLimit: 1 })
      .retrieve(makeQuery("OrderService", ["CPG"]));

    expect(chunks).toHaveLength(1);
    expect(ollama.chat).not.toHaveBeenCalled();
  });

  it("ordena chunks por score descendente", async () => {
    const ollama = createFakeLlm([JSON.stringify({ action: "done" })]);
    const chunks = await new AgenticStrategy(db, ollama)
      .retrieve(makeQuery("OrderService", ["CPG"]));

    for (let index = 1; index < chunks.length; index++) {
      expect(chunks[index - 1]!.score).toBeGreaterThanOrEqual(chunks[index]!.score);
    }
  });
});
