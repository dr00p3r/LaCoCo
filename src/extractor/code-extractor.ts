/**
 * CodeExtractor — Núcleo de análisis estático del Grafo Multirrelacional
 *
 * Recibe una instancia de better-sqlite3 y produce un grafo semántico de 3 capas:
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  SYS  (Ecosistema)   EXTENDS · IMPLEMENTS · IMPORTS_EXTERNAL   │
 *   │  CPG  (Estructura)   INJECTS · CALLS · INSTANTIATES            │
 *   │  DTG  (Flujo datos)  CONSUMES_DATA · PRODUCES · MUTATES_STATE  │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * REGLAS ESTRICTAS:
 *   - CERO expresiones regulares. Solo AST de ts-morph.
 *   - Los prepared statements se crean una vez en el constructor.
 *   - Todos los errores de resolución se descartan silenciosamente
 *     (un tipo que no se puede resolver no debe detener el análisis).
 *
 * La lógica de extracción está delegada en módulos especializados:
 *   - node-extraction.ts    → interfaces, types, enums, funciones, clases
 *   - class-extraction.ts   → SYS + CPG para clases
 *   - callable-analysis.ts  → DTG + recorrido profundo AST
 *   - variable-extraction.ts → arrow functions exportadas y objetos literales
 *   - utilities.ts          → firmas, resolución de tipos, JSDoc, helpers
 */

import Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import type { SourceFile } from "ts-morph";
import { type NodeRow, type EdgeRelation, type EdgeRow, type ExtractionCallbacks } from "./types.js";
import { extractNodes } from "./node-extraction.js";

export class CodeExtractor {
  private readonly stmtInsertNode: Statement;
  private readonly stmtInsertEdge: Statement;

  private nodesWritten = 0;
  private edgesWritten = 0;

  constructor(private readonly db: Database.Database) {
    this.stmtInsertNode = this.db.prepare(`
      INSERT OR REPLACE INTO nodes
        (id, kind, name, filepath, signature, isDeprecated)
      VALUES
        (@id, @kind, @name, @filepath, @signature, @isDeprecated)
    `);

    this.stmtInsertEdge = this.db.prepare(`
      INSERT OR IGNORE INTO edges (sourceId, targetId, relation)
      VALUES (@sourceId, @targetId, @relation)
    `);
  }

  // ───────────────────────────────────────────────────────────────────────────
  // API pública
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Punto de entrada principal. Analiza **un** archivo TypeScript y persiste
   * todos los nodos y aristas detectados delegando en los extractores especializados.
   *
   * @param sourceFile  SourceFile de ts-morph, ya cargado en el proyecto.
   */
  processFile(sourceFile: SourceFile): void {
    const filePath = sourceFile.getFilePath();
    extractNodes(sourceFile, filePath, this.#callbacks);
  }

  /**
   * Devuelve métricas de la sesión de parseo actual
   * (acumuladas desde que se construyó la instancia).
   */
  getStats(): { nodesWritten: number; edgesWritten: number } {
    return { nodesWritten: this.nodesWritten, edgesWritten: this.edgesWritten };
  }

  /** Resetea los contadores de métricas. */
  resetStats(): void {
    this.nodesWritten = 0;
    this.edgesWritten = 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // Callbacks de persistencia
  // ───────────────────────────────────────────────────────────────────────────

  get #callbacks(): ExtractionCallbacks {
    return {
      insertNode: (row: NodeRow): void => {
        this.stmtInsertNode.run(row);
        this.nodesWritten++;
      },
      insertEdge: (sourceId: string, targetId: string, relation: EdgeRelation): void => {
        if (sourceId === targetId) return;
        this.stmtInsertEdge.run({
          sourceId,
          targetId,
          relation,
        } satisfies EdgeRow);
        this.edgesWritten++;
      },
    };
  }
}
