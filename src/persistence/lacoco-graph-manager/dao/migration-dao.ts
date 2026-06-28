import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export class MigrationDao {
  private currentVersion = 0;

  constructor(private readonly db: Database.Database) {}

  initSchema(): void {
    this.currentVersion = this.db.pragma("user_version", { simple: true }) as number;
    this.#createTables();
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

  runMigrations(): void {
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const migrationsDir = path.join(__dirname, "..", "migrations");
    if (!fs.existsSync(migrationsDir)) {
      throw new Error(`Directorio de migraciones no encontrado: ${migrationsDir}`);
    }

    const files = fs
      .readdirSync(migrationsDir)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    let applied = 0;
    for (const file of files) {
      const version = Number.parseInt(file.split("_")[0] ?? "", 10);
      if (!Number.isInteger(version)) {
        throw new Error(`Nombre de migración inválido: ${file}`);
      }
      if (version > 0 && version <= this.currentVersion) continue;

      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf-8");
      this.db.transaction(() => {
        this.db.exec(sql);
        if (version > 0) {
          this.db.pragma(`user_version = ${version}`);
        }
      })();
      if (version > 0) {
        console.error(`[LaCoCo] Migración aplicada: ${file}`);
        applied++;
        this.currentVersion = version;
      }
    }
    if (applied === 0 && this.currentVersion > 0) {
      console.error(`[LaCoCo] Migraciones al día (v${this.currentVersion})`);
    }
  }
}
