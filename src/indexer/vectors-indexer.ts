import { Project, type SourceFile } from "ts-morph";
import { CodeExtractor } from "../extractor/code-extractor.js";
import { VectorCallbacks } from "../extractor/vector-callbacks.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { EmbeddingGenerator } from "../embeddings/embedding-generator.js";

type VectorStore = Pick<LaCoCoLanceDb, "buildIndex" | "clear" | "close" | "connect" | "replaceBatch">;

export class VectorsIndexer {
  private readonly lanceDb: VectorStore;
  private readonly tsConfigPaths: string[];

  constructor(
    lanceDbPath: string,
    tsConfigPath: string | string[],
    createLanceDb: (lanceDbPath: string) => VectorStore = (path) => new LaCoCoLanceDb(path),
  ) {
    this.lanceDb = createLanceDb(lanceDbPath);
    this.tsConfigPaths = Array.isArray(tsConfigPath) ? tsConfigPath : [tsConfigPath];
  }

  async index(): Promise<void> {
    await this.lanceDb.connect();
    try {
      await this.lanceDb.clear();

      console.log(`[VectorsIndexer] Proyectos TS detectados: ${this.tsConfigPaths.length}`);

      const embedGen = new EmbeddingGenerator();
      const generateEmbedding = (texts: string[]) => embedGen.generateBatch(texts);

      const callbacks = new VectorCallbacks(
        this.lanceDb,
        generateEmbedding,
      );
      const codeExtractor = new CodeExtractor(callbacks);

      await this.#insertIntoLanceDB(codeExtractor, callbacks);
      await this.lanceDb.buildIndex();
    } finally {
      await this.lanceDb.close();
    }
  }

  async #insertIntoLanceDB(
    codeExtractor: CodeExtractor, 
    callbacks: VectorCallbacks
  ): Promise<void> {
    let processedFiles = 0;
    let failedProjects = 0;
    const seenFiles = new Set<string>();

    console.time("[VectorsIndexer] Extracción + Embeddings");
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

      console.log(`[VectorsIndexer] ${tsconfigPath} → ${sourceFiles.length} archivos`);
      for (const file of sourceFiles) {
        const filePath = file.getFilePath();
        if (seenFiles.has(filePath)) continue;
        seenFiles.add(filePath);
        try {
          codeExtractor.processFile(file);
          processedFiles++;
        } catch (err) {
          console.error(
            `  ⚠  Error analizando ${filePath}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }
    await callbacks.flush();
    console.timeEnd("[VectorsIndexer] Extracción + Embeddings");

    if (processedFiles === 0) {
      throw new Error("No se pudo procesar ningún archivo TypeScript/JavaScript indexable");
    }

    console.log(
      `[VectorsIndexer] ✅ ${callbacks.nodesWritten} embeddings insertados en LanceDB, ` +
      `${processedFiles} archivos procesados, ${failedProjects} proyectos omitidos.`
    );
  }

}
