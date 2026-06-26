/**
 * DaemonManager — Orquestador del ciclo de vida del tensor-extractor
 *
 * Responsabilidades:
 *   1. Cold Start: análisis completo del proyecto en una transacción SQLite única.
 *   2. Hot Reload: observa cambios con chokidar y re-procesa archivos individuales
 *      de forma incremental, midiendo el tiempo con console.time.
 *   3. Shutdown graceful: limpia recursos al recibir SIGINT / SIGTERM.
 *
 * Interacción con otras capas:
 *
 *   CLI (commander)
 *     └─▶ DaemonManager.start()
 *           ├─▶ CodeExtractor.processFile()   ← núcleo AST (sin lado)
 *           └─▶ LaCoCoDatabase.*              ← persistencia
 */

import path from "node:path";
import { Project, type SourceFile } from "ts-morph";
import chokidar, { type FSWatcher } from "chokidar";
import type { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { CodeExtractor } from "./code-extractor.js";
import { SqliteCallbacks } from "./sqlite-callbacks.js";
import { VectorCallbacks } from "./vector-callbacks.js";
import { EmbeddingGenerator } from "../retriever/utilities/embeddings/embedding-generator.js";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos auxiliares
// ─────────────────────────────────────────────────────────────────────────────

export interface DaemonOptions {
  /** Ruta absoluta o relativa al tsconfig.json del proyecto a analizar. */
  tsConfigFilePath: string;
  /** Instancia del gestor de base de datos ya inicializada. */
  db: LaCoCoDatabase;
  /**
   * Glob pattern de los archivos a observar.
   * Defaults a todos los .ts del directorio del tsconfig, excluyendo node_modules.
   */
  watchGlob?: string;
  /** Si es true, imprime información de depuración adicional. */
  verbose?: boolean;
  /** Si es true, genera embeddings en LanceDB tras el cold-start. Default: true. */
  indexEmbeddings?: boolean;
  /** Ruta al directorio de LanceDB. Default: ./lancedb */
  lanceDbPath?: string;
  /** Milisegundos de estabilidad antes de procesar eventos del watcher. Default: 80. */
  watchDebounceMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// DaemonManager
// ─────────────────────────────────────────────────────────────────────────────

export class DaemonManager {
  private readonly project: Project;
  private readonly sqliteCallbacks: SqliteCallbacks;
  private readonly sqliteExtractor: CodeExtractor;
  private readonly embedGen: EmbeddingGenerator;
  private lanceDb: LaCoCoLanceDb | null = null;
  private vectorCallbacks: VectorCallbacks | null = null;
  private vectorExtractor: CodeExtractor | null = null;
  private watcher: FSWatcher | null = null;

  private readonly tsConfigFilePath: string;
  private readonly db: LaCoCoDatabase;
  private readonly watchGlob: string;
  private readonly verbose: boolean;
  private readonly indexVectors: boolean;
  private readonly lanceDbPath: string;
  private readonly watchDebounceMs: number;
  private vectorsPromise: Promise<void> | null = null;
  private fileOperationChain: Promise<void> = Promise.resolve();
  private vectorOperationChain: Promise<void> = Promise.resolve();
  private embeddingsFailed = false;

  constructor(opts: DaemonOptions) {
    this.tsConfigFilePath = path.resolve(opts.tsConfigFilePath);
    this.db = opts.db;
    this.verbose = opts.verbose ?? false;
    this.indexVectors = opts.indexEmbeddings ?? true;
    this.lanceDbPath = opts.lanceDbPath ?? "./lancedb";
    this.watchDebounceMs = opts.watchDebounceMs ?? 80;

    const projectRoot = path.dirname(this.tsConfigFilePath);
    this.watchGlob =
      opts.watchGlob ?? path.join(projectRoot, "**", "*.ts");

    this.project = new Project({
      tsConfigFilePath: this.tsConfigFilePath,
    });

    this.sqliteCallbacks = new SqliteCallbacks(this.db.getRawDb());
    this.sqliteExtractor = new CodeExtractor(this.sqliteCallbacks);
    this.embedGen = new EmbeddingGenerator();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Ciclo de vida público
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Inicia el daemon:
   *   1. Ejecuta el cold start (análisis completo).
   *   2. Arranca el watcher incremental.
   */
  start(): void {
    this.#coldStart();
    this.#startWatcher();
  }

  /**
   * Detiene el daemon limpiamente:
   *   - Cierra el watcher de chokidar.
   *   - Espera escrituras vectoriales pendientes.
   *   - Cierra las conexiones LanceDB y SQLite.
   */
  async stop(): Promise<void> {
    try {
      if (this.watcher) {
        await this.watcher.close();
        this.watcher = null;
      }

      if (this.vectorsPromise) {
        await this.vectorsPromise;
        this.vectorsPromise = null;
      }
      await this.fileOperationChain;
      await this.vectorOperationChain;
      if (this.vectorCallbacks) {
        await this.vectorCallbacks.flush();
      }
      if (this.lanceDb) {
        await this.lanceDb.close();
        this.lanceDb = null;
      }

      this.db.close();
      console.log("\n[Daemon] 🛑 Apagado limpio completado.");
    } catch (err) {
      console.error(
        "\n[Daemon] ❌ Error durante el apagado:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  /**
   * Espera a que los embeddings terminen (si están en progreso).
   * Útil en modo index (one-shot) para no cerrar la BD antes de tiempo.
   */
  async awaitVectors(): Promise<void> {
    if (this.vectorsPromise) {
      await this.vectorsPromise;
    }
  }

  health(): { ok: boolean; embeddingsFailed: boolean; watcherActive: boolean } {
    return {
      ok: !this.embeddingsFailed,
      embeddingsFailed: this.embeddingsFailed,
      watcherActive: this.watcher !== null,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // §1 — Cold Start
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Análisis completo del proyecto en una única transacción SQLite.
   *
   * Al usar una sola transacción para todos los archivos obtenemos:
   *   - Atomicidad: si algo falla, no quedan datos parciales en la DB.
   *   - Rendimiento: SQLite hace un único fsync al final en lugar de uno por archivo.
   *
   * En proyectos con ~500 archivos TypeScript el cold start suele completarse
     * en < 5 segundos gracias a los prepared statements del CodeExtractor.
   */
  #coldStart(): void {
    console.log("\n[Daemon] Cold start — analizando proyecto completo...");
    console.time("[Daemon] Cold start");

    const sourceFiles = this.project.getSourceFiles();
    const total = sourceFiles.length;
    console.log(`[Daemon]    ${total} archivos TypeScript encontrados.`);

    this.sqliteCallbacks.nodesWritten = 0;
    this.sqliteCallbacks.edgesWritten = 0;

    this.db.transaction(() => {
      this.db.clearGraph();
      for (const file of sourceFiles) {
        if (this.verbose) {
          console.log(`[Daemon]    ✍  ${file.getFilePath()}`);
        }
        this.#safeProcessFile(this.sqliteExtractor, file);
      }
    });
    this.db.populateMetadata();

    console.timeEnd("[Daemon] Cold start");
    console.log(
      `[Daemon] ✅ Grafo construido — ${this.sqliteCallbacks.nodesWritten} nodos, ${this.sqliteCallbacks.edgesWritten} aristas.`
    );

    if (this.indexVectors && this.sqliteCallbacks.nodesWritten > 0) {
      this.vectorsPromise = this.#generateEmbeddings(sourceFiles);
    }
  }

  async #generateEmbeddings(sourceFiles: ReturnType<Project["getSourceFiles"]>): Promise<void> {
    console.log("[Daemon] 🧠 Generando embeddings semánticos...");
    console.time("[Daemon] Embeddings");

    this.lanceDb = new LaCoCoLanceDb(this.lanceDbPath);
    try {
      await this.lanceDb.connect();
      await this.lanceDb.clear();
      this.vectorCallbacks = new VectorCallbacks(
        this.lanceDb,
        (t) => this.embedGen.generate(t),
      );
      this.vectorExtractor = new CodeExtractor(this.vectorCallbacks);

      for (const file of sourceFiles) {
        if (this.verbose) {
          console.log(`[Daemon]    🧠  ${file.getFilePath()}`);
        }
        this.#safeProcessFile(this.vectorExtractor, file);
      }
      await this.vectorCallbacks.flush();
      await this.lanceDb.buildIndex();
      console.timeEnd("[Daemon] Embeddings");
      console.log(`[Daemon] ✅ ${this.vectorCallbacks.nodesWritten} embeddings insertados en LanceDB.`);
    } catch (err) {
      this.embeddingsFailed = true;
      console.error("[Daemon] ❌ Error generando embeddings:", err instanceof Error ? err.message : err);
    }
  }

  async #reindexVectors(filePath: string): Promise<void> {
    if (!this.lanceDb || !this.vectorCallbacks || !this.vectorExtractor) return;
    await this.lanceDb.deleteByFilePath(filePath);

    const sourceFile = this.project.getSourceFile(filePath);
    if (!sourceFile) return;

    // Re-generar embeddings
    this.#safeProcessFile(this.vectorExtractor, sourceFile);
    await this.vectorCallbacks.flush();
  }

  // ─────────────────────────────────────────────────────────────────────────
  // §2 — Hot Reload incremental
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Inicia chokidar sobre el glob del proyecto.
   *
   * Eventos manejados:
   *   - `change` → re-procesa el archivo modificado.
   *   - `add`    → añade el archivo al Project y lo procesa.
   *   - `unlink` → elimina los nodos/aristas del archivo borrado.
   */
  #startWatcher(): void {
    console.log(`\n[Daemon] 👀 Observando cambios en: ${this.watchGlob}`);
    console.log("[Daemon]    (Ctrl+C para detener)\n");

    this.watcher = chokidar.watch(this.watchGlob, {
      persistent: true,
      ignoreInitial: true,          // El cold start ya procesó el estado inicial
      ignored: (filePath: string) => filePath.includes("node_modules"),  // chokidar v5: usar función, no RegExp
      awaitWriteFinish: {           // Espera a que el archivo deje de cambiar
        stabilityThreshold: this.watchDebounceMs,
        pollInterval: 20,
      },
    });

    this.watcher.on("change", (filePath) => {
      this.#enqueueFileOperation(() => this.#handleFileChange(filePath, "change"));
    });

    this.watcher.on("add", (filePath) => {
      this.#enqueueFileOperation(() => this.#handleFileChange(filePath, "add"));
    });

    this.watcher.on("unlink", (filePath) => {
      this.#enqueueFileOperation(async () => this.#handleFileDelete(filePath));
    });

    this.watcher.on("error", (error) => {
      console.error("[Daemon] ❌ Error en el watcher:", error);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // §3 — Manejo de eventos individuales
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Procesa un archivo que fue modificado o añadido.
   *
   * Flujo:
   *   1. Medir tiempo con console.time.
   *   2. Obtener / añadir el SourceFile en el Project de ts-morph.
   *   3. Refrescar desde el sistema de archivos (recarga el AST).
   *   4. Borrar los datos anteriores del archivo en SQLite.
     *   5. Re-procesar con CodeExtractor en una transacción nueva.
   *   6. Mostrar métricas del hot reload.
   */
  async #handleFileChange(
    filePath: string,
    event: "change" | "add"
  ): Promise<void> {
    const label = `[Daemon] 🔥 Hot reload [${event}] ${path.relative(process.cwd(), filePath)}`;
    console.time(label);

    try {
      // ── Step 1: Obtener / refrescar el SourceFile en ts-morph ────────────
      const existing = this.project.getSourceFile(filePath);
      let sourceFile: SourceFile;

      if (event === "add" || !existing) {
        sourceFile = this.project.addSourceFileAtPath(filePath);
        console.log(`[Daemon]    ➕ Nuevo archivo incorporado al proyecto.`);
      } else {
        // Recarga el AST del archivo modificado desde el sistema de archivos
        existing.refreshFromFileSystemSync();
        sourceFile = existing;
      }

      // ── Step 2 (F7): Archivos que importan el archivo modificado ─────────
      // Cuando los tipos de un archivo cambian, los archivos que lo importan
      // pueden tener firmas y aristas desactualizadas en la DB.
      // getReferencingSourceFiles() usa el grafo de importaciones de ts-morph.
      const referencingFiles = sourceFile
        .getReferencingSourceFiles()
        .filter((f) => !f.getFilePath().includes("node_modules"));

      if (referencingFiles.length > 0 && this.verbose) {
        console.log(
          `[Daemon]    🔗 ${referencingFiles.length} archivo(s) dependiente(s) detectados para propagación.`
        );
      }

      // Cap: si hay demasiados dependientes (p.ej. un módulo barrel muy importado),
      // limitamos la propagación para no bloquear el event-loop.
      const MAX_PROPAGATION = 50;
      const filesToPropagate = referencingFiles.slice(0, MAX_PROPAGATION);
      if (referencingFiles.length > MAX_PROPAGATION) {
        console.warn(
          `[Daemon] ⚠  ${referencingFiles.length} dependientes detectados; ` +
            `solo se re-procesarán ${MAX_PROPAGATION}. ` +
            `El grafo puede estar parcialmente desactualizado hasta el próximo cold-start.`
        );
      }

      // ── Steps 3–5 (F2): Purge + reprocess en UNA transacción atómica ─────
      // Al ser atómica: si falla en mitad del re-proceso, el grafo vuelve
      // al estado anterior (rollback automático de SQLite).
      this.sqliteCallbacks.nodesWritten = 0;
      this.sqliteCallbacks.edgesWritten = 0;

      let allPurgedIds: string[] = [];

      this.db.transaction(() => {
        // 3. Purgar el archivo modificado y re-procesarlo con el AST fresco
        const purgedIds = this.#purgeFile(filePath);
        this.#safeProcessFile(this.sqliteExtractor, sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(this.sqliteExtractor, dep);
        }
      });
      this.db.populateMetadataForNodes(allPurgedIds);

      console.log(
        `[Daemon]    ↳ ${this.sqliteCallbacks.nodesWritten} nodos, ${this.sqliteCallbacks.edgesWritten} aristas actualizados` +
          (filesToPropagate.length > 0
            ? ` (+ ${filesToPropagate.length} archivo(s) propagados).`
            : ".")
      );

      // Hot-reload de vectores (LanceDB)
      if (this.indexVectors) {
        this.#enqueueVectorUpdates([
          filePath,
          ...filesToPropagate.map((dep) => dep.getFilePath()),
        ]);
      }
    } catch (err) {
      console.error(
        `[Daemon] ❌ Error procesando ${filePath}:`,
        err instanceof Error ? err.message : err
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  }


  /**
   * Elimina de la base de datos todos los registros del archivo borrado.
   */
  #handleFileDelete(filePath: string): void {
    const relativePath = path.relative(process.cwd(), filePath);
    try {
      console.log(`[Daemon] 🗑  Archivo eliminado: ${relativePath}`);
      this.#purgeFile(filePath);
      const sourceFile = this.project.getSourceFile(filePath);
      if (sourceFile) this.project.removeSourceFile(sourceFile);
      if (this.indexVectors) this.#enqueueVectorUpdates([filePath]);
      console.log(`[Daemon]    ↳ Registros del archivo purgados de SQLite.`);
    } catch (err) {
      console.error(
        `[Daemon] ❌ Error purgando registros de ${relativePath}:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // §4 — Utilidades privadas
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Borra en cascada todos los nodos y aristas asociados a un filepath.
   *
   * Estrategia con ON DELETE CASCADE parcial:
   *   1. Obtener los ids de los nodos del archivo.
   *   2. Borrar las aristas donde targetId pertenece a esos ids
   *      (sourceId se cubre con ON DELETE CASCADE del schema).
   *   3. Borrar los nodos del archivo.
   *
   * Esto garantiza consistencia aunque el schema no tenga CASCADE configurado.
   */
  #purgeFile(filePath: string): string[] {
    return this.db.deleteNodesByFile(filePath);
  }

  #enqueueFileOperation(operation: () => Promise<void>): void {
    this.fileOperationChain = this.fileOperationChain
      .then(operation)
      .catch((err: unknown) => {
        console.error(
          "[Daemon] Error en cola de archivos:",
          err instanceof Error ? err.message : err
        );
      });
  }

  #enqueueVectorUpdates(filePaths: string[]): void {
    this.vectorOperationChain = this.vectorOperationChain
      .then(async () => {
        if (this.vectorsPromise) await this.vectorsPromise;
        for (const filePath of new Set(filePaths)) {
          await this.#reindexVectors(filePath);
        }
      })
      .catch((err: unknown) => {
        console.error(
          "[Daemon] Error en cola vectorial:",
          err instanceof Error ? err.message : err
        );
      });
  }

  /**
   * Envuelve `parser.processFile` con manejo de errores para que un archivo
   * malformado no detenga el análisis del resto del proyecto.
   */
  #safeProcessFile(extractor: CodeExtractor, sourceFile: SourceFile): void {
    try {
      extractor.processFile(sourceFile);
    } catch (err) {
      console.error(
        `[Daemon] ⚠  Error analizando ${sourceFile.getFilePath()}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
