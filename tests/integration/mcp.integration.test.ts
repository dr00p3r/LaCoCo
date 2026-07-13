import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it } from "vitest";
import {
  createIntegrationProject,
  createIntegrationRetrieveRuntime,
  indexGraph,
  indexVectors,
} from "./helpers.js";
import { RetrievalSession } from "../../src/cli/index.js";
import { createLacocoMcpServer } from "../../src/mcp/server.js";

describe("LaCoCo MCP integration", () => {
  it("serves lacoco_retrieve through the MCP client/server contract", async () => {
    const project = createIntegrationProject("lacoco-mcp-");
    const previousStateHome = process.env.XDG_STATE_HOME;
    try {
      process.env.XDG_STATE_HOME = project.stateHome;
      indexGraph(project);
      indexVectors(project);

      const session = RetrievalSession.open({
        db: project.dbPath,
        lancedb: project.lanceDbPath,
        ollamaEndpoint: "http://localhost:11434",
        runtime: createIntegrationRetrieveRuntime(),
      });
      const server = createLacocoMcpServer({
        session,
        defaultStrategy: "hybrid",
        defaultMaxTokens: 4000,
        defaultGrounding: false,
      });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "lacoco-mcp-integration", version: "1.0.0" });

      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const tools = await client.listTools();
        expect(tools.tools.map((tool) => tool.name)).toContain("lacoco_retrieve");

        const result = await client.callTool({
          name: "lacoco_retrieve",
          arguments: {
            query: "explica OrderService",
            clean_query: "OrderService OR createOrder",
            embedding_input: "flujo de crear ordenes",
            intent: "understand",
            dimensions: ["CPG", "DTG"],
            strategy: "hybrid",
            maxTokens: 4000,
          },
        });
        expect((result as { isError?: boolean }).isError).not.toBe(true);

        const content = (result as { content: { type: string; text: string }[] }).content;
        const body = JSON.parse(content[0]!.text) as {
          classifiedBy: string;
          chunks: Array<{ nodeId: string; filepath: string | null; startLine: number | null; text: string }>;
        };
        expect(body.classifiedBy).toBe("agent");
        expect(body.chunks.length).toBeGreaterThan(0);
        expect(body.chunks.some((chunk) => chunk.nodeId.endsWith("#OrderService"))).toBe(true);
        expect(body.chunks.some((chunk) => chunk.filepath === project.orderServicePath && chunk.startLine !== null)).toBe(true);
      } finally {
        await client.close();
        await server.close();
        await session.close();
      }
    } finally {
      restoreEnv("XDG_STATE_HOME", previousStateHome);
      project.cleanup();
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
