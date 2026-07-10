import { execFileSync } from "node:child_process";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import * as lancedb from "@lancedb/lancedb";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");
const CLI_ENTRYPOINT = path.join(REPO_ROOT, "src", "cli", "index.ts");

describe("lacoco CLI E2E", () => {
  it("indexa grafo y vectores en almacenamiento aislado por proyecto", async (context) => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lacoco-e2e-"));
    const projectDir = path.join(tempDir, "project-a");
    const stateHome = path.join(tempDir, "state-home");

    try {
      createFixtureProject(projectDir);

      runCli(["init", projectDir], stateHome);
      runCli(["index_graph", path.join(projectDir, "tsconfig.json")], stateHome);
      runCli(["index_vectors", path.join(projectDir, "tsconfig.json")], stateHome, {
        LACOCO_TEST_EMBEDDINGS: "1",
      });

      const status = JSON.parse(runCli(["status", projectDir, "--json"], stateHome)) as {
        id: string;
        storage: {
          dbPath: string;
          lanceDbPath: string;
        };
      };

      const expectedDbPath = path.join(projectDir, ".lacoco", "tensor.sqlite");
      const expectedLanceDbPath = path.join(projectDir, ".lacoco", "lancedb");
      expect(status.storage.dbPath).toBe(expectedDbPath);
      expect(status.storage.lanceDbPath).toBe(expectedLanceDbPath);
      expect(fs.existsSync(expectedDbPath)).toBe(true);
      expect(fs.existsSync(expectedLanceDbPath)).toBe(true);

      const sqlite = new Database(expectedDbPath, { readonly: true });
      try {
        const { count } = sqlite
          .prepare("SELECT COUNT(*) AS count FROM nodes")
          .get() as { count: number };
        expect(count).toBeGreaterThan(0);
      } finally {
        sqlite.close();
      }

      const vectorDb = await lancedb.connect(expectedLanceDbPath);
      try {
        const table = await vectorDb.openTable("node_embeddings");
        const rows = await table.query().limit(10).toArray();
        expect(rows.length).toBeGreaterThan(0);
        expect(rows.every((row) => row.node_id !== "__schema_init__")).toBe(true);
      } finally {
        await vectorDb.close();
      }
    } catch (err) {
      if (isSpawnPermissionError(err)) {
        context.skip();
      }
      throw err;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("indexa el grafo de un repositorio multi-servicio ignorando servicios no TypeScript", (context) => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "lacoco-e2e-ms-"));
    const projectDir = path.join(tempDir, "arq-ms");
    const stateHome = path.join(tempDir, "state-home");

    try {
      createMicroserviceFixture(projectDir);

      runCli(["index_graph", projectDir], stateHome);

      const expectedDbPath = path.join(projectDir, ".lacoco", "tensor.sqlite");
      const sqlite = new Database(expectedDbPath, { readonly: true });
      try {
        const rows = sqlite
          .prepare("SELECT id FROM nodes ORDER BY id")
          .all() as Array<{ id: string }>;
        expect(rows.some((row) => row.id.endsWith("/api-gateway/src/api_gateway.ts#GatewayService"))).toBe(true);
        expect(rows.some((row) => row.id.endsWith("/tickets/src/tickets.ts#TicketsService"))).toBe(true);
        expect(rows.some((row) => row.id.includes("/usuarios/"))).toBe(false);
      } finally {
        sqlite.close();
      }
    } catch (err) {
      if (isSpawnPermissionError(err)) {
        context.skip();
      }
      throw err;
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function runCli(
  args: string[],
  stateHome: string,
  env: Record<string, string> = {},
): string {
  return execFileSync(
    process.execPath,
    ["--import", "tsx", CLI_ENTRYPOINT, ...args],
    {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      env: {
        ...process.env,
        XDG_STATE_HOME: stateHome,
        ...env,
      },
      timeout: 30_000,
    },
  );
}

function createFixtureProject(projectDir: string): void {
  fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".git"));
  fs.writeFileSync(
    path.join(projectDir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src/**/*.ts"],
    }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(projectDir, "src", "order.ts"),
    [
      "export interface CreateOrderDto {",
      "  amount: number;",
      "}",
      "",
      "export class OrderService {",
      "  createOrder(dto: CreateOrderDto): number {",
      "    return dto.amount;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function createMicroserviceFixture(projectDir: string): void {
  fs.mkdirSync(path.join(projectDir, ".git"), { recursive: true });
  createService(projectDir, "api-gateway", "GatewayService");
  createService(projectDir, "tickets", "TicketsService");
  fs.mkdirSync(path.join(projectDir, "usuarios"), { recursive: true });
  fs.writeFileSync(path.join(projectDir, "usuarios", "pom.xml"), "<project></project>", "utf-8");
}

function createService(projectDir: string, serviceDir: string, className: string): void {
  const root = path.join(projectDir, serviceDir);
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: serviceDir, version: "1.0.0" }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src/**/*.ts"],
    }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(root, "tsconfig.build.json"),
    JSON.stringify({ extends: "./tsconfig.json" }, null, 2),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(root, "src", `${serviceDir.replaceAll("-", "_")}.ts`),
    [
      `export class ${className} {`,
      "  ping(): string {",
      `    return "${serviceDir}";`,
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf-8",
  );
}

function isSpawnPermissionError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    err.code === "EPERM" &&
    err.message.includes("spawnSync")
  );
}
