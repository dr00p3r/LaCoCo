import Database from "better-sqlite3";

export class ConnectionDao {
  constructor(private readonly db: Database.Database) {}

  transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
    console.log("[LaCoCo] Conexión SQLite cerrada.");
  }

  stats(): { nodes: number; edges: number } {
    const nodes = (
      this.db.prepare(`SELECT COUNT(*) as count FROM nodes`).get() as {
        count: number;
      }
    ).count;
    const edges = (
      this.db.prepare(`SELECT COUNT(*) as count FROM edges`).get() as {
        count: number;
      }
    ).count;
    return { nodes, edges };
  }

  getRawDb(): Database.Database {
    return this.db;
  }
}
