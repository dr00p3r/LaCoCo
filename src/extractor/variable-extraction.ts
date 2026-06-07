/**
 * Extracción de variables exportadas (§4.3 del GraphExtractor original).
 *
 * Patrones cubiertos:
 *
 *   export const calculateTaxes = (order: IOrder): number => { ... }
 *     → Nodo ARROW_FUNCTION con análisis completo de DTG/CPG/SYS
 *
 *   export const AppConfig = { dbUrl: '...', port: 3000 }
 *     → Nodo VARIABLE (objeto de configuración)
 *
 *   export const handlers = { create: (dto) => {...}, delete: (id) => {...} }
 *     → Nodo VARIABLE + nodos ARROW_FUNCTION por cada método
 */

import {
  Node,
  type SourceFile,
  type ArrowFunction,
  type ObjectLiteralExpression,
  type MethodDeclaration,
} from "ts-morph";
import { type ExtractionCallbacks } from "./types.js";
import {
  isDeprecated,
  buildArrowSignature,
  getMethodSignature,
} from "./utilities.js";
import { analyzeCallable, extractDataFlow, traverseAst } from "./callable-analysis.js";

// ───────────────────────────────────────────────────────────────────────────────
// §4.3a — Object Literal Methods
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Extrae funciones definidas dentro de un ObjectLiteralExpression como nodos propios.
 *
 * Cubre dos formas equivalentes en TypeScript:
 *
 *   // Forma 1: propiedad con arrow function
 *   const obj = { save: (entity: Entity) => repo.save(entity) }
 *
 *   // Forma 2: método shorthand
 *   const obj = { save(entity: Entity) { return repo.save(entity); } }
 */
function extractObjectLiteralMethods(
  objLiteral: ObjectLiteralExpression,
  parentId: string,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const prop of objLiteral.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const propName = prop.getName();
      const init = prop.getInitializer();
      if (!init) continue;

      const propId = `${parentId}.${propName}`;

      if (Node.isArrowFunction(init)) {
        cb.insertNode({
          id: propId,
          kind: "ARROW_FUNCTION",
          name: propName,
          filepath: filePath,
          signature: buildArrowSignature(propName, init),
          isDeprecated: 0,
        });
        extractDataFlow(init, propId, cb);
        traverseAst(init, propId, cb);
      } else if (Node.isObjectLiteralExpression(init)) {
        cb.insertNode({
          id: propId,
          kind: "VARIABLE",
          name: propName,
          filepath: filePath,
          signature: `${propName}: { ... }`,
          isDeprecated: 0,
        });
        extractObjectLiteralMethods(init, propId, filePath, cb);
      }
    } else if (Node.isMethodDeclaration(prop)) {
      const methodName = prop.getName();
      const methodId = `${parentId}.${methodName}`;
      cb.insertNode({
        id: methodId,
        kind: "METHOD",
        name: methodName,
        filepath: filePath,
        signature: getMethodSignature(prop),
        isDeprecated: isDeprecated(prop.getSymbol()),
      });
      analyzeCallable(prop, methodId, cb);
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// §4.3b — Variable Declarations
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Extrae variables exportadas del módulo que contienen lógica de dominio.
 *
 * Solo se procesan declaraciones exportadas (las no-exportadas son internas).
 */
export function extractVariableDeclarations(
  sourceFile: SourceFile,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const varStmt = varDecl.getVariableStatement();
    if (!varStmt?.isExported()) continue;

    const varName = varDecl.getName();
    const initializer = varDecl.getInitializer();
    if (!initializer) continue;

    const nodeId = `${filePath}#${varName}`;

    if (Node.isArrowFunction(initializer)) {
      // export const calculateTaxes = (order: IOrder) => { ... }
      cb.insertNode({
        id: nodeId,
        kind: "ARROW_FUNCTION",
        name: varName,
        filepath: filePath,
        signature: buildArrowSignature(varName, initializer),
        isDeprecated: isDeprecated(varDecl.getSymbol()),
      });
      extractDataFlow(initializer, nodeId, cb);
      traverseAst(initializer, nodeId, cb);
    } else if (Node.isObjectLiteralExpression(initializer)) {
      // export const handlers = { create: (...) => {}, ... }
      cb.insertNode({
        id: nodeId,
        kind: "VARIABLE",
        name: varName,
        filepath: filePath,
        signature: `const ${varName} = { ... }`,
        isDeprecated: isDeprecated(varDecl.getSymbol()),
      });
      extractObjectLiteralMethods(initializer, nodeId, filePath, cb);
    }
  }
}
