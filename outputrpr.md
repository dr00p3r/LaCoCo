---
lacoco_export_version: 1
context_id: "b79ed9fda285e438"
question: "modify the recovery chunks of the strategies based on hybrid to be only 20"
generated_at: "2026-06-27T23:20:13.505Z"
strategy: "rpr"
route: "RAG"
intent: "refactor"
confidence: 0.95
dimensions: ["SYS"]
chunks: 13
---
# LaCoCo Context Export

## Question

modify the recovery chunks of the strategies based on hybrid to be only 20

## Retrieval Metadata

| Field | Value |
|---|---|
| Context ID | `b79ed9fda285e438` |
| Generated at | 2026-06-27T23:20:13.505Z |
| Strategy | `rpr` |
| Route | `RAG` |
| Intent | `refactor` |
| Confidence | `0.95` |
| Dimensions | `SYS` |
| SQLite | `/home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/.lacoco/tensor.sqlite` |
| LanceDB | `/home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/.lacoco/lancedb` |

## Clean Query

```text
modify recovery chunks of strategies based on hybrid to be only 20
```

## Embedding Input

```text
Modificar las secciones de recuperación de estrategias basadas en el Hybrid para que sean solo 20
```

## Enriched Prompt

```text
### Contexto del Proyecto (recuperado automáticamente)
Los siguientes fragmentos de código fueron recuperados del repositorio actual
como contexto para tu consulta. Úsalos como referencia absoluta de firmas,
tipos y dependencias locales, y sobre todo, como ubicación de archivos. 
No inventes símbolos que no aparezcan aquí.

[1] RPR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-graph-manager/lacoco-sqlite-service.ts#LaCoCoDatabase
export class HybridStrategy extends AbstractAnchoredStrategy --EXTENDS--> export abstract class AbstractAnchoredStrategy implements RecoveryStrategy --INJECTS--> export class LaCoCoDatabase | dims: SYS→CPG | relations: EXTENDS, INJECTS

---

[2] RPR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.ts#LaCoCoLanceDb
export class HybridStrategy extends AbstractAnchoredStrategy --EXTENDS--> export abstract class AbstractAnchoredStrategy implements RecoveryStrategy --INJECTS--> export class LaCoCoLanceDb | dims: SYS→CPG | relations: EXTENDS, INJECTS

---

[3] RPR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/node_modules/.pnpm/@types+better-sqlite3@7.6.13/node_modules/@types/better-sqlite3/index.d.ts#Database
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --MUTATES_STATE--> export class SqliteCallbacks implements ExtractionCallbacks --INJECTS--> /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/node_modules/.pnpm/@types+better-sqlite3@7.6.13/node_modules/@types/better-sqlite3/index.d.ts#Database | dims: DTG→CPG | relations: MUTATES_STATE, INJECTS

---

[4] RPR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/types.ts#ExtractionCallbacks
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --MUTATES_STATE--> export class SqliteCallbacks implements ExtractionCallbacks --IMPLEMENTS--> export interface ExtractionCallbacks {} | dims: DTG→SYS | relations: MUTATES_STATE, IMPLEMENTS

---

[5] RPR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/abstract-anchored-strategy.ts#AbstractAnchoredStrategy
export class HybridStrategy extends AbstractAnchoredStrategy --EXTENDS--> export abstract class AbstractAnchoredStrategy implements RecoveryStrategy | dims: SYS | relations: EXTENDS

---

[6] RPR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#StrategyEntry
export function getStrategyEntry(strategyName: string): StrategyEntry {
  if (!isStrategyName(strategyName)) {
    throw new Error(`Estrategia no soportada: ${strategyName}`);
  }
  return STRATEGY_REGISTRY[strategyName];
} --PRODUCES--> export interface StrategyEntry {} | dims: DTG | relations: PRODUCES

---

[7] RPR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/models/strategies/types.ts#RecoveryStrategy
export class HybridStrategy extends AbstractAnchoredStrategy --EXTENDS--> export abstract class AbstractAnchoredStrategy implements RecoveryStrategy --IMPLEMENTS--> export interface RecoveryStrategy {} | dims: SYS | relations: EXTENDS, IMPLEMENTS

---

[8] RPR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/node_modules/.pnpm/ts-morph@27.0.2/node_modules/ts-morph/lib/ts-morph.d.ts#SourceFile
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --CONSUMES_DATA--> /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/node_modules/.pnpm/ts-morph@27.0.2/node_modules/ts-morph/lib/ts-morph.d.ts#SourceFile | dims: DTG | relations: CONSUMES_DATA

---

[9] RPR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/sqlite-callbacks.ts#SqliteCallbacks
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --MUTATES_STATE--> export class SqliteCallbacks implements ExtractionCallbacks | dims: DTG | relations: MUTATES_STATE

---

[10] RPR | /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/types.ts#NodeRow
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --CONSUMES_DATA--> export interface NodeRow {} | dims: DTG | relations: CONSUMES_DATA

---

[11] RPR | lib#@types/node#relative
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --IMPORTS_EXTERNAL--> function relative(from: string, to: string): string; | dims: SYS | relations: IMPORTS_EXTERNAL

---

[12] RPR | lib#@types/node#time
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --IMPORTS_EXTERNAL--> time(label?: string): void; | dims: SYS | relations: IMPORTS_EXTERNAL

---

[13] RPR | lib#typescript#join
export function strategyHelp(): string {
  return `Estrategia de recuperación (${STRATEGY_NAMES.join(", ")}); por defecto strategy.default`;
} --IMPORTS_EXTERNAL--> join(separator?:string):string; | dims: SYS | relations: IMPORTS_EXTERNAL

### Fin del Contexto

modify the recovery chunks of the strategies based on hybrid to be only 20
```

## Retrieved Chunks

### 1. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-graph-manager/lacoco-sqlite-service.ts#LaCoCoDatabase

- Source: `RPR`
- Score: `0.0223`

```text
export class HybridStrategy extends AbstractAnchoredStrategy --EXTENDS--> export abstract class AbstractAnchoredStrategy implements RecoveryStrategy --INJECTS--> export class LaCoCoDatabase | dims: SYS→CPG | relations: EXTENDS, INJECTS
```

### 2. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/persistence/lacoco-vectors-manager/lacoco-lancedb-service.ts#LaCoCoLanceDb

- Source: `RPR`
- Score: `0.0220`

```text
export class HybridStrategy extends AbstractAnchoredStrategy --EXTENDS--> export abstract class AbstractAnchoredStrategy implements RecoveryStrategy --INJECTS--> export class LaCoCoLanceDb | dims: SYS→CPG | relations: EXTENDS, INJECTS
```

### 3. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/node_modules/.pnpm/@types+better-sqlite3@7.6.13/node_modules/@types/better-sqlite3/index.d.ts#Database

- Source: `RPR`
- Score: `0.0185`

```text
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --MUTATES_STATE--> export class SqliteCallbacks implements ExtractionCallbacks --INJECTS--> /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/node_modules/.pnpm/@types+better-sqlite3@7.6.13/node_modules/@types/better-sqlite3/index.d.ts#Database | dims: DTG→CPG | relations: MUTATES_STATE, INJECTS
```

### 4. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/types.ts#ExtractionCallbacks

- Source: `RPR`
- Score: `0.0172`

```text
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --MUTATES_STATE--> export class SqliteCallbacks implements ExtractionCallbacks --IMPLEMENTS--> export interface ExtractionCallbacks {} | dims: DTG→SYS | relations: MUTATES_STATE, IMPLEMENTS
```

### 5. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/abstract-anchored-strategy.ts#AbstractAnchoredStrategy

- Source: `RPR`
- Score: `0.0137`

```text
export class HybridStrategy extends AbstractAnchoredStrategy --EXTENDS--> export abstract class AbstractAnchoredStrategy implements RecoveryStrategy | dims: SYS | relations: EXTENDS
```

### 6. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/strategies/registry.ts#StrategyEntry

- Source: `RPR`
- Score: `0.0136`

```text
export function getStrategyEntry(strategyName: string): StrategyEntry {
  if (!isStrategyName(strategyName)) {
    throw new Error(`Estrategia no soportada: ${strategyName}`);
  }
  return STRATEGY_REGISTRY[strategyName];
} --PRODUCES--> export interface StrategyEntry {} | dims: DTG | relations: PRODUCES
```

### 7. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/retriever/models/strategies/types.ts#RecoveryStrategy

- Source: `RPR`
- Score: `0.0111`

```text
export class HybridStrategy extends AbstractAnchoredStrategy --EXTENDS--> export abstract class AbstractAnchoredStrategy implements RecoveryStrategy --IMPLEMENTS--> export interface RecoveryStrategy {} | dims: SYS | relations: EXTENDS, IMPLEMENTS
```

### 8. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/node_modules/.pnpm/ts-morph@27.0.2/node_modules/ts-morph/lib/ts-morph.d.ts#SourceFile

- Source: `RPR`
- Score: `0.0110`

```text
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --CONSUMES_DATA--> /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/node_modules/.pnpm/ts-morph@27.0.2/node_modules/ts-morph/lib/ts-morph.d.ts#SourceFile | dims: DTG | relations: CONSUMES_DATA
```

### 9. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/sqlite-callbacks.ts#SqliteCallbacks

- Source: `RPR`
- Score: `0.0110`

```text
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --MUTATES_STATE--> export class SqliteCallbacks implements ExtractionCallbacks | dims: DTG | relations: MUTATES_STATE
```

### 10. /home/rubenbenavides/ESPE/MIC/Desarrollos/extractor/src/extractor/types.ts#NodeRow

- Source: `RPR`
- Score: `0.0110`

```text
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --CONSUMES_DATA--> export interface NodeRow {} | dims: DTG | relations: CONSUMES_DATA
```

### 11. lib#@types/node#relative

- Source: `RPR`
- Score: `0.0110`

```text
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --IMPORTS_EXTERNAL--> function relative(from: string, to: string): string; | dims: SYS | relations: IMPORTS_EXTERNAL
```

### 12. lib#@types/node#time

- Source: `RPR`
- Score: `0.0110`

```text
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
        this.#safeProcessFile(sourceFile);

        // 4. Propagar a archivos dependientes
        allPurgedIds = [...purgedIds];
        for (const dep of filesToPropagate) {
          dep.refreshFromFileSystemSync();
          const depIds = this.#purgeFile(dep.getFilePath());
          allPurgedIds.push(...depIds);
          this.#safeProcessFile(dep);
        }
      });
      const updatedSourcePaths = [
        filePath,
        ...filesToPropagate.map((dep) => dep.getFilePath()),
      ];
      const newNodeIds = updatedSourcePaths.flatMap((sourcePath) =>
        this.vectorNodeBuffer.get(sourcePath).map((row) => row.id)
      );
      this.db.populateMetadataForNodes([...new Set([...allPurgedIds, ...newNodeIds])]);

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
      this.#recordError(
        "file-queue",
        new Error(`Error procesando ${filePath}`, { cause: err }),
      );
    } finally {
      // Garantiza que el timer siempre cierra, incluso si hay excepción temprana
      console.timeEnd(label);
    }
  } --IMPORTS_EXTERNAL--> time(label?: string): void; | dims: SYS | relations: IMPORTS_EXTERNAL
```

### 13. lib#typescript#join

- Source: `RPR`
- Score: `0.0110`

```text
export function strategyHelp(): string {
  return `Estrategia de recuperación (${STRATEGY_NAMES.join(", ")}); por defecto strategy.default`;
} --IMPORTS_EXTERNAL--> join(separator?:string):string; | dims: SYS | relations: IMPORTS_EXTERNAL
```
