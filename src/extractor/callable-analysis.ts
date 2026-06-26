/**
 * Análisis de callables (funciones y métodos) — DTG + AST traversal.
 *
 * Extraído de CodeExtractor §4.1 (DTG: Data-flow Graph) y §4.2 (recorrido profundo AST).
 *
 * Genera aristas de las tres capas:
 *   - **DTG** → CONSUMES_DATA, PRODUCES
 *   - **CPG** → CALLS, INSTANTIATES
 *   - **SYS** → IMPORTS_EXTERNAL
 */

import {
  Node,
  SyntaxKind,
  type FunctionDeclaration,
  type MethodDeclaration,
  type ArrowFunction,
  type ParameterDeclaration,
  type Type,
  type Symbol as MorphSymbol,
} from "ts-morph";
import {
  type NodeRow,
  type ExtractionCallbacks,
  MUTABLE_METHODS,
} from "./types.js";
import {
  resolveTypeToId,
  extractPackageName,
  safeGetText,
  isDeprecated,
  unwrapGenericWrapper,
} from "./utilities.js";

// ───────────────────────────────────────────────────────────────────────────────
// §4.1 — DTG: Flujo de Datos
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Analiza el flujo de datos de una función/método:
 *   - CONSUMES_DATA desde parámetros
 *   - PRODUCES desde tipo de retorno
 */
export function extractDataFlow(
  func: FunctionDeclaration | MethodDeclaration | ArrowFunction,
  sourceId: string,
  cb: ExtractionCallbacks,
): void {
  for (const param of func.getParameters()) {
    consumesFromParam(param, sourceId, cb);
  }
  producesFromReturnType(func, sourceId, cb);
}

/**
 * Genera arista CONSUMES_DATA si el parámetro tiene un tipo complejo.
 *
 * Maneja los casos:
 *   - `param: MyDto`
 *   - `param: CreateOrderDto & { extra: string }`  (intersección)
 *   - `param: MyDto[]`  (array de tipo concreto)
 */
function consumesFromParam(
  param: ParameterDeclaration,
  sourceId: string,
  cb: ExtractionCallbacks,
): void {
  const type = param.getType();

  if (type.isObject() && !type.isAny()) {
    const targetId = resolveTypeToId(type);
    if (targetId) cb.insertEdge(sourceId, targetId, "CONSUMES_DATA");
    return;
  }

  if (type.isArray()) {
    const elementType = type.getArrayElementType();
    if (elementType) {
      const targetId = resolveTypeToId(elementType);
      if (targetId) cb.insertEdge(sourceId, targetId, "CONSUMES_DATA");
    }
    return;
  }

  if (type.isIntersection()) {
    for (const member of type.getIntersectionTypes()) {
      const targetId = resolveTypeToId(member);
      if (targetId) cb.insertEdge(sourceId, targetId, "CONSUMES_DATA");
    }
    return;
  }

  if (type.isUnion()) {
    for (const member of type.getUnionTypes()) {
      if (!member.isNull() && !member.isUndefined()) {
        const targetId = resolveTypeToId(member);
        if (targetId) cb.insertEdge(sourceId, targetId, "CONSUMES_DATA");
      }
    }
  }
}

/**
 * Genera arista PRODUCES hacia el tipo de retorno de una función.
 *
 * Desempaqueta `Promise<T>` y otros wrappers como `Observable<T>` o `Result<T, E>`.
 */
function producesFromReturnType(
  func: FunctionDeclaration | MethodDeclaration | ArrowFunction,
  sourceId: string,
  cb: ExtractionCallbacks,
): void {
  const returnType = func.getReturnType();

  if (returnType.isVoid() || returnType.isNever() || returnType.isAny()) {
    return;
  }

  const unwrapped = unwrapGenericWrapper(returnType);
  if (!unwrapped) return;

  const targetId = resolveTypeToId(unwrapped);
  if (targetId) cb.insertEdge(sourceId, targetId, "PRODUCES");
}

// ───────────────────────────────────────────────────────────────────────────────
// §4.2 — Recorrido profundo del AST
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Recorre todos los descendientes del nodo AST de la función y detecta:
 *
 *   - `CallExpression`   → CALLS | IMPORTS_EXTERNAL | MUTATES_STATE
 *   - `NewExpression`    → INSTANTIATES
 *   - `BinaryExpression` → MUTATES_STATE (si es asignación a propiedad)
 *   - `ArrowFunction`    → análisis recursivo de closures inline
 */
export function traverseAst(
  func: FunctionDeclaration | MethodDeclaration | ArrowFunction,
  sourceId: string,
  cb: ExtractionCallbacks,
): void {
  func.forEachDescendant((node) => {
    if (Node.isCallExpression(node)) {
      const calleeExpr = node.getExpression();

      // DTG: MUTATES_STATE — métodos mutables sobre propiedades de objetos
      if (Node.isPropertyAccessExpression(calleeExpr)) {
        const methodName = calleeExpr.getName();
        if (MUTABLE_METHODS.has(methodName)) {
          const receiver = calleeExpr.getExpression();
          const receiverType = receiver.getType();
          const targetId = resolveTypeToId(receiverType);
          if (targetId) cb.insertEdge(sourceId, targetId, "MUTATES_STATE");
        }
      }

      // CPG/SYS: CALLS | IMPORTS_EXTERNAL
      handleCallExpression(calleeExpr.getSymbol(), calleeExpr.getType(), sourceId, cb);
      return;
    }

    if (Node.isNewExpression(node)) {
      const targetId = resolveTypeToId(node.getType());
      if (targetId) cb.insertEdge(sourceId, targetId, "INSTANTIATES");
      return;
    }

    if (Node.isBinaryExpression(node)) {
      if (node.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return;

      const left = node.getLeft();
      if (!Node.isPropertyAccessExpression(left)) return;

      const receiverType = left.getExpression().getType();
      const targetId = resolveTypeToId(receiverType);
      if (targetId) cb.insertEdge(sourceId, targetId, "MUTATES_STATE");
      return;
    }

    if (Node.isArrowFunction(node)) {
      analyzeArrowFunction(node, sourceId, cb);
    }
  });
}

function isTargetableNode(declaration: Node): boolean {
  if (Node.isImportSpecifier(declaration) || Node.isExportSpecifier(declaration))
    return false;
  if (Node.isVariableDeclaration(declaration))
    return declaration.getVariableStatement()?.isExported() ?? false;
  const exportable = declaration as { isExported?: () => boolean };
  return exportable.isExported?.() ?? false;
}

/**
 * Analiza una llamada a función para determinar si es interna (CALLS)
 * o externa de node_modules (IMPORTS_EXTERNAL).
 */
function handleCallExpression(
  symbol: MorphSymbol | undefined,
  calleeType: Type,
  sourceId: string,
  cb: ExtractionCallbacks,
): void {
  if (!symbol) return;

  const declarations = symbol.getDeclarations();
  if (declarations.length === 0) return;

  const firstDecl = declarations[0];
  if (!firstDecl) return;

  const declFilePath = firstDecl.getSourceFile().getFilePath();

  if (declFilePath.includes("node_modules")) {
    const pkgName = extractPackageName(declFilePath);
    const libId = `lib#${pkgName}#${symbol.getName()}`;
    cb.insertNode({
      id: libId,
      kind: "EXTERNAL_LIB",
      name: `${pkgName}::${symbol.getName()}`,
      filepath: declFilePath,
      signature: safeGetText(firstDecl),
      isDeprecated: isDeprecated(symbol),
    });

    cb.insertEdge(sourceId, libId, "IMPORTS_EXTERNAL");
  } else {
    const symbolName = symbol.getName();
    if (symbolName && !symbolName.startsWith("__") && isTargetableNode(firstDecl)) {
      cb.insertEdge(sourceId, `${declFilePath}#${symbolName}`, "CALLS");
    }
  }
}

/**
 * Analiza el cuerpo de una arrow function inline buscando las mismas aristas
 * CPG/SYS/DTG que en una función normal, usando el `sourceId` del callable padre.
 */
function analyzeArrowFunction(
  arrow: ArrowFunction,
  parentSourceId: string,
  cb: ExtractionCallbacks,
): void {
  // Reutiliza consumeFromParam que genera CONSUMES_DATA
  for (const param of arrow.getParameters()) {
    // Inlineamos la lógica de consumeFromParam para evitar una dependencia circular
    // (consumeFromParam es file-private; la exportamos como parte de extractDataFlow)
    consumesFromParam(param, parentSourceId, cb);
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// Punto de entrada principal
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Analiza el cuerpo de una función o método y genera:
 *
 *   - **DTG** → CONSUMES_DATA, PRODUCES
 *   - **CPG** → CALLS, INSTANTIATES
 *   - **SYS** → IMPORTS_EXTERNAL
 */
export function analyzeCallable(
  func: FunctionDeclaration | MethodDeclaration | ArrowFunction,
  sourceId: string,
  cb: ExtractionCallbacks,
): void {
  extractDataFlow(func, sourceId, cb);
  traverseAst(func, sourceId, cb);
}
