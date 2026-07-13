import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createIntegrationProject,
  createIntegrationRetrieveRuntime,
  indexGraph,
  indexVectors,
  readText,
} from "./helpers.js";
import { runContextExport, runRetrieve, type CliStreams, type RetrieveJsonResult } from "../../src/cli/index.js";

describe("LaCoCo retrieval integration", () => {
  it("retrieves JSON context from real SQLite and LanceDB indexes", async () => {
    const project = createIntegrationProject("lacoco-retrieve-");
    const previousStateHome = process.env.XDG_STATE_HOME;
    try {
      process.env.XDG_STATE_HOME = project.stateHome;
      indexGraph(project);
      indexVectors(project);

      const { streams, read } = captureStreams();
      const code = await runRetrieve(
        "explica OrderService createOrder",
        {
          strategy: "hybrid",
          verbose: false,
          json: true,
          chunks: 5,
          grounding: false,
        },
        streams,
        createIntegrationRetrieveRuntime(),
        project.root,
      );
      const result = JSON.parse(read().stdout) as RetrieveJsonResult;

      expect(code).toBe(0);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.storage.sqlite).toBe(project.dbPath);
        expect(result.storage.lancedb).toBe(project.lanceDbPath);
        expect(result.retrieval.chunkCount).toBeGreaterThan(0);
        expect(result.retrieval.chunks.some((chunk) => chunk.nodeId.endsWith("#OrderService"))).toBe(true);
        expect(result.enrichedPrompt).toContain("### Contexto del Proyecto");
      }
    } finally {
      restoreEnv("XDG_STATE_HOME", previousStateHome);
      project.cleanup();
    }
  });

  it("exports markdown context with template v2 source bodies", async () => {
    const project = createIntegrationProject("lacoco-export-");
    const previousStateHome = process.env.XDG_STATE_HOME;
    const previousTemplate = process.env.LACOCO_CONTEXT_TEMPLATE;
    const output = path.join(project.root, "context.md");
    try {
      process.env.XDG_STATE_HOME = project.stateHome;
      process.env.LACOCO_CONTEXT_TEMPLATE = "v2";
      indexGraph(project);
      indexVectors(project);

      const { streams } = captureStreams();
      const code = await runContextExport(
        "explica OrderService",
        {
          strategy: "hybrid",
          verbose: false,
          json: false,
          output,
          chunks: 5,
          grounding: false,
        },
        streams,
        createIntegrationRetrieveRuntime(),
        project.root,
      );
      const markdown = readText(output);

      expect(code).toBe(0);
      expect(markdown).toContain("lacoco_export_version: 1");
      expect(markdown).toContain("question: \"explica OrderService\"");
      expect(markdown).toContain("## Retrieved Chunks");
      expect(markdown).toContain("OrderService");
      expect(markdown).toContain("createOrder(dto: CreateOrderDto)");
    } finally {
      restoreEnv("XDG_STATE_HOME", previousStateHome);
      restoreEnv("LACOCO_CONTEXT_TEMPLATE", previousTemplate);
      project.cleanup();
    }
  });
});

function captureStreams(): {
  streams: CliStreams;
  read: () => { stdout: string; stderr: string };
} {
  let stdout = "";
  let stderr = "";
  return {
    streams: {
      stdout: {
        write: (chunk) => {
          stdout += chunk.toString();
          return true;
        },
      },
      stderr: {
        write: (chunk) => {
          stderr += chunk.toString();
          return true;
        },
      },
    },
    read: () => ({ stdout, stderr }),
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
