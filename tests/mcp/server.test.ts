import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createLacocoMcpServer } from "../../src/mcp/server.js";
import type { RetrievalSession, RetrievedContext, SessionRetrieveParams } from "../../src/cli/index.js";

interface RecordedCall {
  query: string;
  params: SessionRetrieveParams;
}

function fakeSession(recorder: RecordedCall[]): RetrievalSession {
  return {
    async retrieve(query: string, params: SessionRetrieveParams): Promise<RetrievedContext> {
      recorder.push({ query, params });
      return {
        id: "ctx1",
        generatedAt: "2026-07-11T00:00:00.000Z",
        originalQuery: query,
        options: {
          strategy: params.strategy,
          db: "/x/tensor.sqlite",
          lancedb: "/x/lancedb",
          ollama: "http://localhost:11434",
          strategyParameters: { chunkLimit: 50 },
          maxTokens: params.maxTokens,
          templateVersion: params.template,
        },
        sanitized: params.presetSanitized ?? {
          route: "RAG",
          clean_query: query,
          embedding_input: query,
          dimensions: ["CPG"],
          intent: "understand",
          confidence: 0.5,
        },
        grounding: {
          enabled: false,
          profileBuildId: null,
          candidates: [],
          domains: [],
          usedTermIds: [],
          initialUnsupportedClauses: [],
          repairCount: 0,
          durationMs: null,
        },
        chunks: [
          {
            chunkId: "c1",
            nodeId: "/repo/dom.ts#set_attribute",
            score: 0.9,
            text: "function set_attribute() {}",
            source: "hybrid",
            location: { filepath: "/repo/dom.ts", startLine: 142, endLine: 168, truncated: false },
          },
        ],
        enrichedPrompt: "prompt",
      };
    },
    async close(): Promise<void> {},
  } as unknown as RetrievalSession;
}

async function connectClient(session: RetrievalSession): Promise<Client> {
  const server = createLacocoMcpServer({
    session,
    defaultStrategy: "hybrid",
    defaultMaxTokens: 12000,
    defaultGrounding: false,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

function parseToolText(result: unknown): { classifiedBy: string; chunks: unknown[] } {
  const content = (result as { content: { type: string; text: string }[] }).content;
  return JSON.parse(content[0]!.text) as { classifiedBy: string; chunks: unknown[] };
}

describe("createLacocoMcpServer", () => {
  it("expone la tool lacoco_retrieve", async () => {
    const client = await connectClient(fakeSession([]));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("lacoco_retrieve");
  });

  it("con clasificación completa congela el sanitizer (classifiedBy=agent, sin SLM)", async () => {
    const calls: RecordedCall[] = [];
    const client = await connectClient(fakeSession(calls));

    const result = await client.callTool({
      name: "lacoco_retrieve",
      arguments: {
        query: "arregla set_attribute",
        clean_query: '"set_attribute"',
        embedding_input: "atributo del dom",
        intent: "debug",
        dimensions: ["CPG"],
      },
    });

    const parsed = parseToolText(result);
    expect(parsed.classifiedBy).toBe("agent");
    expect(calls[0]?.params.presetSanitized?.clean_query).toBe('"set_attribute"');
    expect(calls[0]?.params.template).toBe("v2");
    const chunk = parsed.chunks[0] as { startLine: number; symbol: string };
    expect(chunk.startLine).toBe(142);
    expect(chunk.symbol).toBe("set_attribute");
  });

  it("sin clasificación cae al SLM (classifiedBy=slm, presetSanitized ausente)", async () => {
    const calls: RecordedCall[] = [];
    const client = await connectClient(fakeSession(calls));

    const result = await client.callTool({
      name: "lacoco_retrieve",
      arguments: { query: "explica OrderService" },
    });

    expect(parseToolText(result).classifiedBy).toBe("slm");
    expect(calls[0]?.params.presetSanitized).toBeUndefined();
  });

  it("devuelve isError (no crashea) si la clasificación provista es inválida", async () => {
    const client = await connectClient(fakeSession([]));

    const result = await client.callTool({
      name: "lacoco_retrieve",
      arguments: {
        query: "q",
        clean_query: "x",
        embedding_input: "y",
        intent: "debug",
        dimensions: ["CPG"],
        maxTokens: -5, // inválido a nivel de schema zod
      },
    });

    expect((result as { isError?: boolean }).isError).toBe(true);
  });
});
