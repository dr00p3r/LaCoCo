import { Project } from "ts-morph";
import { CodeExtractor } from "../extractor/code-extractor.js";
import type { ExtractionCallbacks, NodeRow } from "../extractor/types.js";
import { KIND_TO_DIM } from "../domain/dimensions.js";
import { EmbeddingGenerator } from "../embeddings/embedding-generator.js";
import type { LlmClient } from "../slms/llm-client.js";
import { PropositionEnricher } from "../semantic-profile/proposition-enricher.js";
import { LaCoCoPropositionsDb } from "../persistence/lacoco-propositions-manager/lacoco-propositions-db.js";
import type { NodePropositionRecord } from "../persistence/lacoco-propositions-manager/model/types.js";

const WRITE_BATCH_SIZE = 32;

/**
 * Indexa el canal doc-side de C2 en la tabla LanceDB `node_propositions`.
 *
 * Opt-in y desacoplado: re-extrae los nodos del AST (como `VectorsIndexer`, sin
 * tocarlo), pide 1..N proposiciones por nodo al SLM, embebe cada proposición y
 * las escribe en su tabla separada. El `VectorsIndexer`/`node_embeddings` queda
 * intacto → cero regresión para las 8 estrategias cuando el flag está off.
 */
export class PropositionsIndexer {
  constructor(
    private readonly lanceDbPath: string,
    private readonly tsConfigPath: string,
    private readonly llm: LlmClient,
    private readonly concurrency = 1,
    private readonly createStore: (path: string) => LaCoCoPropositionsDb = (path) => new LaCoCoPropositionsDb(path),
    private readonly embedGen: EmbeddingGenerator = new EmbeddingGenerator(),
  ) {}

  async index(): Promise<void> {
    const nodes = this.#collectNodes();
    console.log(`[PropositionsIndexer] Nodos candidatos: ${nodes.length}`);

    const enricher = new PropositionEnricher(this.llm, this.concurrency);
    const enriched = await enricher.enrich(
      nodes.map((node) => ({ id: node.id, name: node.name, signature: node.signature })),
    );

    const byId = new Map(nodes.map((node) => [node.id, node]));
    const items: { node: NodeRow; text: string; index: number }[] = [];
    for (const entry of enriched) {
      const node = byId.get(entry.id);
      if (!node) continue;
      entry.propositions.forEach((text, index) => items.push({ node, text, index }));
    }
    console.log(`[PropositionsIndexer] Proposiciones a embeber: ${items.length}`);

    const store = this.createStore(this.lanceDbPath);
    await store.reset();
    let written = 0;
    for (let offset = 0; offset < items.length; offset += WRITE_BATCH_SIZE) {
      const slice = items.slice(offset, offset + WRITE_BATCH_SIZE);
      const embeddings = await this.embedGen.generateBatch(slice.map((item) => item.text));
      const records: NodePropositionRecord[] = [];
      for (let i = 0; i < slice.length; i++) {
        const { node, text, index } = slice[i]!;
        const embedding = embeddings[i] ?? new Float32Array(0);
        if (embedding.length === 0) continue; // el generador falló para este texto
        records.push({
          prop_id: `${node.id}#prop${index}`,
          real_node_id: node.id,
          embedding,
          text,
          dimension: KIND_TO_DIM[node.kind] ?? "DTG",
          file_path: node.filepath,
        });
      }
      await store.add(records);
      written += records.length;
    }
    await store.buildIndex();
    await store.close();
    console.log(`[PropositionsIndexer] ✅ ${written} filas de proposición escritas en LanceDB.`);
  }

  #collectNodes(): NodeRow[] {
    const project = new Project({ tsConfigFilePath: this.tsConfigPath });
    const collected: NodeRow[] = [];
    const callbacks: ExtractionCallbacks = {
      insertNode: (row) => collected.push(row),
      insertEdge: () => {},
    };
    const extractor = new CodeExtractor(callbacks);
    for (const file of project.getSourceFiles()) {
      try {
        extractor.processFile(file);
      } catch (err) {
        console.error(
          `  ⚠  Error analizando ${file.getFilePath()}:`,
          err instanceof Error ? err.message : err,
        );
      }
    }
    // Solo nodos de código propio con nombre; las libs externas no aportan
    // edit-sites y una proposición sobre ellas solo mete ruido.
    return collected.filter((node) => node.kind !== "EXTERNAL_LIB" && node.name.trim().length > 0);
  }
}
