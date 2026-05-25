import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export class MigrationDao {
  constructor(private readonly db: Database.Database) {}

  initSchema(): void {
    const SCHEMA_VERSION = 2;
    const current = this.db.pragma("user_version", { simple: true }) as number;

    if (current < SCHEMA_VERSION) {
      console.log(
        `[LaCoCo] Migrando esquema v${current} \u2192 v${SCHEMA_VERSION} (first-time or upgrade)...`
      );
      this.#migrateSchema(SCHEMA_VERSION);
    } else {
      this.#createTables();
    }
  }

  #createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nodes (
        id           TEXT    PRIMARY KEY,
        kind         TEXT    NOT NULL,
        name         TEXT    NOT NULL,
        filepath     TEXT    NOT NULL,
        signature    TEXT,
        isDeprecated INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX IF NOT EXISTS idx_nodes_filepath ON nodes(filepath);

      CREATE TABLE IF NOT EXISTS edges (
        sourceId TEXT NOT NULL,
        targetId TEXT NOT NULL,
        relation TEXT NOT NULL,
        UNIQUE(sourceId, targetId, relation),
        FOREIGN KEY(sourceId) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(sourceId);
      CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(targetId);
    `);
  }

  #migrateSchema(targetVersion: number): void {
    this.db.exec(`
      DROP TABLE IF EXISTS edges;
      DROP TABLE IF EXISTS nodes;
    `);
    this.#createTables();
    this.db.pragma(`user_version = ${targetVersion}`);
    console.log(`[LaCoCo] Migraci\u00f3n completada \u2192 v${targetVersion}.`);
  }

  runMigrations(): void {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationsDir = path.join(__dirname, "..", "migrations");
    if (!fs.existsSync(migrationsDir)) {
      console.warn("[LaCoCo] Directorio migrations/ no encontrado; omitiendo migraciones FTS5.");
      return;
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      try {
        this.db.exec(sql);
      } catch (err) {
        console.error(`[LaCoCo] Error ejecutando migraci\u00f3n ${file}:`, err);
      }
    }
  }
}
