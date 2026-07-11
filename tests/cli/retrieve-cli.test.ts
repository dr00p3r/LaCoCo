import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { Bm25Service } from "../../src/retriever/utilities/search/bm25-service.js";
import type { RecoveryStrategy } from "../../src/retriever/models/strategies/types.js";
import {
  runContextExport,
  runRetrieve,
  type CliStreams,
  type ContextExportCliOptions,
  type RetrieveCliOptions,
  type RetrieveJsonResult,
  type RetrieveRuntime,
} from "../../src/cli/index.js";
import {
  configureProjectStorage,
  type ProjectRecord,
} from "../../src/cli/state/project-registry.js";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

describe("lacoco retrieve CLI", () => {
  it("recupera contexto desde una query estructurada sin intermediario local", async () => {
    const temp = createTempIndexedDb();
    try {
      const result = await runRetrieveWithFakes(structuredInput(), temp.project.id);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain("### Contexto del Proyecto");
      expect(result.stdout).toContain("file1#OrderService");
      expect(result.stderr).not.toContain("fts5:");
    } finally {
      temp.cleanup();
    }
  });

  it("devuelve JSON v3 con contextBlock y metadata de recuperación", async () => {
    const temp = createTempIndexedDb();
    try {
      const { streams, read } = createCapturedStreams();
      const code = await runRetrieve(
        structuredInput({ strategy: "agentic" }),
        { verbose: false, json: true },
        streams,
        createFakeRuntime(),
        temp.project.id,
      );
      const result = JSON.parse(read().stdout) as RetrieveJsonResult;

      expect(code).toBe(0);
      expect(result).toMatchObject({
        schemaVersion: 3,
        ok: true,
        originalPrompt: "Modifica OrderService",
        strategy: "agentic",
        query: {
          intent: "refactor",
          dimensions: ["CPG"],
          cleanQuery: '"OrderService"',
        },
        retrieval: {
          strategyParameters: { chunkLimit: 50 },
          maxTokens: 4000,
        },
      });
      if (result.ok) {
        expect(result.contextBlock).toContain("### Contexto del Proyecto");
        expect(result.retrieval.chunkCount).toBe(result.retrieval.chunks.length);
        expect(result.retrieval.chunks[0]?.nodeId).toBe("file1#OrderService");
      }
    } finally {
      temp.cleanup();
    }
  });

  it("aplica overrides de CLI sobre strategy/chunks/maxTokens del JSON", async () => {
    const temp = createTempIndexedDb();
    try {
      const { streams, read } = createCapturedStreams();
      const code = await runRetrieve(
        structuredInput({ strategy: "hybrid", chunks: 10, maxTokens: 4000 }),
        { strategy: "agentic", chunks: 1, maxTokens: 1, verbose: false, json: true },
        streams,
        createFakeRuntime(),
        temp.project.id,
      );
      const result = JSON.parse(read().stdout) as RetrieveJsonResult;

      expect(code).toBe(0);
      expect(result.ok && result.strategy).toBe("agentic");
      expect(result.ok && result.retrieval.strategyParameters.chunkLimit).toBe(1);
      expect(result.ok && result.retrieval.maxTokens).toBe(1);
      expect(result.ok && result.retrieval.chunkCount).toBe(0);
    } finally {
      temp.cleanup();
    }
  });

  it("rechaza JSON inválido con salida parseable", async () => {
    const { streams, read } = createCapturedStreams();
    const code = await runRetrieve(
      "{",
      { verbose: false, json: true },
      streams,
      createFakeRuntime(),
    );
    const result = JSON.parse(read().stdout) as RetrieveJsonResult;

    expect(code).toBe(1);
    expect(result).toEqual({
      schemaVersion: 3,
      ok: false,
      error: {
        stage: "entrada estructurada",
        message: "stdin debe contener JSON válido",
      },
    });
  });

  it("rechaza dimensiones inválidas antes de ejecutar estrategia", async () => {
    const { streams, read } = createCapturedStreams();
    const code = await runRetrieve(
      JSON.stringify({
        ...JSON.parse(structuredInput()),
        dimensions: ["BAD"],
      }),
      { verbose: false, json: true },
      streams,
      createFakeRuntime(),
    );

    expect(code).toBe(1);
    expect(read().stderr).toContain("dimensions debe contener valores únicos");
  });

  it("usa rutas de almacenamiento registradas", async () => {
    const temp = createTempIndexedDb();
    const capture: RuntimeCapture = {};

    try {
      const { streams } = createCapturedStreams();
      const code = await runRetrieve(
        structuredInput(),
        { verbose: false },
        streams,
        createFakeRuntime(capture),
        temp.project.id,
      );

      expect(code).toBe(0);
      expect(capture.dbPath).toBe(temp.dbPath);
      expect(capture.lanceDbPath).toBe(path.join(temp.dir, ".lacoco", "lancedb"));
    } finally {
      temp.cleanup();
    }
  });

  it("exporta contexto estructurado a Markdown", async () => {
    const temp = createTempIndexedDb();
    const output = path.join(temp.dir, "contexto.md");
    try {
      const { streams, read } = createCapturedStreams();
      const options: ContextExportCliOptions = {
        strategy: "agentic",
        verbose: false,
        json: false,
        output,
      };

      const code = await runContextExport(structuredInput(), options, streams, createFakeRuntime(), temp.project.id);
      const markdown = readFileSync(output, "utf-8");

      expect(code).toBe(0);
      expect(read().stdout).toContain(`Contexto exportado: ${output}`);
      expect(existsSync(output)).toBe(true);
      expect(markdown).toContain("lacoco_export_version: 2");
      expect(markdown).toContain('question: "Modifica OrderService"');
      expect(markdown).toContain("## Context Block");
      expect(markdown).toContain("file1#OrderService");
    } finally {
      temp.cleanup();
    }
  });
});

async function runRetrieveWithFakes(input: string, projectId: string): Promise<CliResult> {
  const { streams, read } = createCapturedStreams();
  const options: RetrieveCliOptions = {
    strategy: "agentic",
    verbose: false,
  };

  const code = await runRetrieve(input, options, streams, createFakeRuntime(), projectId);
  return { code, ...read() };
}

function structuredInput(overrides: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    originalPrompt: "Modifica OrderService",
    clean_query: '"OrderService"',
    embedding_input: "Modificar OrderService",
    intent: "refactor",
    dimensions: ["CPG"],
    confidence: 0.9,
    ...overrides,
  });
}

function createCapturedStreams(): {
  streams: CliStreams;
  read: () => { stdout: string; stderr: string };
} {
  let stdout = "";
  let stderr = "";
  const streams: CliStreams = {
    stdout: {
      write: (chunk: string | Uint8Array) => {
        stdout += chunk.toString();
        return true;
      },
    },
    stderr: {
      write: (chunk: string | Uint8Array) => {
        stderr += chunk.toString();
        return true;
      },
    },
  };

  return {
    streams,
    read: () => ({ stdout, stderr }),
  };
}

interface RuntimeCapture {
  dbPath?: string;
  lanceDbPath?: string;
  strategyName?: string;
  strategyOptions?: { chunks?: number };
}

function createFakeRuntime(capture?: RuntimeCapture): RetrieveRuntime {
  return {
    createDatabase: (pathToDb) => {
      if (capture) capture.dbPath = pathToDb;
      return new LaCoCoDatabase(pathToDb);
    },
    createStrategy: async (
      strategyName,
      db,
      lanceDbPath,
      strategyOptions,
    ) => {
      if (capture) {
        capture.strategyName = strategyName;
        capture.lanceDbPath = lanceDbPath;
        capture.strategyOptions = strategyOptions;
      }
      const strategy = createBm25Strategy(db);
      return {
        strategy: strategyOptions?.chunks === undefined
          ? strategy
          : {
              async retrieve(query) {
                return (await strategy.retrieve(query)).slice(0, strategyOptions.chunks);
              },
            },
      };
    },
  };
}

function createBm25Strategy(db: LaCoCoDatabase): RecoveryStrategy {
  const bm25 = new Bm25Service(db);
  return {
    async retrieve(query) {
      return bm25.toChunks(bm25.search(query.clean_query, 10), "BM25");
    },
  };
}

function createTempIndexedDb(): {
  dir: string;
  dbPath: string;
  project: ProjectRecord;
  cleanup: () => void;
} {
  const previousCwd = process.cwd();
  const previousStateHome = process.env.XDG_STATE_HOME;
  const dir = mkdtempSync(path.join(tmpdir(), "lacoco-cli-"));
  const dbPath = path.join(dir, "tensor.sqlite");
  mkdirSync(path.join(dir, ".git"));
  process.env.XDG_STATE_HOME = path.join(dir, "state-home");
  process.chdir(dir);

  const lanceDbPath = path.join(dir, ".lacoco", "lancedb");
  const project = configureProjectStorage(dir, { dbPath, lanceDbPath });

  const db = new LaCoCoDatabase(dbPath);

  db.insertNode({
    id: "file1#OrderService",
    kind: "CLASS",
    name: "OrderService",
    filepath: "/project/src/order.service.ts",
    signature: "class OrderService extends BaseService implements IHandler",
    isDeprecated: 0,
  });
  db.insertNode({
    id: "file1#OrderService.createOrder",
    kind: "METHOD",
    name: "createOrder",
    filepath: "/project/src/order.service.ts",
    signature: "createOrder(dto: CreateOrderDto): Promise<Order>",
    isDeprecated: 0,
  });
  db.insertNode({
    id: "file1#CreateOrderDto",
    kind: "TYPE",
    name: "CreateOrderDto",
    filepath: "/project/src/order.dto.ts",
    signature: "type CreateOrderDto = { amount: number }",
    isDeprecated: 0,
  });
  db.insertEdge({
    sourceId: "file1#OrderService",
    targetId: "file1#OrderService.createOrder",
    relation: "CALLS",
  });
  db.insertEdge({
    sourceId: "file1#OrderService.createOrder",
    targetId: "file1#CreateOrderDto",
    relation: "CONSUMES_DATA",
  });
  db.populateMetadata();
  db.close();

  return {
    dir,
    dbPath,
    project,
    cleanup: () => {
      process.chdir(previousCwd);
      restoreEnv("XDG_STATE_HOME", previousStateHome);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
