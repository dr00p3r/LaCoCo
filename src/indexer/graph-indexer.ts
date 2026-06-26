import { LaCoCoDatabase } from "../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";
import { Project } from "ts-morph";
import { CodeExtractor } from "../extractor/code-extractor.js";
import { SqliteCallbacks } from "../extractor/sqlite-callbacks.js";

export class GraphIndexer {

    private readonly db: LaCoCoDatabase;
    private readonly tsConfigPath: string;

    constructor(dbPath : string, tsConfigPath : string) {
        this.db = new LaCoCoDatabase(dbPath);
        this.tsConfigPath = tsConfigPath;
    }

    index() {
        const project = new Project({ tsConfigFilePath: this.tsConfigPath });
        const callbacks = new SqliteCallbacks(this.db.getRawDb());
        const codeExtractor = new CodeExtractor(callbacks);

        const sourceFiles = project.getSourceFiles();
        console.log(`[CLI]/[GraphIndexer] Archivos encontrados: ${sourceFiles.length}`);

        try {
          this.#insertIntoDatabase(sourceFiles, codeExtractor, callbacks);
        } finally {
          this.db.close();
        }
    }

    #insertIntoDatabase(
        sourceFiles: ReturnType<Project["getSourceFiles"]>,
        codeExtractor: CodeExtractor,
        callbacks: SqliteCallbacks
    ) {
        
        console.time("[CLI]/[GraphIndexer] Extracción");
        this.db.transaction(() => {
            this.db.clearGraph();
            for (const file of sourceFiles) {
                try {
                    codeExtractor.processFile(file);
                } catch (err) {
                    console.error(
                        `  ⚠  Error analizando ${file.getFilePath()}:`,
                        err instanceof Error ? err.message : err
                    );
                }
            }
        });
        console.timeEnd("[CLI]/[GraphIndexer] Extracción");

        console.log(`[CLI] ✅ Grafo — ${callbacks.nodesWritten} nodos, ${callbacks.edgesWritten} aristas.`);

        console.log(`[CLI] 🏷️  Poblando metadatos dimensionales...`);
        this.db.populateMetadata();
    }
}
