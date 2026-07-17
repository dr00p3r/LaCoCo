import { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { Project, type SourceFile } from "ts-morph";
import { CodeExtractor } from "../extractor/code-extractor.js";
import { SqliteCallbacks } from "../extractor/sqlite-callbacks.js";
import { NOOP_PROGRESS, type IndexProgress } from "./progress.js";

export class GraphIndexer {

    private readonly db: LaCoCoDatabase;
    private readonly tsConfigPaths: string[];
    private readonly onProgress: IndexProgress;

    constructor(dbPath : string, tsConfigPath : string | string[], onProgress: IndexProgress = NOOP_PROGRESS) {
        this.db = new LaCoCoDatabase(dbPath);
        this.tsConfigPaths = Array.isArray(tsConfigPath) ? tsConfigPath : [tsConfigPath];
        this.onProgress = onProgress;
    }

    index() {
        const callbacks = new SqliteCallbacks(this.db.getRawDb());
        const codeExtractor = new CodeExtractor(callbacks);

        console.log(`[CLI]/[GraphIndexer] Proyectos TS detectados: ${this.tsConfigPaths.length}`);

        try {
          this.#insertIntoDatabase(codeExtractor, callbacks);
        } finally {
          this.db.close();
        }
    }

    #insertIntoDatabase(
        codeExtractor: CodeExtractor,
        callbacks: SqliteCallbacks
    ) {
        let processedFiles = 0;
        let failedProjects = 0;
        let totalFiles = 0;
        const seenFiles = new Set<string>();

        console.time("[CLI]/[GraphIndexer] Extracción");
        this.db.transaction(() => {
            this.db.clearGraph();
            for (const tsconfigPath of this.tsConfigPaths) {
                let sourceFiles: SourceFile[];
                try {
                    const project = new Project({ tsConfigFilePath: tsconfigPath });
                    sourceFiles = project.getSourceFiles();
                } catch (err) {
                    failedProjects++;
                    console.error(
                        `  ⚠  Error cargando ${tsconfigPath}:`,
                        err instanceof Error ? err.message : err
                    );
                    continue;
                }

                totalFiles += sourceFiles.length;
                console.log(`[CLI]/[GraphIndexer] ${tsconfigPath} → ${sourceFiles.length} archivos`);
                for (const file of sourceFiles) {
                    const filePath = file.getFilePath();
                    if (seenFiles.has(filePath)) continue;
                    seenFiles.add(filePath);
                    try {
                        codeExtractor.processFile(file);
                        processedFiles++;
                        this.onProgress({
                            current: processedFiles,
                            total: totalFiles,
                            nodes: callbacks.nodesWritten,
                            edges: callbacks.edgesWritten,
                        });
                    } catch (err) {
                        console.error(
                            `  ⚠  Error analizando ${filePath}:`,
                            err instanceof Error ? err.message : err
                        );
                    }
                }
            }
        });
        console.timeEnd("[CLI]/[GraphIndexer] Extracción");

        if (processedFiles === 0) {
            throw new Error("No se pudo procesar ningun archivo TypeScript/JavaScript indexable");
        }

        console.log(
            `[CLI] ✅ Grafo — ${callbacks.nodesWritten} nodos, ${callbacks.edgesWritten} aristas, ` +
            `${processedFiles} archivos procesados, ${failedProjects} proyectos omitidos.`
        );

        console.log(`[CLI] 🏷️  Poblando metadatos dimensionales...`);
        this.db.populateMetadata();
        this.db.bumpGraphRevision();
    }
}
