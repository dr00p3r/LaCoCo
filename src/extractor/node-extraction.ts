/**
 * Extracción de nodos de alto nivel (§1 del CodeExtractor original).
 *
 * Entrada: un SourceFile de ts-morph.
 * Salida: nodos persistidos para interfaces, types, enums, funciones, clases, y variables.
 */

import { type SourceFile } from "ts-morph";
import { type ExtractionCallbacks } from "./types.js";
import {
  buildInterfaceSignature,
  buildClassSignature,
  getFunctionSignature,
  isDeprecated,
} from "./utilities.js";
import {
  extractSysRelations,
  extractConstructorInjections,
  extractClassProperties,
  extractClassAccessors,
  extractClassMethods,
} from "./class-extraction.js";
import { analyzeCallable } from "./callable-analysis.js";
import { extractVariableDeclarations } from "./variable-extraction.js";

// ───────────────────────────────────────────────────────────────────────────────
// §1.1 — Interfaces
// ───────────────────────────────────────────────────────────────────────────────

function extractInterfaces(
  sourceFile: SourceFile,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const iface of sourceFile.getInterfaces()) {
    const nodeId = `${filePath}#${iface.getName()}`;
    const signature = buildInterfaceSignature(iface.getText());

    cb.insertNode({
      id: nodeId,
      kind: "INTERFACE",
      name: iface.getName(),
      filepath: filePath,
      signature,
      isDeprecated: isDeprecated(iface.getSymbol()),
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// §1.2 — Type aliases
// ───────────────────────────────────────────────────────────────────────────────

function extractTypeAliases(
  sourceFile: SourceFile,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const typeAlias of sourceFile.getTypeAliases()) {
    const nodeId = `${filePath}#${typeAlias.getName()}`;

    cb.insertNode({
      id: nodeId,
      kind: "TYPE",
      name: typeAlias.getName(),
      filepath: filePath,
      signature: typeAlias.getText(),
      isDeprecated: isDeprecated(typeAlias.getSymbol()),
    });
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// §1.3 — Enums
// ───────────────────────────────────────────────────────────────────────────────

function extractEnums(
  sourceFile: SourceFile,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const enumDecl of sourceFile.getEnums()) {
    const enumName = enumDecl.getName();
    const enumId = `${filePath}#${enumName}`;

    cb.insertNode({
      id: enumId,
      kind: "ENUM",
      name: enumName,
      filepath: filePath,
      signature: `enum ${enumName}`,
      isDeprecated: isDeprecated(enumDecl.getSymbol()),
    });

    for (const member of enumDecl.getMembers()) {
      const memberName = member.getName();
      cb.insertNode({
        id: `${enumId}.${memberName}`,
        kind: "ENUM_MEMBER",
        name: memberName,
        filepath: filePath,
        signature: member.getText(),
        isDeprecated: 0,
      });
    }
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// §1.4 — Funciones sueltas
// ───────────────────────────────────────────────────────────────────────────────

function extractFunctions(
  sourceFile: SourceFile,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const func of sourceFile.getFunctions()) {
    const funcName = func.getName();
    if (!funcName) continue;

    const nodeId = `${filePath}#${funcName}`;
    const signature = getFunctionSignature(func);

    cb.insertNode({
      id: nodeId,
      kind: "FUNCTION",
      name: funcName,
      filepath: filePath,
      signature,
      isDeprecated: isDeprecated(func.getSymbol()),
    });

    analyzeCallable(func, nodeId, cb);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// §1.5 — Clases
// ───────────────────────────────────────────────────────────────────────────────

function extractClasses(
  sourceFile: SourceFile,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const classDecl of sourceFile.getClasses()) {
    const className = classDecl.getName();
    if (!className) continue;

    const classId = `${filePath}#${className}`;
    const signature = buildClassSignature(classDecl);

    cb.insertNode({
      id: classId,
      kind: "CLASS",
      name: className,
      filepath: filePath,
      signature,
      isDeprecated: isDeprecated(classDecl.getSymbol()),
    });

    extractSysRelations(classDecl, classId, cb);
    extractConstructorInjections(classDecl, classId, cb);
    extractClassProperties(classDecl, classId, filePath, cb);
    extractClassAccessors(classDecl, classId, filePath, cb);
    extractClassMethods(classDecl, classId, filePath, cb);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Punto de entrada principal
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Analiza **un** archivo TypeScript y extrae todos los nodos y aristas
 * detectados, delegando en los extractores especializados.
 *
 * @param sourceFile  SourceFile de ts-morph, ya cargado en el proyecto.
 * @param filePath     Ruta absoluta del archivo.
 * @param cb           Callbacks para persistencia (insertNode, insertEdge).
 */
export function extractNodes(
  sourceFile: SourceFile,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  extractInterfaces(sourceFile, filePath, cb);
  extractTypeAliases(sourceFile, filePath, cb);
  extractEnums(sourceFile, filePath, cb);
  extractFunctions(sourceFile, filePath, cb);
  extractClasses(sourceFile, filePath, cb);
  extractVariableDeclarations(sourceFile, filePath, cb);
}
