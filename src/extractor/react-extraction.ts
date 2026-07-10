/**
 * Extracción de relaciones JSX — aristas de composición de componentes React.
 *
 *   <Child/>             → RENDERS         (composición de componentes, dimensión CPG)
 *   <Child prop={ref}/>  → CONSUMES_DATA   (dato pasado al hijo, dimensión DTG)
 *
 * Reutiliza `resolveSymbolToId` para emitir los mismos IDs canónicos que el resto
 * del extractor (maneja aliases de import → resuelve `<Button/>` importado de otro
 * archivo). CERO expresiones regulares. Solo type-guards de ts-morph.
 */

import {
  Node,
  type FunctionDeclaration,
  type MethodDeclaration,
  type ArrowFunction,
  type FunctionExpression,
} from "ts-morph";
import { type ExtractionCallbacks } from "./types.js";
import { resolveSymbolToId } from "./utilities.js";
import { fileIsJsxCapable } from "./react-predicates.js";

type CallableNode =
  | FunctionDeclaration
  | MethodDeclaration
  | ArrowFunction
  | FunctionExpression;

/** Los elementos host intrínsecos (`<div>`, `<span>`) empiezan en minúscula. */
function tagStartsLowercase(tagText: string): boolean {
  if (tagText.length === 0) return false;
  const code = tagText.charCodeAt(0);
  return code >= 97 && code <= 122;
}

/**
 * Emite aristas RENDERS/CONSUMES_DATA por cada elemento JSX renderizado en el
 * cuerpo de la función/método `func`, atribuidas a `sourceId`.
 */
export function extractJsxRelations(
  func: CallableNode,
  sourceId: string,
  cb: ExtractionCallbacks,
): void {
  if (!fileIsJsxCapable(func.getSourceFile())) return;

  func.forEachDescendant((node) => {
    if (!Node.isJsxOpeningElement(node) && !Node.isJsxSelfClosingElement(node)) return;

    const tagNameNode = node.getTagNameNode();
    if (tagStartsLowercase(tagNameNode.getText())) return;

    const tagSymbol = Node.isPropertyAccessExpression(tagNameNode)
      ? tagNameNode.getNameNode().getSymbol()
      : tagNameNode.getSymbol();
    const targetId = resolveSymbolToId(tagSymbol);
    if (targetId && targetId !== sourceId) cb.insertEdge(sourceId, targetId, "RENDERS");

    for (const attribute of node.getAttributes()) {
      if (!Node.isJsxAttribute(attribute)) continue;
      const initializer = attribute.getInitializer();
      if (!initializer || !Node.isJsxExpression(initializer)) continue;
      const expression = initializer.getExpression();
      if (!expression || !Node.isIdentifier(expression)) continue;
      const propTargetId = resolveSymbolToId(expression.getSymbol());
      if (propTargetId && propTargetId !== sourceId) {
        cb.insertEdge(sourceId, propTargetId, "CONSUMES_DATA");
      }
    }
  });
}
