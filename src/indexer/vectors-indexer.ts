import { Project } from "ts-morph";
import { CodeExtractor } from "../extractor/code-extractor.js";
import { VectorCallbacks } from "../extractor/vector-callbacks.js";
import { LaCoCoLanceDb } from "../persistence/lacoco-vectors-manager/lacoco-lancedb-service.js";
import { EmbeddingGenerator } from "../retriever/utilities/embeddings/embedding-generator.js";

export class VectorsIndexer {
  private readonly lanceDb: LaCoCoLanceDb;
  private readonly tsConfigPath: string;

  constructor(lanceDbPath: string, tsConfigPath: string) {
    this.lanceDb = new LaCoCoLanceDb(lanceDbPath);
    this.tsConfigPath = tsConfigPath;
  }

  async index(): Promise<void> {
    await this.lanceDb.connect();

    const project = new Project({ tsConfigFilePath: this.tsConfigPath });
    const sourceFiles = project.getSourceFiles();
    console.log(`[VectorsIndexer] Archivos encontrados: ${sourceFiles.length}`);

    const embedGen = new EmbeddingGenerator();
    const generateEmbedding = (text: string) => embedGen.generate(text);

    const callbacks = new VectorCallbacks(
      this.lanceDb,
      generateEmbedding,
    );
    const codeExtractor = new CodeExtractor(callbacks);

    await this.#insertIntoLanceDB(codeExtractor, callbacks, sourceFiles);
  }

  async #insertIntoLanceDB(
    codeExtractor: CodeExtractor, 
    callbacks: VectorCallbacks, 
    sourceFiles: ReturnType<Project["getSourceFiles"]>
  ): Promise<void> {
    console.time("[VectorsIndexer] Extracción + Embeddings");
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
    await callbacks.flush();
    console.timeEnd("[VectorsIndexer] Extracción + Embeddings");

    console.log(`[VectorsIndexer] ✅ ${callbacks.nodesWritten} embeddings insertados en LanceDB.`);
    await this.lanceDb.close();
  }

}
