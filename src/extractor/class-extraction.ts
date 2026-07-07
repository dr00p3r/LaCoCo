/**
 * Extracción de detalles de clases (§2 SYS + §3 CPG del CodeExtractor original).
 *
 *  §2 SYS: EXTENDS, IMPLEMENTS
 *  §3 CPG: INJECTS, propiedades, accessors, métodos
 */

import { Node, type ClassDeclaration } from "ts-morph";
import { type ExtractionCallbacks } from "./types.js";
import {
  resolveTypeToId,
  isDeprecated,
  getMethodSignature,
} from "./utilities.js";
import { analyzeCallable } from "./callable-analysis.js";

// ───────────────────────────────────────────────────────────────────────────────
// §2 SYS — EXTENDS e IMPLEMENTS
// ───────────────────────────────────────────────────────────────────────────────

/**
 * Genera aristas EXTENDS e IMPLEMENTS para una clase.
 *
 * En DDD es frecuente: `class OrderService extends BaseService<Order>`
 * con múltiples interfaces implementadas (ICommandHandler, IDisposable, etc.)
 */
export function extractSysRelations(
  classDecl: ClassDeclaration,
  classId: string,
  cb: ExtractionCallbacks,
): void {
  const baseClass = classDecl.getBaseClass();
  if (baseClass) {
    const targetId = resolveTypeToId(baseClass.getType());
    if (targetId) cb.insertEdge(classId, targetId, "EXTENDS");
  }

  for (const impl of classDecl.getImplements()) {
    const targetId = resolveTypeToId(impl.getType());
    if (targetId) cb.insertEdge(classId, targetId, "IMPLEMENTS");
  }
}

// ───────────────────────────────────────────────────────────────────────────────
// §3 CPG — Control & Program Graph
// ───────────────────────────────────────────────────────────────────────────────

/**
 * §3.1 — INJECTS.
 *
 * Recorre los parámetros del constructor para detectar inyección de
 * dependencias. En NestJS/DDD, los parámetros del constructor suelen
 * ser repositorios, servicios o tokens de inyección.
 */
export function extractConstructorInjections(
  classDecl: ClassDeclaration,
  classId: string,
  cb: ExtractionCallbacks,
): void {
  for (const ctor of classDecl.getConstructors()) {
    for (const param of ctor.getParameters()) {
      const type = param.getType();

      if (!type.isObject()) {
        continue;
      }
      if (type.isAny() || type.isUnknown()) continue;

      const targetId = resolveTypeToId(type);
      if (targetId) cb.insertEdge(classId, targetId, "INJECTS");
    }
  }
}

/**
 * §3.2 — Propiedades de clase.
 *
 * En DDD, las propiedades privadas mapeadas a columnas o las propiedades
 * de value objects son nodos relevantes para entender el estado de un agregado.
 */
export function extractClassProperties(
  classDecl: ClassDeclaration,
  classId: string,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const prop of classDecl.getProperties()) {
    const propName = prop.getName();
    const propId = `${classId}::${propName}`;

    cb.insertNode({
      id: propId,
      kind: "PROPERTY",
      name: propName,
      filepath: filePath,
      signature: prop.getText(),
      isDeprecated: isDeprecated(prop.getSymbol()),
    });
    cb.insertEdge(classId, propId, "DECLARES");
  }
}

/**
 * §3.3 — Accessors (get/set).
 *
 * En proyectos DDD clean es común encapsular el estado mediante getters
 * sin setters públicos (p.ej. `get orderId(): OrderId`).
 */
export function extractClassAccessors(
  classDecl: ClassDeclaration,
  classId: string,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const accessor of [
    ...classDecl.getGetAccessors(),
    ...classDecl.getSetAccessors(),
  ]) {
    const prefix = Node.isGetAccessorDeclaration(accessor) ? "get" : "set";
    const accessorId = `${classId}::${prefix}:${accessor.getName()}`;

    cb.insertNode({
      id: accessorId,
      kind: "ACCESSOR",
      name: `${prefix} ${accessor.getName()}`,
      filepath: filePath,
      signature: accessor.getText().split("{")[0]?.trimEnd() ?? "",
      isDeprecated: isDeprecated(accessor.getSymbol()),
    });
    cb.insertEdge(classId, accessorId, "DECLARES");
  }
}

/**
 * §3.4 — Métodos de clase.
 *
 * Cada método se trata como un callable independiente que puede tener
 * sus propias dependencias de entrada (DTG) y llamadas (CPG/SYS).
 *
 * Excluye firmas puras de sobrecarga (solo conserva la implementación).
 */
export function extractClassMethods(
  classDecl: ClassDeclaration,
  classId: string,
  filePath: string,
  cb: ExtractionCallbacks,
): void {
  for (const method of classDecl.getMethods()) {
    if (!method.isImplementation()) continue;

    const methodId = `${classId}.${method.getName()}`;
    const signature = getMethodSignature(method);

    cb.insertNode({
      id: methodId,
      kind: "METHOD",
      name: method.getName(),
      filepath: filePath,
      signature,
      isDeprecated: isDeprecated(method.getSymbol()),
    });
    cb.insertEdge(classId, methodId, "DECLARES");

    analyzeCallable(method, methodId, cb);
  }
}
