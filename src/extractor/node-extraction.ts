/**
 * Extracción de nodos de alto nivel (§1 del CodeExtractor original).
 *
 * Entrada: un SourceFile de ts-morph.
 * Salida: nodos persistidos para interfaces, types, enums, funciones, clases, y variables.
 */

import { Node, type SourceFile, type Node as MorphNode } from "ts-morph";
import { type ExtractionCallbacks } from "./types.js";
import {
  buildInterfaceSignature,
  buildClassSignature,
  getFunctionSignature,
  isDeprecated,
  resolveSymbolToId,
  resolveTypeToId,
  safeGetText,
} from "./utilities.js";
import { unwrapReactWrapper } from "./react-predicates.js";

import {
  extractSysRelations,
  extractConstructorInjections,
  extractClassProperties,
  extractClassAccessors,
  extractClassMethods,
} from "./class-extraction.js";
import { analyzeCallable } from "./callable-analysis.js";
import { extractVariableDeclarations } from "./variable-extraction.js";

function extractNodeReferences(
  root: MorphNode,
  sourceId: string,
  cb: ExtractionCallbacks,
): void {
  const seen = new Set<string>();
  const visit = (node: MorphNode): void => {
    if (!Node.isIdentifier(node)) return;
    const targetId = resolveSymbolToId(node.getSymbol());
    if (!targetId || targetId === sourceId || seen.has(targetId)) return;
    seen.add(targetId);
    cb.insertEdge(sourceId, targetId, "REFERENCES");
  };
  visit(root);
  root.forEachDescendant(visit);
}

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

    for (const base of iface.getExtends()) {
      const targetId = resolveTypeToId(base.getType());
      if (targetId && targetId !== nodeId) cb.insertEdge(nodeId, targetId, "EXTENDS");
    }
    for (const member of iface.getMembers()) extractNodeReferences(member, nodeId, cb);
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
    const typeNode = typeAlias.getTypeNode();
    if (typeNode) extractNodeReferences(typeNode, nodeId, cb);
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
      const memberId = `${enumId}.${memberName}`;
      cb.insertNode({
        id: memberId,
        kind: "ENUM_MEMBER",
        name: memberName,
        filepath: filePath,
        signature: member.getText(),
        isDeprecated: 0,
      });
      cb.insertEdge(enumId, memberId, "DECLARES");
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
// §1.6 — Export default con wrappers React
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Cubre `export default withStyles(...)(Foo)` / `export default forwardRef(...)`,
 * que hoy no producen nodo alguno (no son declaraciones nombradas). Se emite un
 * nodo `filepath#default` (id estable, sin colisión con el `const Foo` del mismo
 * archivo) enriquecido con las aristas del componente interno o una REFERENCES
 * hacia el componente envuelto.
 */
function extractDefaultExportExpressions(
  sourceFile: SourceFile,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const assignment of sourceFile.getExportAssignments()) {
    if (assignment.isExportEquals()) continue;

    const expression = assignment.getExpression();
    if (!Node.isCallExpression(expression)) continue;

    const wrapper = unwrapReactWrapper(expression);
    if (!wrapper) continue;

    const nodeId = `${filePath}#default`;
    cb.insertNode({
      id: nodeId,
      kind: "VARIABLE",
      name: "default",
      filepath: filePath,
      signature: safeGetText(expression),
      isDeprecated: 0,
    });

    if (wrapper.innerFunction) {
      analyzeCallable(wrapper.innerFunction, nodeId, cb);
    } else if (wrapper.wrappedIdentifier) {
      const targetId = resolveSymbolToId(wrapper.wrappedIdentifier.getSymbol());
      if (targetId && targetId !== nodeId) cb.insertEdge(nodeId, targetId, "REFERENCES");
    }
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
  extractDefaultExportExpressions(sourceFile, filePath, cb);
}
