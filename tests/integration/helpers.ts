import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { LaCoCoLanceDb } from "../../src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import type { RetrieveIntermediary, RetrieveRuntime } from "../../src/cli/index.js";
import type { LlmClient } from "../../src/slms/llm-client.js";
import { getStrategyEntry } from "../../src/retriever/strategies/registry.js";

export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
export const CLI_ENTRYPOINT = path.join(REPO_ROOT, "src", "cli", "index.ts");

export interface IntegrationProject {
  root: string;
  src: string;
  tsconfig: string;
  dbPath: string;
  lanceDbPath: string;
  stateHome: string;
  orderServicePath: string;
  cleanup(): void;
  runCli(args: string[], env?: Record<string, string>, timeoutMs?: number): string;
}

export function createIntegrationProject(prefix = "lacoco-it-"): IntegrationProject {
  const root = mkdtempSync(path.join(tmpdir(), prefix));
  const src = path.join(root, "src");
  const stateHome = path.join(root, "state-home");
  const tsconfig = path.join(root, "tsconfig.json");
  const dbPath = path.join(root, ".lacoco", "tensor.sqlite");
  const lanceDbPath = path.join(root, ".lacoco", "lancedb");
  const orderServicePath = path.join(src, "order.service.ts");

  mkdirSync(path.join(root, ".git"), { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src/**/*.ts"],
    }, null, 2),
    "utf8",
  );
  writeProjectSources(src);

  return {
    root,
    src,
    tsconfig,
    dbPath,
    lanceDbPath,
    stateHome,
    orderServicePath,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
    runCli(args, env = {}, timeoutMs = 30_000) {
      return execFileSync(
        process.execPath,
        ["--import", "tsx", CLI_ENTRYPOINT, ...args],
        {
          cwd: REPO_ROOT,
          encoding: "utf8",
          env: {
            ...process.env,
            XDG_STATE_HOME: stateHome,
            LACOCO_DISABLE_EMBEDDING_CACHE: "1",
            ...env,
          },
          timeout: timeoutMs,
        },
      );
    },
  };
}

export function writeProjectSources(src: string): void {
  writeFileSync(
    path.join(src, "order.dto.ts"),
    [
      "export interface CreateOrderDto {",
      "  customerId: string;",
      "  amount: number;",
      "}",
      "",
      "export interface OrderReceipt {",
      "  id: string;",
      "  ok: boolean;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(src, "customer.repo.ts"),
    [
      "export class CustomerRepository {",
      "  findCustomer(id: string): string {",
      "    return id;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    path.join(src, "order.service.ts"),
    initialOrderServiceSource(),
    "utf8",
  );
}

export function initialOrderServiceSource(): string {
  return [
    'import { CustomerRepository } from "./customer.repo.js";',
    'import type { CreateOrderDto, OrderReceipt } from "./order.dto.js";',
    "",
    "export class OrderService {",
    "  createOrder(dto: CreateOrderDto): OrderReceipt {",
    "    const customer = findCustomer(dto.customerId);",
    "    auditOrder(customer);",
    "    return { id: customer, ok: true };",
    "  }",
    "}",
    "",
    "export function findCustomer(id: string): string {",
    "  return new CustomerRepository().findCustomer(id);",
    "}",
    "",
    "export function auditOrder(customer: string): void {",
    "  console.log(customer);",
    "}",
    "",
  ].join("\n");
}

export function updatedOrderServiceSource(): string {
  return [
    'import { CustomerRepository } from "./customer.repo.js";',
    'import type { CreateOrderDto, OrderReceipt } from "./order.dto.js";',
    "",
    "export class OrderService {",
    "  createOrder(dto: CreateOrderDto): OrderReceipt {",
    "    const customer = findCustomer(dto.customerId);",
    "    auditOrder(customer);",
    "    return { id: customer, ok: true };",
    "  }",
    "",
    "  cancelOrder(id: string): OrderReceipt {",
    "    auditOrder(id);",
    "    return { id, ok: true };",
    "  }",
    "}",
    "",
    "export function findCustomer(id: string): string {",
    "  return new CustomerRepository().findCustomer(id);",
    "}",
    "",
    "export function auditOrder(customer: string): void {",
    "  console.log(customer);",
    "}",
    "",
  ].join("\n");
}

export function indexGraph(project: IntegrationProject): void {
  project.runCli(["index_graph", project.tsconfig]);
  if (!existsSync(project.dbPath)) {
    throw new Error(`SQLite index was not created: ${project.dbPath}`);
  }
}

export function indexVectors(project: IntegrationProject): void {
  project.runCli(["index_vectors", project.tsconfig], { LACOCO_TEST_EMBEDDINGS: "1" }, 45_000);
  if (!existsSync(project.lanceDbPath)) {
    throw new Error(`LanceDB index was not created: ${project.lanceDbPath}`);
  }
}

export function withGraph<T>(dbPath: string, fn: (db: Database.Database) => T): T {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export function findNodeByName(db: Database.Database, name: string): { id: string; kind: string; filepath: string } {
  const row = db.prepare("SELECT id, kind, filepath FROM nodes WHERE name = ? ORDER BY id LIMIT 1").get(name);
  if (!row || typeof row !== "object") throw new Error(`Node not found: ${name}`);
  return row as { id: string; kind: string; filepath: string };
}

export function hasEdge(
  db: Database.Database,
  sourceName: string,
  targetName: string,
  relation: string,
): boolean {
  const row = db.prepare(`
    SELECT 1
    FROM edges e
    JOIN nodes s ON s.id = e.sourceId
    JOIN nodes t ON t.id = e.targetId
    WHERE s.name = ? AND t.name = ? AND e.relation = ?
    LIMIT 1
  `).get(sourceName, targetName, relation);
  return row !== undefined;
}

export function countNodesByFile(db: Database.Database, filePath: string): number {
  const row = db.prepare("SELECT COUNT(*) AS count FROM nodes WHERE filepath = ?").get(filePath) as { count: number };
  return row.count;
}

export async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 5_000,
  intervalMs = 50,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(message);
}

export function createIntegrationRetrieveRuntime(): RetrieveRuntime {
  return {
    createDatabase: (dbPath) => new LaCoCoDatabase(dbPath),
    createOllama: () => fakeLlm,
    createIntermediary: () => fakeIntermediary,
    createStrategy: async (
      strategyName,
      db,
      lanceDbPath,
      ollamaEndpoint,
      ollamaTimeoutMs,
      ollama,
      strategyOptions,
    ) => {
      const entry = getStrategyEntry(strategyName);
      let lanceDb: LaCoCoLanceDb | undefined;
      try {
        if (entry.needsLanceDb) {
          lanceDb = new LaCoCoLanceDb(lanceDbPath);
          await lanceDb.connect();
        }
        const strategy = entry.create({
          db,
          ollamaEndpoint,
          ollama: ollama ?? fakeLlm,
          ...(lanceDb ? { lanceDb } : {}),
          ...(ollamaTimeoutMs === undefined ? {} : { ollamaTimeoutMs }),
        }, strategyOptions);
        return {
          strategy,
          ...(lanceDb ? { connectedLanceDb: lanceDb } : {}),
        };
      } catch (error) {
        if (lanceDb) await lanceDb.close();
        throw error;
      }
    },
  };
}

export function readText(pathToFile: string): string {
  return readFileSync(pathToFile, "utf8");
}

const fakeLlm: LlmClient = {
  abort: () => undefined,
  isAvailable: async () => false,
  generate: async () => {
    throw new Error("Integration tests should not call LLM generation");
  },
  chat: async () => {
    throw new Error("Integration tests should not call LLM chat");
  },
};

const fakeIntermediary: RetrieveIntermediary = {
  sanitize: async (prompt) => {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) throw new Error("El prompt no puede estar vacio");
    return {
      route: "RAG",
      clean_query: "OrderService OR createOrder OR OrderReceipt",
      embedding_input: trimmed,
      dimensions: ["CPG", "DTG"],
      intent: "understand",
      confidence: 0.95,
    };
  },
};
