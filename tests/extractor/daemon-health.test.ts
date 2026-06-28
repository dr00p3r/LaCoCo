import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DaemonManager } from "../../src/extractor/daemon.js";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";

describe("DaemonManager health", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reporta fallos operativos y los publica mediante onError", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "lacoco-daemon-health-"));
    const sourceDir = path.join(dir, "src");
    const invalidLancePath = path.join(dir, "not-a-directory");
    fs.mkdirSync(sourceDir);
    fs.writeFileSync(path.join(sourceDir, "index.ts"), "export function answer(): number { return 42; }\n");
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({
      compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" },
      include: ["src/**/*.ts"],
    }));
    fs.writeFileSync(invalidLancePath, "not a directory");

    const db = new LaCoCoDatabase(path.join(dir, "tensor.sqlite"));
    const onError = vi.fn();
    const daemon = new DaemonManager({
      tsConfigFilePath: path.join(dir, "tsconfig.json"),
      db,
      lanceDbPath: invalidLancePath,
      onError,
    });
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(console, "time").mockImplementation(() => undefined);
    vi.spyOn(console, "timeEnd").mockImplementation(() => undefined);

    try {
      daemon.start();
      await daemon.awaitVectors();

      expect(daemon.health()).toMatchObject({
        ok: false,
        watcherActive: true,
        failures: { embeddings: 1 },
        lastError: { scope: "embeddings" },
      });
      expect(onError).toHaveBeenCalledWith(expect.objectContaining({ scope: "embeddings" }));
    } finally {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
