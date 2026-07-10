/**
 * Predicados puros de React/JSX — sin dependencia de resolución de IDs ni de BD.
 *
 * Aísla la detección de componentes/hooks y el desempaquetado de wrappers
 * (forwardRef/memo/styled/withStyles) para que tanto el extractor de variables
 * como el resolvedor de símbolos (utilities.ts) compartan EXACTAMENTE el mismo
 * criterio de promoción. Si divergieran, las aristas entrantes a componentes
 * internos se perderían en silencio.
 *
 * CERO expresiones regulares. Solo type-guards de ts-morph.
 */

import {
  Node,
  type SourceFile,
  type VariableDeclaration,
  type CallExpression,
  type ArrowFunction,
  type FunctionExpression,
  type Identifier,
  type Node as MorphNode,
} from "ts-morph";

/** Wrappers de orden superior típicos de React cuyo interior es el componente real. */
const REACT_WRAPPERS = new Set([
  "forwardRef", "memo", "observer",
  "styled", "withStyles", "withStyle", "withTheme", "withRouter", "connect",
]);

export interface ReactWrapperUnwrap {
  /** Función-componente inline dentro del wrapper (p.ej. `forwardRef((p, ref) => …)`). */
  innerFunction: ArrowFunction | FunctionExpression | null;
  /** Componente nombrado envuelto (p.ej. `withStyles(cfg)(Foo)` → `Foo`). */
  wrappedIdentifier: Identifier | null;
}

const jsxCapableCache = new WeakMap<SourceFile, boolean>();

function isJsxLike(node: MorphNode): boolean {
  return Node.isJsxElement(node)
    || Node.isJsxSelfClosingElement(node)
    || Node.isJsxFragment(node);
}

/**
 * Un archivo es JSX-capable si es `.tsx`/`.jsx` o contiene JSX (los repos mui de
 * estos refs son `.js` con JSX). El resultado se cachea por SourceFile.
 */
export function fileIsJsxCapable(sourceFile: SourceFile): boolean {
  const cached = jsxCapableCache.get(sourceFile);
  if (cached !== undefined) return cached;

  const extension = sourceFile.getExtension();
  let result = extension === ".tsx" || extension === ".jsx";
  if (!result) result = sourceFile.getFirstDescendant(isJsxLike) !== undefined;

  jsxCapableCache.set(sourceFile, result);
  return result;
}

function startsWithUppercase(name: string): boolean {
  if (name.length === 0) return false;
  const code = name.charCodeAt(0);
  return code >= 65 && code <= 90;
}

/** Componente (`Foo`) o hook (`useFoo`) por convención de nombre de React. */
export function isComponentOrHookName(name: string | undefined): boolean {
  if (!name) return false;
  if (startsWithUppercase(name)) return true;
  if (name.startsWith("use") && name.length > 3) {
    const code = name.charCodeAt(3);
    return code >= 65 && code <= 90;
  }
  return false;
}

function calleeName(expression: MorphNode): string | null {
  if (Node.isIdentifier(expression)) return expression.getText();
  if (Node.isPropertyAccessExpression(expression)) return expression.getName();
  return null;
}

function unwrapFromArguments(args: readonly MorphNode[]): ReactWrapperUnwrap {
  for (const arg of args) {
    if (Node.isArrowFunction(arg) || Node.isFunctionExpression(arg)) {
      return { innerFunction: arg, wrappedIdentifier: null };
    }
  }
  for (const arg of args) {
    if (Node.isIdentifier(arg)) return { innerFunction: null, wrappedIdentifier: arg };
  }
  return { innerFunction: null, wrappedIdentifier: null };
}

/**
 * Detecta un wrapper de React y devuelve su componente interno.
 *
 * Cubre:
 *   `forwardRef(fn)` · `memo(fn)` · `React.forwardRef(fn)`   → innerFunction
 *   `withStyles(cfg)(Foo)` · `connect(...)(Foo)`             → wrappedIdentifier
 *
 * Devuelve null si el callee no es un wrapper conocido.
 */
export function unwrapReactWrapper(call: CallExpression): ReactWrapperUnwrap | null {
  const callee = call.getExpression();

  const directName = calleeName(callee);
  if (directName && REACT_WRAPPERS.has(directName)) {
    return unwrapFromArguments(call.getArguments());
  }

  // Curried HOC: withStyles(cfg)(Foo) — el callee es a su vez una llamada.
  if (Node.isCallExpression(callee)) {
    const innerName = calleeName(callee.getExpression());
    if (innerName && REACT_WRAPPERS.has(innerName)) {
      return unwrapFromArguments(call.getArguments());
    }
  }

  return null;
}

function initializerReturnsJsx(initializer: MorphNode): boolean {
  if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
    const body = initializer.getBody();
    if (isJsxLike(body)) return true;
    return body.getFirstDescendant(isJsxLike) !== undefined;
  }
  if (Node.isCallExpression(initializer)) {
    const wrapper = unwrapReactWrapper(initializer);
    if (wrapper?.innerFunction) return initializerReturnsJsx(wrapper.innerFunction);
  }
  return false;
}

/**
 * ¿Debe promoverse un `const Name = …` NO exportado a nodo del grafo?
 *
 * Sí cuando el archivo es JSX-capable Y (el nombre es de componente/hook, o el
 * inicializador retorna JSX). En backend `.ts` (no JSX-capable) nunca promueve,
 * de modo que el grafo no se inunda con locales triviales.
 */
export function isPromotableReactLocal(
  varDecl: VariableDeclaration,
  sourceFile: SourceFile,
): boolean {
  if (!fileIsJsxCapable(sourceFile)) return false;
  if (isComponentOrHookName(varDecl.getName())) return true;
  const initializer = varDecl.getInitializer();
  return initializer ? initializerReturnsJsx(initializer) : false;
}
