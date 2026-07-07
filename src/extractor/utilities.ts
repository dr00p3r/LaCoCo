/**
 * Utilidades puras del extractor — sin dependencia de estado de base de datos.
 *
 * Funciones extraídas de CodeExtractor §6–§10:
 *   §6  — resolveTypeToId
 *   §7  — buildInterfaceSignature, buildClassSignature, getFunctionSignature,
 *          getMethodSignature, buildArrowSignature
 *   §8  — isDeprecated
 *   §9  — safeGetText
 *   §10 — extractPackageName, unwrapGenericWrapper
 */

import {
  Node,
  SyntaxKind,
  type Type,
  type ClassDeclaration,
  type FunctionDeclaration,
  type MethodDeclaration,
  type ArrowFunction,
  type Symbol as MorphSymbol,
  type Node as MorphNode,
} from "ts-morph";
import { KNOWN_WRAPPERS } from "./types.js";

// ───────────────────────────────────────────────────────────────────────────────
// §6 — Resolución de tipos
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Convierte un tipo de ts-morph en el ID canónico del nodo correspondiente.
 *
 * El ID es `${filePath}#${symbolName}`, lo que garantiza unicidad global
 * a lo largo de todo el proyecto sin necesidad de UUID ni secuencias DB.
 *
 * Devuelve `null` si el tipo no es resoluble (primitivo, `any`, anónimo,
 * o definido en los archivos `lib.*.d.ts` de TypeScript).
 */
export function resolveTypeToId(type: Type): string | null {
  const symbol = type.getSymbol() ?? type.getAliasSymbol();
  if (!symbol) return null;

  const symbolName = symbol.getName();
  if (symbolName.startsWith("__")) return null;

  const declarations = symbol.getDeclarations();
  if (declarations.length === 0) return null;

  const firstDecl = declarations[0];
  if (!firstDecl) return null;

  const sourceFilePath = firstDecl.getSourceFile().getFilePath();

  if (sourceFilePath.includes("typescript/lib")) return null;
  if (sourceFilePath.includes("node_modules/typescript")) return null;

  return `${sourceFilePath}#${symbol.getName()}`;
}

/** Resuelve aliases de import/export hasta el símbolo declarado originalmente. */
export function resolveAliasedSymbol(symbol: MorphSymbol | undefined): MorphSymbol | undefined {
  let current = symbol;
  const visited = new Set<MorphSymbol>();
  while (current?.isAlias() && !visited.has(current)) {
    visited.add(current);
    const aliased = current.getAliasedSymbol();
    if (!aliased) break;
    current = aliased;
  }
  return current;
}

/**
 * Convierte una declaración extraída en el mismo ID canónico usado por sus
 * extractores de nodo. Devuelve null para declaraciones sin nodo propio.
 */
export function resolveDeclarationToId(declaration: MorphNode): string | null {
  const filePath = declaration.getSourceFile().getFilePath();

  if (Node.isFunctionDeclaration(declaration)) {
    const name = declaration.getName();
    return name ? `${filePath}#${name}` : null;
  }
  if (Node.isClassDeclaration(declaration) || Node.isInterfaceDeclaration(declaration) ||
      Node.isTypeAliasDeclaration(declaration) || Node.isEnumDeclaration(declaration)) {
    const name = declaration.getName();
    return name ? `${filePath}#${name}` : null;
  }
  if (Node.isVariableDeclaration(declaration)) {
    return declaration.getVariableStatement()?.isExported()
      ? `${filePath}#${declaration.getName()}`
      : null;
  }
  if (Node.isMethodDeclaration(declaration)) {
    const owner = declaration.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    const ownerName = owner?.getName();
    if (ownerName) return `${filePath}#${ownerName}.${declaration.getName()}`;

    const variable = declaration.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    return variable?.getVariableStatement()?.isExported()
      ? `${filePath}#${variable.getName()}.${declaration.getName()}`
      : null;
  }
  if (Node.isPropertyDeclaration(declaration)) {
    const owner = declaration.getFirstAncestorByKind(SyntaxKind.ClassDeclaration)?.getName();
    return owner ? `${filePath}#${owner}::${declaration.getName()}` : null;
  }
  if (Node.isGetAccessorDeclaration(declaration) || Node.isSetAccessorDeclaration(declaration)) {
    const owner = declaration.getFirstAncestorByKind(SyntaxKind.ClassDeclaration)?.getName();
    const prefix = Node.isGetAccessorDeclaration(declaration) ? "get" : "set";
    return owner ? `${filePath}#${owner}::${prefix}:${declaration.getName()}` : null;
  }
  if (Node.isEnumMember(declaration)) {
    const owner = declaration.getFirstAncestorByKind(SyntaxKind.EnumDeclaration)?.getName();
    return owner ? `${filePath}#${owner}.${declaration.getName()}` : null;
  }
  return null;
}

/** Resuelve un símbolo, incluidos aliases importados, a un nodo canónico. */
export function resolveSymbolToId(symbol: MorphSymbol | undefined): string | null {
  const resolved = resolveAliasedSymbol(symbol);
  if (!resolved) return null;
  for (const declaration of resolved.getDeclarations()) {
    const id = resolveDeclarationToId(declaration);
    if (id) return id;
  }
  return null;
}

// ───────────────────────────────────────────────────────────────────────────────
// §7 — Construcción de firmas
// ───────────────────────────────────────────────────────────────────────────────

/** Extrae la cabecera de una función (parámetros + tipo de retorno). */
export function getFunctionSignature(func: FunctionDeclaration): string {
  try {
    return func.getSignature().getDeclaration().getText();
  } catch {
    return safeGetText(func);
  }
}

/** Extrae la cabecera de un método (parámetros + tipo de retorno). */
export function getMethodSignature(method: MethodDeclaration): string {
  try {
    return method.getSignature().getDeclaration().getText();
  } catch {
    return safeGetText(method);
  }
}

/**
 * Construye la firma de una interfaz extrayendo su cabecera (sin el cuerpo).
 * Usa indexOf para encontrar `{` — no es regex.
 */
export function buildInterfaceSignature(fullText: string): string {
  const openBrace = fullText.indexOf("{");
  if (openBrace === -1) return fullText;
  return fullText.slice(0, openBrace).trimEnd() + " {}";
}

/**
 * Construye la firma de una clase incluyendo:
 *   - Modificadores (`abstract`, `export`)
 *   - Nombre y parámetros genéricos
 *   - Superclase y lista de interfaces
 */
export function buildClassSignature(classDecl: ClassDeclaration): string {
  const modifiers = classDecl
    .getModifiers()
    .map((m) => m.getText())
    .join(" ");

  const name = classDecl.getName() ?? "Anonymous";

  const typeParams = classDecl.getTypeParameters();
  const genericPart =
    typeParams.length > 0
      ? `<${typeParams.map((tp) => tp.getText()).join(", ")}>`
      : "";

  const extendsClause = classDecl.getExtends()?.getText() ?? "";
  const implementsClause = classDecl
    .getImplements()
    .map((i) => i.getText())
    .join(", ");

  const parts: string[] = [];
  if (modifiers) parts.push(modifiers);
  parts.push(`class ${name}${genericPart}`);
  if (extendsClause) parts.push(`extends ${extendsClause}`);
  if (implementsClause) parts.push(`implements ${implementsClause}`);

  return parts.join(" ");
}

/**
 * Construye la firma textual de una arrow function exportada como variable.
 *
 * Ejemplo de salida:
 *   `const calculateTaxes = async (order: IOrder, rate: number): Promise<number> =>`
 */
export function buildArrowSignature(name: string, arrow: ArrowFunction): string {
  const asyncKw = arrow.isAsync() ? "async " : "";
  const params = arrow.getParameters().map((p) => p.getText()).join(", ");
  const retNode = arrow.getReturnTypeNode();
  const retType = retNode ? `: ${retNode.getText()}` : "";
  return `const ${name} = ${asyncKw}(${params})${retType} =>`;
}

// ───────────────────────────────────────────────────────────────────────────────
// §8 — JSDoc helpers
// ───────────────────────────────────────────────────────────────────────────────

/** Comprueba si el símbolo tiene el tag `@deprecated` en su JSDoc. */
export function isDeprecated(symbol: MorphSymbol | undefined): 0 | 1 {
  if (!symbol) return 0;
  const hasDeprecated = symbol
    .getJsDocTags()
    .some((tag) => tag.getName() === "deprecated");
  return hasDeprecated ? 1 : 0;
}

// ───────────────────────────────────────────────────────────────────────────────
// §9 — Helpers de seguridad
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Obtiene el texto de un nodo AST sin lanzar en archivos de declaración
 * (`.d.ts`) donde `getText()` puede fallar por falta de source file.
 */
export function safeGetText(node: MorphNode): string {
  try {
    return node.getText();
  } catch {
    return "";
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// §10 — Utilidades de resolución de rutas
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Extrae el nombre del paquete npm de la ruta absoluta de un archivo
 * ubicado dentro de `node_modules`.
 *
 * Maneja correctamente paquetes de ámbito `@scope/name`:
 *
 * ```
 * .../node_modules/rxjs/dist/index.js           → "rxjs"
 * .../node_modules/@nestjs/common/index.d.ts    → "@nestjs/common"
 * .../node_modules/@types/express/index.d.ts    → "@types/express"
 * ```
 */
export function extractPackageName(filePath: string): string {
  const marker = "node_modules/";
  const idx = filePath.lastIndexOf(marker);
  if (idx === -1) return "unknown";

  const after = filePath.slice(idx + marker.length);

  if (after.startsWith("@")) {
    const slash = after.indexOf("/", after.indexOf("/") + 1);
    return slash === -1 ? after : after.slice(0, slash);
  }

  const firstSlash = after.indexOf("/");
  return firstSlash === -1 ? after : after.slice(0, firstSlash);
}

/**
 * Desempaqueta tipos genéricos wrapper comunes en arquitecturas DDD:
 *   - `Promise<T>`     → `T`
 *   - `Observable<T>`  → `T`
 *   - `Result<T, E>`   → `T`  (solo el primer argumento)
 *
 * Si el tipo no es un wrapper conocido, devuelve el tipo original.
 */
export function unwrapGenericWrapper(type: Type, depth = 0): Type | null {
  if (depth > 5) return null;
  if (!type.isObject()) return type;

  const symbolName = type.getSymbol()?.getName();

  if (symbolName && KNOWN_WRAPPERS.has(symbolName)) {
    const typeArgs = type.getTypeArguments();
    const first = typeArgs[0];
    return first ? unwrapGenericWrapper(first, depth + 1) : null;
  }

  return type;
}
