import Database from "better-sqlite3";
import path from "node:path";


// ---------------------------------------------------------------------------
// Tipos públicos del esquema
// ---------------------------------------------------------------------------

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  filepath: string;
  signature: string;
  isDeprecated: number; // 0 | 1  (SQLite no tiene BOOLEAN nativo)
}

export interface GraphEdge {
  sourceId: string;
  targetId: string;
  relation: string;
}

// ---------------------------------------------------------------------------
// SqliteManager
// ---------------------------------------------------------------------------

/**
 * Gestiona el ciclo de vida de la base de datos SQLite local (tensor.sqlite).
 *
 * Responsabilidades:
 *   - Abrir / cerrar la conexión.
 *   - Crear el esquema (tablas + índices) de forma idempotente.
 *   - Exponer métodos tipados para insertar nodos y aristas.
 */
export class SqliteManager {
  private readonly db: Database.Database;

  // Prepared statements compilados una sola vez en el constructor
  private stmtInsertNode!: Database.Statement;
  private stmtInsertEdge!: Database.Statement;
  private stmtDeleteEdgesByTarget!: Database.Statement;
  private stmtDeleteNodesByFile!: Database.Statement;
  private stmtGetNodeIdsByFile!: Database.Statement;

  /**
   * @param dbPath Ruta absoluta o relativa al archivo tensor.sqlite.
   *               Si no se proporciona, se creará junto al directorio de ejecución.
   */
  constructor(dbPath?: string) {
    const resolvedPath = dbPath ?? this.#defaultDbPath();
    this.db = new Database(resolvedPath);

    // WAL mejora el rendimiento de escritura concurrente
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");

    this.#initSchema();
    this.#prepareStatements();

    console.log(`[SqliteManager] Base de datos conectada → ${resolvedPath}`);
  }

  // -------------------------------------------------------------------------
  // Inicialización del esquema
  // -------------------------------------------------------------------------

  #initSchema(): void {
    /**
     * Versión 2: Añade FK(sourceId ON DELETE CASCADE) + idx_nodes_filepath.
     * Si la DB fue creada con la v1 (sin FK ni índice) se migra automáticamente;
     * la migración borra las tablas porque el cold-start siempre las regenera.
     */
    const SCHEMA_VERSION = 2;
    const current = this.db.pragma("user_version", { simple: true }) as number;

    if (current < SCHEMA_VERSION) {
      console.log(
        `[SqliteManager] Migrando esquema v${current} \u2192 v${SCHEMA_VERSION} (first-time or upgrade)...`
      );
      this.#migrateSchema(SCHEMA_VERSION);
    } else {
      // DB ya existe con el esquema correcto — solo nos aseguramos de que las tablas existen
      this.#createTables();
    }
  }

  #createTables(): void {
    this.db.exec(`
      -- ---------------------------------------------------------------
      -- Nodos: cada entidad semántica del código fuente
      -- ---------------------------------------------------------------
      CREATE TABLE IF NOT EXISTS nodes (
        id           TEXT    PRIMARY KEY,
        kind         TEXT    NOT NULL,
        name         TEXT    NOT NULL,
        filepath     TEXT    NOT NULL,
        signature    TEXT,
        isDeprecated INTEGER NOT NULL DEFAULT 0
      );

      -- Índice en filepath: elimina el full-scan en el hot-reload (M4)
      CREATE INDEX IF NOT EXISTS idx_nodes_filepath ON nodes(filepath);

      -- ---------------------------------------------------------------
      -- Aristas: relaciones entre nodos
      -- FK(sourceId ON DELETE CASCADE) garantiza que al borrar un nodo
      -- sus aristas salientes se borran en microsegundos (F2, F5).
      -- No ponemos FK en targetId para evitar violaciones de orden al
      -- analizar referencias cruzadas entre archivos (ver F7).
      -- ---------------------------------------------------------------
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

  /**
   * Recrea las tablas al detectar un esquema desactualizado.
   * Sólo se ejecuta una vez por base de datos (guard: user_version pragma).
   * La pérdida de datos es aceptable porque el cold-start regenera el grafo.
   */
  #migrateSchema(targetVersion: number): void {
    // El orden importa: edges depende de nodes mediante FK
    this.db.exec(`
      DROP TABLE IF EXISTS edges;
      DROP TABLE IF EXISTS nodes;
    `);
    this.#createTables();
    this.db.pragma(`user_version = ${targetVersion}`);
    console.log(`[SqliteManager] Migración completada \u2192 v${targetVersion}.`);
  }

  // -------------------------------------------------------------------------
  // Inicialización de prepared statements
  // -------------------------------------------------------------------------

  /**
   * Compila todos los prepared statements una sola vez después de crear el schema.
   * Esto evita re-compilación de SQL en cada llamada a insertNode/insertEdge.
   */
  #prepareStatements(): void {
    this.stmtInsertNode = this.db.prepare(
      `INSERT OR REPLACE INTO nodes
         (id, kind, name, filepath, signature, isDeprecated)
       VALUES
         (@id, @kind, @name, @filepath, @signature, @isDeprecated)`
    );

    this.stmtInsertEdge = this.db.prepare(
      `INSERT OR IGNORE INTO edges (sourceId, targetId, relation)
       VALUES (@sourceId, @targetId, @relation)`
    );

    this.stmtDeleteEdgesByTarget = this.db.prepare(
      `DELETE FROM edges WHERE targetId = ?`
    );

    this.stmtDeleteNodesByFile = this.db.prepare(
      `DELETE FROM nodes WHERE filepath = ?`
    );

    this.stmtGetNodeIdsByFile = this.db.prepare(
      `SELECT id FROM nodes WHERE filepath = ?`
    );
  }

  // -------------------------------------------------------------------------
  // CRUD de nodos
  // -------------------------------------------------------------------------

  /**
   * Inserta o reemplaza un nodo.  INSERT OR REPLACE actualiza el registro si
   * la PK ya existe, lo que permite re-análisis incremental.
   */
  insertNode(node: GraphNode): void {
    this.stmtInsertNode.run(node);
  }

  /**
   * Borra todos los nodos de un filepath y sus aristas asociadas de forma eficiente.
   *
   * Estrategia (cierra F2, F5, M4, M5):
   *   1. Colección de IDs afectados usando idx_nodes_filepath.
   *   2. Borrado de aristas entrantes (targetId) por ID usando idx_edges_target.
   *   3. Borrado de nodos por filepath — la FK ON DELETE CASCADE elimina
   *      automáticamente las aristas salientes (sourceId), sin full-scan.
   *
   * Complejidad: O(n_nodos × avg_edges) usando índices, vs O(total_edges) antes.
   */
  deleteNodesByFile(filepath: string): void {
    // Step 1: collect IDs to clean up incoming edges (targetId orphans)
    const nodeIds = (
      this.stmtGetNodeIdsByFile.all(filepath) as { id: string }[]
    ).map((r) => r.id);

    if (nodeIds.length === 0) return;

    // Step 2: delete incoming edges for each ID using idx_edges_target
    for (const id of nodeIds) {
      this.stmtDeleteEdgesByTarget.run(id);
    }

    // Step 3: delete nodes — FK CASCADE removes outgoing edges automatically
    this.stmtDeleteNodesByFile.run(filepath);
  }

  // -------------------------------------------------------------------------
  // CRUD de aristas
  // -------------------------------------------------------------------------

  /**
   * Inserta una arista ignorando silenciosamente los duplicados
   * (gracias a la constraint UNIQUE + OR IGNORE).
   */
  insertEdge(edge: GraphEdge): void {
    this.stmtInsertEdge.run(edge);
  }

  // -------------------------------------------------------------------------
  // Transacciones
  // -------------------------------------------------------------------------

  /**
   * Envuelve una función en una transacción atómica.
   * Si la función lanza, la transacción hace rollback automáticamente.
   *
   * @example
   * manager.transaction(() => {
   *   sourceFiles.forEach(f => extractor.processFile(f));
   * });
   */
  transaction(fn: () => void): void {
    this.db.transaction(fn)();
  }

  // -------------------------------------------------------------------------
  // Consultas de utilidad
  // -------------------------------------------------------------------------

  /** Devuelve todos los nodos de un archivo, útil para depuración. */
  getNodesByFile(filepath: string): GraphNode[] {
    return this.db
      .prepare(`SELECT * FROM nodes WHERE filepath = ?`)
      .all(filepath) as GraphNode[];
  }

  /** Estadísticas rápidas del grafo. */
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

  // -------------------------------------------------------------------------
  // Cierre
  // -------------------------------------------------------------------------

  /** Cierra la conexión limpiamente.  Llama a este método al terminar el proceso. */
  close(): void {
    this.db.close();
    console.log("[SqliteManager] Conexión cerrada.");
  }

  /**
   * Expone la instancia raw de better-sqlite3 para componentes que gestionan
   * sus propios prepared statements (como TensorParser).
   *
   * Uso acotado: úsalo solo para inyección en constructores de bajo nivel.
   * No ejecutes DDL directamente sobre la conexión raw.
   */
  getRawDb(): Database.Database {
    return this.db;
  }


  // -------------------------------------------------------------------------
  // Helpers privados
  // -------------------------------------------------------------------------

  #defaultDbPath(): string {
    // Coloca tensor.sqlite junto a la raíz del proyecto (CWD)
    return path.join(process.cwd(), "tensor.sqlite");
  }
}
