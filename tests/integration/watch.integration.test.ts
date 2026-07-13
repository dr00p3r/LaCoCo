import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DaemonManager } from "../../src/extractor/daemon.js";
import { LaCoCoDatabase } from "../../src/persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import {
  countNodesByFile,
  createIntegrationProject,
  findNodeByName,
  updatedOrderServiceSource,
  waitFor,
} from "./helpers.js";

describe("LaCoCo watcher integration", () => {
  it("updates SQLite on file change, add, and delete", async () => {
    const project = createIntegrationProject("lacoco-watch-");
    const db = new LaCoCoDatabase(project.dbPath);
    const daemon = new DaemonManager({
      tsConfigFilePath: project.tsconfig,
      db,
      watchGlob: project.src,
      indexEmbeddings: false,
      watchDebounceMs: 20,
    });
    const addedFile = path.join(project.src, "shipping.service.ts");

    try {
      daemon.start();
      const rawDb = db.getRawDb();
      expect(findNodeByName(rawDb, "OrderService")).toBeTruthy();

      await new Promise((resolve) => setTimeout(resolve, 1_000));
      writeFileSync(project.orderServicePath, updatedOrderServiceSource(), "utf8");
      await waitFor(
        () => rawDb.prepare("SELECT 1 FROM nodes WHERE name = ? LIMIT 1").get("cancelOrder") !== undefined,
        "Watcher did not index changed file",
      );

      writeFileSync(
        addedFile,
        [
          "export class ShippingService {",
          "  shipOrder(id: string): string {",
          "    return id;",
          "  }",
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      await waitFor(
        () => rawDb.prepare("SELECT 1 FROM nodes WHERE name = ? LIMIT 1").get("ShippingService") !== undefined,
        "Watcher did not index added file",
      );

      rmSync(addedFile, { force: true });
      await waitFor(
        () => countNodesByFile(rawDb, addedFile) === 0,
        "Watcher did not purge deleted file",
      );

      expect(daemon.health().ok).toBe(true);
    } finally {
      await daemon.stop();
      project.cleanup();
    }
  });
});
