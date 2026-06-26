import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VectorsIndexer } from "../../src/indexer/vectors-indexer.js";
import type { NodeEmbeddingRecord } from "../../src/persistence/lacoco-vectors-manager/model/types.js";

describe("VectorsIndexer", () => {
  let previousTestEmbeddings: string | undefined;

  beforeEach(() => {
    previousTestEmbeddings = process.env.LACOCO_TEST_EMBEDDINGS;
    process.env.LACOCO_TEST_EMBEDDINGS = "1";
  });

  afterEach(() => {
    if (previousTestEmbeddings === undefined) {
      delete process.env.LACOCO_TEST_EMBEDDINGS;
    } else {
      process.env.LACOCO_TEST_EMBEDDINGS = previousTestEmbeddings;
    }
  });

  it("construye el índice ANN tras vaciar embeddings", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lacoco-vectors-indexer-"));
    const calls: string[] = [];
    const replaceBatch = vi.fn(async (_records: NodeEmbeddingRecord[]) => {
      calls.push("replaceBatch");
    });
    const buildIndex = vi.fn(async () => {
      calls.push("buildIndex");
    });

    try {
      const tsconfig = createFixtureProject(dir);
      const indexer = new VectorsIndexer("/tmp/lacoco-test-lancedb", tsconfig, () => ({
        connect: async () => {
          calls.push("connect");
        },
        clear: async () => {
          calls.push("clear");
        },
        replaceBatch,
        buildIndex,
        close: async () => {
          calls.push("close");
        },
      }));

      await indexer.index();

      expect(replaceBatch).toHaveBeenCalled();
      expect(buildIndex).toHaveBeenCalledOnce();
      expect(calls.indexOf("replaceBatch")).toBeGreaterThan(-1);
      expect(calls.indexOf("buildIndex")).toBeGreaterThan(calls.indexOf("replaceBatch"));
      expect(calls.at(-1)).toBe("close");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function createFixtureProject(dir: string): string {
  const srcDir = path.join(dir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(
    path.join(srcDir, "service.ts"),
    "export class OrderService { createOrder(): string { return 'ok'; } }\n",
  );
  const tsconfig = path.join(dir, "tsconfig.json");
  fs.writeFileSync(
    tsconfig,
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
      },
      include: ["src/**/*.ts"],
    }),
  );
  return tsconfig;
}
