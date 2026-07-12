import { describe, expect, it, vi } from "vitest";
import { RetrievalSession, type RetrieveRuntime } from "../../src/cli/index.js";
import type { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import type { RecoveryStrategy } from "../../src/retriever/models/strategies/types.js";
import type { SanitizerOutput } from "../../src/retriever/models/utilities/types.js";

const PRESET: SanitizerOutput = {
  route: "RAG",
  clean_query: "OrderService",
  embedding_input: "servicio de pedidos",
  dimensions: ["CPG"],
  intent: "understand",
  confidence: 0.9,
};

function fakeDb(): LaCoCoDatabase {
  return {
    close: vi.fn(),
    getRawDb: () => ({}),
    getNodeSpans: () => new Map(),
  } as unknown as LaCoCoDatabase;
}

function fakeStrategy(chunkText: string): RecoveryStrategy {
  return {
    retrieve: async () => [
      { chunkId: "n1", nodeId: "file#Sym", score: 1, text: chunkText, source: "hybrid" },
    ],
  };
}

interface Harness {
  runtime: RetrieveRuntime;
  createStrategy: ReturnType<typeof vi.fn>;
  sanitize: ReturnType<typeof vi.fn>;
  dbClose: ReturnType<typeof vi.fn>;
  abort: ReturnType<typeof vi.fn>;
}

function harness(overrides: { sanitize?: () => Promise<SanitizerOutput> } = {}): Harness {
  const db = fakeDb();
  const dbClose = db.close as unknown as ReturnType<typeof vi.fn>;
  const abort = vi.fn();
  const sanitize = vi.fn(overrides.sanitize ?? (async () => PRESET));
  const createStrategy = vi.fn(async () => ({ strategy: fakeStrategy("class OrderService {}") }));

  const runtime: RetrieveRuntime = {
    createDatabase: () => db,
    createOllama: () => ({
      isAvailable: async () => true,
      generate: async () => "",
      chat: async () => "",
      abort,
    }),
    createIntermediary: () => ({ sanitize }),
    createStrategy,
  };
  return { runtime, createStrategy, sanitize, dbClose, abort };
}

describe("RetrievalSession", () => {
  const baseParams = { strategy: "hybrid", maxTokens: 4000, grounding: false, template: "v1" };

  it("reutiliza la estrategia y la db entre llamadas (crea la estrategia una sola vez)", async () => {
    const h = harness();
    const session = RetrievalSession.open({
      db: "/x/tensor.sqlite",
      lancedb: "/x/lancedb",
      ollamaEndpoint: "http://localhost:11434",
      runtime: h.runtime,
    });

    await session.retrieve("consulta A", baseParams);
    await session.retrieve("consulta B", baseParams);

    expect(h.createStrategy).toHaveBeenCalledTimes(1);
    await session.close();
    expect(h.dbClose).toHaveBeenCalledTimes(1);
    expect(h.abort).toHaveBeenCalledTimes(1);
  });

  it("con clasificación pre-validada NO llama al clasificador SLM", async () => {
    const h = harness();
    const session = RetrievalSession.open({
      db: "/x/tensor.sqlite",
      lancedb: "/x/lancedb",
      ollamaEndpoint: "http://localhost:11434",
      runtime: h.runtime,
    });

    const ctx = await session.retrieve("cualquier prompt", { ...baseParams, presetSanitized: PRESET });

    expect(h.sanitize).not.toHaveBeenCalled();
    expect(ctx.sanitized.clean_query).toBe("OrderService");
    expect(ctx.chunks).toHaveLength(1);
    await session.close();
  });

  it("un error de Ollama en la 1ª llamada no impide la 2ª", async () => {
    let call = 0;
    const h = harness({
      sanitize: async () => {
        call += 1;
        if (call === 1) throw new Error("Ollama caído");
        return PRESET;
      },
    });
    const session = RetrievalSession.open({
      db: "/x/tensor.sqlite",
      lancedb: "/x/lancedb",
      ollamaEndpoint: "http://localhost:11434",
      runtime: h.runtime,
    });

    await expect(session.retrieve("A", baseParams)).rejects.toThrow("Ollama caído");
    const ctx = await session.retrieve("B", baseParams);
    expect(ctx.chunks).toHaveLength(1);
    await session.close();
  });
});
