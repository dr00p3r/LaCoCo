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
 *           ├─▶ GraphExtractor.processFile()   ← núcleo AST (sin lado)
 *           └─▶ LaCoCoDatabase.*              ← persistencia
 */

import path from "node:path";
import { Project, type SourceFile } from "ts-morph";
import chokidar, { type FSWatcher } from "chokidar";
import type { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { GraphExtractor } from "./graph-extractor.js";
import { EmbeddingIndexer } from "../retriever/utilities/embeddings/embedding-indexer.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";

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
}

// ─────────────────────────────────────────────────────────────────────────────
// DaemonManager
// ─────────────────────────────────────────────────────────────────────────────

export class DaemonManager {
  private readonly project: Project;
  private readonly parser: GraphExtractor;
  private watcher: FSWatcher | null = null;

  private readonly tsConfigFilePath: string;
  private readonly db: LaCoCoDatabase;
  private readonly watchGlob: string;
  private readonly verbose: boolean;
  private readonly indexEmbeddings: boolean;
  private readonly lanceDbPath: string;
  private embeddingsPromise: Promise<void> | null = null;

  constructor(opts: DaemonOptions) {
    this.tsConfigFilePath = path.resolve(opts.tsConfigFilePath);
    this.db = opts.db;
    this.verbose = opts.verbose ?? false;
    this.indexEmbeddings = opts.indexEmbeddings ?? true;
    this.lanceDbPath = opts.lanceDbPath ?? "./lancedb";

    // Directorio que contiene el tsconfig → raíz del proyecto a observar
    const projectRoot = path.dirname(this.tsConfigFilePath);
    this.watchGlob =
      opts.watchGlob ?? path.join(projectRoot, "**", "*.ts");

    // ts-morph Project: carga el grafo de tipos completo del proyecto
    this.project = new Project({
      tsConfigFilePath: this.tsConfigFilePath,
    });

    // GraphExtractor recibe la conexión raw de SQLite para sus prepared statements
    this.parser = new GraphExtractor(this.db.getRawDb());
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
   *   - Cierra la conexión SQLite.
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.db.close();
    console.log("\n[Daemon] 🛑 Apagado limpio completado.");
  }

  /**
   * Espera a que los embeddings terminen (si están en progreso).
   * Útil en modo index (one-shot) para no cerrar la BD antes de tiempo.
   */
  async awaitEmbeddings(): Promise<void> {
    if (this.embeddingsPromise) {
      await this.embeddingsPromise;
    }
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
     * en < 5 segundos gracias a los prepared statements del GraphExtractor.
   */
  #coldStart(): void {
    console.log("\n[Daemon] 🚀 Cold start — analizando proyecto completo...");
    console.time("[Daemon] Cold start");

    const sourceFiles = this.project.getSourceFiles();
    const total = sourceFiles.length;
    console.log(`[Daemon]    ${total} archivos TypeScript encontrados.`);

    this.parser.resetStats();

    // Una única transacción para todos los archivos → máximo rendimiento
    this.db.transaction(() => {
      for (const file of sourceFiles) {
        if (this.verbose) {
          console.log(`[Daemon]    ✍  ${file.getFilePath()}`);
        }
        this.#safeProcessFile(file);
      }
    });

    const { nodesWritten, edgesWritten } = this.parser.getStats();
    console.timeEnd("[Daemon] Cold start");
    console.log(
      `[Daemon] ✅ Grafo construido — ${nodesWritten} nodos, ${edgesWritten} aristas.`
    );

    // Post-cold-start: generar embeddings en LanceDB
    if (this.indexEmbeddings && nodesWritten > 0) {
      this.embeddingsPromise = this.#generateEmbeddings();
    }
  }

  /**
   * Genera embeddings para todos los nodos y los persiste en LanceDB.
   * Se ejecuta de forma async para no bloquear el cold-start sincrónico.
   */
  async #generateEmbeddings(): Promise<void> {
    console.log("[Daemon] 🧠 Generando embeddings semánticos...");
    console.time("[Daemon] Embeddings");

    const lanceDb = new LaCoCoLanceDb(this.lanceDbPath);
    try {
      await lanceDb.connect();
      const indexer = new EmbeddingIndexer(this.db, lanceDb);
      await indexer.indexAll((current, total) => {
        if (this.verbose) {
          console.log(`[Daemon]    ${current}/${total} embeddings...`);
        }
      });
      console.timeEnd("[Daemon] Embeddings");
    } catch (err) {
      console.error("[Daemon] ❌ Error generando embeddings:", err instanceof Error ? err.message : err);
    } finally {
      await lanceDb.close();
    }
  }

  /**
   * Re-indexa embeddings para un archivo específico tras hot-reload.
   */
  async #reindexEmbeddings(filePath: string): Promise<void> {
    const lanceDb = new LaCoCoLanceDb(this.lanceDbPath);
    try {
      await lanceDb.connect();
      const indexer = new EmbeddingIndexer(this.db, lanceDb);
      await indexer.indexFile(filePath);
    } catch (err) {
      console.error(`[Daemon] ❌ Error re-indexando embeddings de ${filePath}:`, err instanceof Error ? err.message : err);
    } finally {
      await lanceDb.close();
    }
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
        stabilityThreshold: 80,     // ms de silencio antes de disparar el evento
        pollInterval: 20,
      },
    });

    this.watcher.on("change", (filePath) => {
      void this.#handleFileChange(filePath, "change");
    });

    this.watcher.on("add", (filePath) => {
      void this.#handleFileChange(filePath, "add");
    });

    this.watcher.on("unlink", (filePath) => {
      this.#handleFileDelete(filePath);
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
     *   5. Re-procesar con GraphExtractor en una transacción nueva.
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
      this.parser.resetStats();
      this.db.transaction(() => {
        // 3. Purgar el archivo modificado y re-procesarlo con el AST fresco
        this.#purgeFile(filePath);
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes: sus aristas a los tipos del
        //    archivo modificado pueden haber quedado obsoletas o huérfanas
        //    (CASCADE borró las entrantes al hacer purge del archivo modificado).
        for (const dep of filesToPropagate) {
          // Refrescamos el contexto de tipos TRAS haber regenerado el archivo fuente
          dep.refreshFromFileSystemSync();
          this.#purgeFile(dep.getFilePath());
          this.#safeProcessFile(dep);
        }
      });

      const { nodesWritten, edgesWritten } = this.parser.getStats();
      console.log(
        `[Daemon]    ↳ ${nodesWritten} nodos, ${edgesWritten} aristas actualizados` +
          (filesToPropagate.length > 0
            ? ` (+ ${filesToPropagate.length} archivo(s) propagados).`
            : ".")
      );

      // Hot-reload de embeddings para archivos modificados
      if (this.indexEmbeddings && nodesWritten > 0) {
        void this.#reindexEmbeddings(filePath);
        for (const dep of filesToPropagate) {
          void this.#reindexEmbeddings(dep.getFilePath());
        }
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
   * Estrategia sin ON DELETE CASCADE:
   *   1. Obtener los ids de los nodos del archivo.
   *   2. Borrar las aristas donde sourceId O targetId pertenece a esos ids.
   *   3. Borrar los nodos del archivo.
   *
   * Esto garantiza consistencia aunque el schema no tenga CASCADE configurado.
   */
  #purgeFile(filePath: string): void {
    this.db.deleteNodesByFile(filePath);
  }

  /**
   * Envuelve `parser.processFile` con manejo de errores para que un archivo
   * malformado no detenga el análisis del resto del proyecto.
   */
  #safeProcessFile(sourceFile: SourceFile): void {
    try {
      this.parser.processFile(sourceFile);
    } catch (err) {
      console.error(
        `[Daemon] ⚠  Error analizando ${sourceFile.getFilePath()}:`,
        err instanceof Error ? err.message : err
      );
    }
  }
}
