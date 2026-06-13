/**
 * CodeExtractor — Núcleo de análisis estático del Grafo Multirrelacional
 *
 * Recibe una implementación de ExtractionCallbacks y delega la persistencia
 * de nodos y aristas en quien los implemente (SqliteCallbacks, VectorCallbacks).
 *
 *   ┌─────────────────────────────────────────────────────────────────┐
 *   │  SYS  (Ecosistema)   EXTENDS · IMPLEMENTS · IMPORTS_EXTERNAL   │
 *   │  CPG  (Estructura)   INJECTS · CALLS · INSTANTIATES            │
 *   │  DTG  (Flujo datos)  CONSUMES_DATA · PRODUCES · MUTATES_STATE  │
 *   └─────────────────────────────────────────────────────────────────┘
 *
 * REGLAS ESTRICTAS:
 *   - CERO expresiones regulares. Solo AST de ts-morph.
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

import type { SourceFile } from "ts-morph";
import type { ExtractionCallbacks } from "./types.js";
import { extractNodes } from "./node-extraction.js";

export class CodeExtractor {
  constructor(private readonly callbacks: ExtractionCallbacks) {}

  /**
   * Punto de entrada principal. Analiza **un** archivo TypeScript y emite
   * nodos y aristas a través de los callbacks recibidos en el constructor.
   *
   * @param sourceFile  SourceFile de ts-morph, ya cargado en el proyecto.
   */
  processFile(sourceFile: SourceFile): void {
    const filePath = sourceFile.getFilePath();
    extractNodes(sourceFile, filePath, this.callbacks);
  }
}
