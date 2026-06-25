import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  type RetrieveRuntime,
} from "../../src/cli/index.js";

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

describe("lacoco retrieve CLI", () => {
  it.each([
    ["sin caracteres especiales", "OrderService"],
    ["con paréntesis", "OrderService(save)"],
    ["con paréntesis anidados", "OrderService(createOrder(dto))"],
    ["con comillas simples", "OrderService's save"],
    ["con comillas dobles", 'OrderService "save"'],
    ["con comilla invertida real", "`"],
    ["con saltos de línea", "OrderService\ncreateOrder"],
    ["con unicode", "qué hace OrderService"],
  ])("finaliza sin error para consultas %s", async (_label, query) => {
    const temp = createTempIndexedDb();
    try {
      const result = await runRetrieveWithFakes(query, temp.dbPath);

      expect(result.code).toBe(0);
      expect(result.stdout.length).toBeGreaterThan(0);
      expect(result.stderr).not.toContain("fts5:");
      expect(result.stderr).not.toMatch(/\n\s+at\s/u);
    } finally {
      temp.cleanup();
    }
  });

  it("rechaza consultas vacías con stderr y código distinto de cero", async () => {
    const temp = createTempIndexedDb();
    try {
      const result = await runRetrieveWithFakes("", temp.dbPath);

      expect(result.code).not.toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("El prompt no puede estar vacío");
      expect(result.stderr).not.toMatch(/\n\s+at\s/u);
    } finally {
      temp.cleanup();
    }
  });

  it("produce la misma salida en dos ejecuciones consecutivas sobre el mismo estado", async () => {
    const temp = createTempIndexedDb();
    try {
      const first = await runRetrieveWithFakes("OrderService", temp.dbPath);
      const second = await runRetrieveWithFakes("OrderService", temp.dbPath);

      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(second.stdout).toBe(first.stdout);
    } finally {
      temp.cleanup();
    }
  });

  it("imprime el resultado recuperado una sola vez en stdout", async () => {
    const temp = createTempIndexedDb();
    try {
      const result = await runRetrieveWithFakes("OrderService", temp.dbPath);
      const markerCount = countOccurrences(result.stdout, "### Contexto del Proyecto");

      expect(result.code).toBe(0);
      expect(markerCount).toBe(1);
      expect(result.stderr).not.toContain("### Contexto del Proyecto");
    } finally {
      temp.cleanup();
    }
  });

  it("exporta el contexto recuperado a Markdown identificable por pregunta", async () => {
    const temp = createTempIndexedDb();
    const output = path.join(temp.dir, "contexto.md");
    try {
      const result = await runContextExportWithFakes("OrderService(save)", temp.dbPath, output);
      const markdown = readFileSync(output, "utf-8");

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`Contexto exportado: ${output}`);
      expect(result.stdout).not.toContain("### Contexto del Proyecto");
      expect(result.stderr).not.toContain("fts5:");
      expect(existsSync(output)).toBe(true);
      expect(markdown).toContain("lacoco_export_version: 1");
      expect(markdown).toContain("context_id:");
      expect(markdown).toContain('question: "OrderService(save)"');
      expect(markdown).toContain("## Question");
      expect(markdown).toContain("OrderService(save)");
      expect(markdown).toContain("## Retrieved Chunks");
      expect(markdown).toContain("file1#OrderService");
    } finally {
      temp.cleanup();
    }
  });
});

async function runRetrieveWithFakes(query: string, dbPath: string): Promise<CliResult> {
  const { streams, read } = createCapturedStreams();
  const options: RetrieveCliOptions = {
    db: dbPath,
    lancedb: "./lancedb",
    strategy: "agentic",
    ollama: "http://localhost:11434",
    llm: false,
    verbose: false,
  };

  const code = await runRetrieve(query, options, streams, createFakeRuntime());
  return { code, ...read() };
}

async function runContextExportWithFakes(
  query: string,
  dbPath: string,
  output: string,
): Promise<CliResult> {
  const { streams, read } = createCapturedStreams();
  const options: ContextExportCliOptions = {
    db: dbPath,
    lancedb: "./lancedb",
    strategy: "agentic",
    ollama: "http://localhost:11434",
    verbose: false,
    json: false,
    output,
  };

  const code = await runContextExport(query, options, streams, createFakeRuntime());
  return { code, ...read() };
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

function createFakeRuntime(): RetrieveRuntime {
  return {
    createDatabase: (pathToDb) => new LaCoCoDatabase(pathToDb),
    createOllama: () => ({
      isAvailable: async () => false,
      generate: async () => {
        throw new Error("No debe llamarse al LLM final en --no-llm");
      },
    }),
    createIntermediary: () => ({
      sanitize: async (prompt) => {
        const trimmed = prompt.trim();
        if (trimmed.length === 0) throw new Error("El prompt no puede estar vacío");
        const cleanQuery = trimmed.includes("OrderService") ? "OrderService" : trimmed;
        return {
          route: "RAG",
          clean_query: cleanQuery,
          embedding_input: trimmed,
          dimensions: ["CPG"],
          intent: "understand",
          confidence: 0.9,
        };
      },
    }),
    createStrategy: async (_strategyName, db) => ({
      strategy: createBm25Strategy(db),
    }),
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

function createTempIndexedDb(): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), "lacoco-cli-"));
  const dbPath = path.join(dir, "tensor.sqlite");
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
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
