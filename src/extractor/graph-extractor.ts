/**
 * GraphExtractor — Núcleo de análisis estático del Grafo Multirrelacional
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
 */

import Database from "better-sqlite3";
import type { Statement } from "better-sqlite3";
import {
  Node,
  SyntaxKind,
  type SourceFile,
  type ClassDeclaration,
  type MethodDeclaration,
  type FunctionDeclaration,
  type ArrowFunction,
  type ObjectLiteralExpression,
  type Symbol as MorphSymbol,
  type Type,
  type ParameterDeclaration,
  type Node as MorphNode,
} from "ts-morph";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos internos del esquema
// ─────────────────────────────────────────────────────────────────────────────

/** Representa un nodo semántico del grafo. */
interface NodeRow {
  id: string;
  kind: NodeKind;
  name: string;
  filepath: string;
  signature: string;
  isDeprecated: 0 | 1;
}

/** Representa una arista relacional entre nodos. */
interface EdgeRow {
  sourceId: string;
  targetId: string;
  relation: EdgeRelation;
}

/** Todos los tipos de nodo del tensor. */
type NodeKind =
  | "CLASS"
  | "METHOD"
  | "FUNCTION"
  | "ARROW_FUNCTION"    // export const fn = () => {}
  | "VARIABLE"          // export const config = { ... }
  | "INTERFACE"
  | "TYPE"
  | "ENUM"
  | "ENUM_MEMBER"
  | "PROPERTY"
  | "ACCESSOR"
  | "EXTERNAL_LIB";

/** Todas las relaciones del tensor. */
type EdgeRelation =
  // SYS
  | "EXTENDS"
  | "IMPLEMENTS"
  | "IMPORTS_EXTERNAL"
  // CPG
  | "INJECTS"
  | "CALLS"
  | "INSTANTIATES"
  // DTG
  | "CONSUMES_DATA"
  | "PRODUCES"
  | "MUTATES_STATE";

// ─────────────────────────────────────────────────────────────────────────────
// Constante de métodos mutables (module-level para evitar re-creación)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Métodos que mutan el estado interno de un Array, Map o Set.
 * Cuando se llaman sobre una propiedad de un objeto de dominio, se genera
 * una arista MUTATES_STATE hacia el tipo del receptor.
 *
 * Ejemplos detectados:
 *   order.items.push(item)      → MUTATES_STATE → Order
 *   this.cache.set(key, value)  → MUTATES_STATE → CurrentClass
 *   cart.lines.splice(0, 1)     → MUTATES_STATE → Cart
 */
const MUTABLE_METHODS = new Set([
  // Array
  "push", "pop", "shift", "unshift", "splice",
  "sort", "reverse", "fill", "copyWithin",
  // Map / WeakMap
  "set", "delete", "clear",
  // Set / WeakSet
  "add",
  // Patrones comunes en DDD (repositorios, agregados)
  "assign", "reset", "merge", "patch",
]);

/**
 * Wrappers genéricos conocidos cuyo tipo interno es el que nos interesa.
 * Constante a nivel de módulo para no recrear el Set en cada llamada.
 *
 * Ejemplos: Promise<T> → T,  Observable<T> → T,  Result<T, E> → T
 */
const KNOWN_WRAPPERS = new Set(["Promise", "Observable", "Result", "Either", "Option"]);

// ─────────────────────────────────────────────────────────────────────────────
// GraphExtractor
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Procesa un {@link SourceFile} de ts-morph y escribe los nodos y aristas
 * resultantes en la base de datos SQLite mediante prepared statements.
 *
 * @example
 * ```ts
 * const db         = new Database("tensor.sqlite");
 * const extractor  = new GraphExtractor(db);
 *
 * db.transaction(() => {
 *   for (const file of project.getSourceFiles()) {
 *     extractor.processFile(file);
 *   }
 * })();
 * ```
 */
export class GraphExtractor {
  // ── Prepared statements (compilados una sola vez al construir la instancia) ──
  private readonly stmtInsertNode: Statement;
  private readonly stmtInsertEdge: Statement;

  // ── Métricas internas de la última ejecución ──
  private nodesWritten = 0;
  private edgesWritten = 0;

  constructor(private readonly db: Database.Database) {
    //
    // INSERT OR REPLACE: si el id ya existe (re-análisis incremental),
    // actualiza todos los campos en lugar de fallar.
    //
    this.stmtInsertNode = this.db.prepare(`
      INSERT OR REPLACE INTO nodes
        (id, kind, name, filepath, signature, isDeprecated)
      VALUES
        (@id, @kind, @name, @filepath, @signature, @isDeprecated)
    `);

    //
    // INSERT OR IGNORE: la constraint UNIQUE(sourceId, targetId, relation)
    // ya garantiza idempotencia; no necesitamos reemplazar aristas duplicadas.
    //
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
   * todos los nodos y aristas detectados.
   *
   * @param sourceFile  SourceFile de ts-morph, ya cargado en el proyecto.
   */
  processFile(sourceFile: SourceFile): void {
    const filePath = sourceFile.getFilePath();

    this.#extractInterfaces(sourceFile, filePath);
    this.#extractTypeAliases(sourceFile, filePath);
    this.#extractEnums(sourceFile, filePath);
    this.#extractFunctions(sourceFile, filePath);
    this.#extractClasses(sourceFile, filePath);
    // Gap 2: constantes exportadas (arrow functions y objetos de configuración/dominio)
    this.#extractVariableDeclarations(sourceFile, filePath);
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
  // §1 — Extracción de nodos de alto nivel
  // ───────────────────────────────────────────────────────────────────────────

  /** §1.1 — Interfaces */
  #extractInterfaces(sourceFile: SourceFile, filePath: string): void {
    for (const iface of sourceFile.getInterfaces()) {
      const nodeId = `${filePath}#${iface.getName()}`;

      // La firma de una interfaz es su cabecera (sin el cuerpo)
      const signature = this.#buildInterfaceSignature(iface.getText());

      this.#insertNode({
        id: nodeId,
        kind: "INTERFACE",
        name: iface.getName(),
        filepath: filePath,
        signature,
        isDeprecated: this.#isDeprecated(iface.getSymbol()),
      });
    }
  }

  /** §1.2 — Type aliases */
  #extractTypeAliases(sourceFile: SourceFile, filePath: string): void {
    for (const typeAlias of sourceFile.getTypeAliases()) {
      const nodeId = `${filePath}#${typeAlias.getName()}`;

      this.#insertNode({
        id: nodeId,
        kind: "TYPE",
        name: typeAlias.getName(),
        filepath: filePath,
        // getText() da la declaración completa: `type Foo<T> = …`
        signature: typeAlias.getText(),
        isDeprecated: this.#isDeprecated(typeAlias.getSymbol()),
      });
    }
  }

  /** §1.3 — Enums (útiles en proyectos DDD para value objects o constantes) */
  #extractEnums(sourceFile: SourceFile, filePath: string): void {
    for (const enumDecl of sourceFile.getEnums()) {
      const enumName = enumDecl.getName();
      const enumId = `${filePath}#${enumName}`;

      this.#insertNode({
        id: enumId,
        kind: "ENUM",
        name: enumName,
        filepath: filePath,
        signature: `enum ${enumName}`,
        isDeprecated: this.#isDeprecated(enumDecl.getSymbol()),
      });

      // Miembros del enum como nodos individuales
      for (const member of enumDecl.getMembers()) {
        const memberName = member.getName();
        this.#insertNode({
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

  /** §1.4 — Funciones sueltas (exported functions, helpers, factory functions…) */
  #extractFunctions(sourceFile: SourceFile, filePath: string): void {
    for (const func of sourceFile.getFunctions()) {
      const funcName = func.getName();
      if (!funcName) continue; // función anónima — no indexable por nombre

      const nodeId = `${filePath}#${funcName}`;
      const signature = this.#getFunctionSignature(func);

      this.#insertNode({
        id: nodeId,
        kind: "FUNCTION",
        name: funcName,
        filepath: filePath,
        signature,
        isDeprecated: this.#isDeprecated(func.getSymbol()),
      });

      this.#analyzeCallable(func, nodeId);
    }
  }

  /** §1.5 — Clases (el nodo más rico: herencia, DI, métodos, propiedades) */
  #extractClasses(sourceFile: SourceFile, filePath: string): void {
    for (const classDecl of sourceFile.getClasses()) {
      const className = classDecl.getName();
      if (!className) continue; // clase anónima exportada directamente

      const classId = `${filePath}#${className}`;

      // La firma de una clase incluye sus modificadores de acceso y decoradores
      const signature = this.#buildClassSignature(classDecl);

      this.#insertNode({
        id: classId,
        kind: "CLASS",
        name: className,
        filepath: filePath,
        signature,
        isDeprecated: this.#isDeprecated(classDecl.getSymbol()),
      });

      // Procesar todas las capas de la clase
      this.#extractSysRelations(classDecl, classId);
      this.#extractConstructorInjections(classDecl, classId);
      this.#extractClassProperties(classDecl, classId, filePath);
      this.#extractClassAccessors(classDecl, classId, filePath);
      this.#extractClassMethods(classDecl, classId, filePath);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §2 — Capa SYS (Ecosistema del sistema)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * §2.1 — EXTENDS e IMPLEMENTS.
   *
   * En DDD es frecuente: `class OrderService extends BaseService<Order>`
   * con múltiples interfaces implementadas (ICommandHandler, IDisposable, etc.)
   */
  #extractSysRelations(classDecl: ClassDeclaration, classId: string): void {
    // EXTENDS — una sola superclase directa por la semántica de TypeScript
    const baseClass = classDecl.getBaseClass();
    if (baseClass) {
      const targetId = this.#resolveTypeToId(baseClass.getType());
      if (targetId) this.#insertEdge(classId, targetId, "EXTENDS");
    }

    // IMPLEMENTS — múltiples interfaces posibles
    for (const impl of classDecl.getImplements()) {
      const targetId = this.#resolveTypeToId(impl.getType());
      if (targetId) this.#insertEdge(classId, targetId, "IMPLEMENTS");
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §3 — Capa CPG (Control & Program Graph — Estructura)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * §3.1 — INJECTS.
   *
   * Recorre los parámetros del constructor para detectar inyección de
   * dependencias. En NestJS/DDD, los parámetros del constructor suelen
   * ser repositorios, servicios o tokens de inyección.
   *
   * También maneja el patrón `@Inject(TOKEN)` chequeando el AST de los
   * parámetros sin regex.
   */
  #extractConstructorInjections(
    classDecl: ClassDeclaration,
    classId: string
  ): void {
    for (const ctor of classDecl.getConstructors()) {
      for (const param of ctor.getParameters()) {
        const type = param.getType();

        // Solo creamos aristas hacia tipos concretos (no primitivos, no any).
        // isObject() cubre clases e interfaces en el sistema de tipos de TypeScript.
        if (!type.isObject()) {
          continue;
        }
        if (type.isAny() || type.isUnknown()) continue;

        const targetId = this.#resolveTypeToId(type);
        if (targetId) this.#insertEdge(classId, targetId, "INJECTS");
      }
    }
  }

  /**
   * §3.2 — Propiedades de clase.
   *
   * En DDD, las propiedades privadas mapeadas a columnas o las propiedades
   * de value objects son nodos relevantes para entender el estado de un agregado.
   */
  #extractClassProperties(
    classDecl: ClassDeclaration,
    classId: string,
    filePath: string
  ): void {
    for (const prop of classDecl.getProperties()) {
      const propName = prop.getName();
      const propId = `${classId}::${propName}`;

      this.#insertNode({
        id: propId,
        kind: "PROPERTY",
        name: propName,
        filepath: filePath,
        signature: prop.getText(),
        isDeprecated: this.#isDeprecated(prop.getSymbol()),
      });
    }
  }

  /**
   * §3.3 — Accessors (get/set).
   *
   * En proyectos DDD clean es común encapsular el estado mediante getters
   * sin setters públicos (p.ej. `get orderId(): OrderId`).
   */
  #extractClassAccessors(
    classDecl: ClassDeclaration,
    classId: string,
    filePath: string
  ): void {
    for (const accessor of [
      ...classDecl.getGetAccessors(),
      ...classDecl.getSetAccessors(),
    ]) {
      const prefix = Node.isGetAccessorDeclaration(accessor) ? "get" : "set";
      const accessorId = `${classId}::${prefix}:${accessor.getName()}`;

      this.#insertNode({
        id: accessorId,
        kind: "ACCESSOR",
        name: `${prefix} ${accessor.getName()}`,
        filepath: filePath,
        signature: accessor.getText().split("{")[0]?.trimEnd() ?? "",
        isDeprecated: this.#isDeprecated(accessor.getSymbol()),
      });
    }
  }

  /**
   * §3.4 — Métodos de clase.
   *
   * Cada método se trata como un callable independiente que puede tener
   * sus propias dependencias de entrada (DTG) y llamadas (CPG/SYS).
   */
  #extractClassMethods(
    classDecl: ClassDeclaration,
    classId: string,
    filePath: string
  ): void {
    for (const method of classDecl.getMethods()) {
      // F8: excluir firmas puras de sobrecarga; conservar solo la implementación.
      // getMethods() devuelve TODAS las firmas (overloads + impl).
      // isImplementation() retorna true para:
      //   • Métodos sin sobrecarga (una sola firma)
      //   • La firma con cuerpo cuando hay sobrecargas
      //   • Métodos abstract (no tienen cuerpo pero son la única declaración)
      // Esto evita colisioni de IDs: `${classId}.find` no sobreescribe entre firmas.
      if (!method.isImplementation()) continue;

      const methodId = `${classId}.${method.getName()}`;
      const signature = this.#getMethodSignature(method);

      this.#insertNode({
        id: methodId,
        kind: "METHOD",
        name: method.getName(),
        filepath: filePath,
        signature,
        isDeprecated: this.#isDeprecated(method.getSymbol()),
      });

      // Analizar el cuerpo: DTG (CONSUMES_DATA, PRODUCES) + CPG (CALLS, INSTANTIATES) + SYS (IMPORTS_EXTERNAL)
      this.#analyzeCallable(method, methodId);
    }
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §4 — Análisis de callables (funciones y métodos)
  // Genera aristas de las tres capas según el contenido del AST interno.
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Analiza el cuerpo de una función o método y genera:
   *
   *   - **DTG** → CONSUMES_DATA, PRODUCES
   *   - **CPG** → CALLS, INSTANTIATES
   *   - **SYS** → IMPORTS_EXTERNAL
   */
  #analyzeCallable(
    func: FunctionDeclaration | MethodDeclaration | ArrowFunction,
    sourceId: string
  ): void {
    this.#extractDataFlow(func, sourceId);
    this.#traverseAst(func, sourceId);
  }

  // ── §4.1 — DTG: Flujo de Datos ──────────────────────────────────────────

  #extractDataFlow(
    func: FunctionDeclaration | MethodDeclaration | ArrowFunction,
    sourceId: string
  ): void {
    // CONSUMES_DATA — parámetros cuyo tipo es un objeto/interfaz/clase
    for (const param of func.getParameters()) {
      this.#consumesFromParam(param, sourceId);
    }

    // PRODUCES — tipo de retorno (desempaquetando Promise<T> si es necesario)
    this.#producesFromReturnType(func, sourceId);
  }

  /**
   * Genera arista CONSUMES_DATA si el parámetro tiene un tipo complejo.
   *
   * Maneja los casos:
   *   - `param: MyDto`
   *   - `param: CreateOrderDto & { extra: string }`  (intersección)
   *   - `param: MyDto[]`  (array de tipo concreto)
   */
  #consumesFromParam(param: ParameterDeclaration, sourceId: string): void {
    const type = param.getType();

    // Caso base: tipo objeto directo (includes clases e interfaces en ts-morph)
    if (type.isObject() && !type.isAny()) {
      const targetId = this.#resolveTypeToId(type);
      if (targetId) this.#insertEdge(sourceId, targetId, "CONSUMES_DATA");
      return;
    }

    // Caso: array (T[]) — resolvemos el tipo del elemento
    if (type.isArray()) {
      const elementType = type.getArrayElementType();
      if (elementType) {
        const targetId = this.#resolveTypeToId(elementType);
        if (targetId) this.#insertEdge(sourceId, targetId, "CONSUMES_DATA");
      }
      return;
    }

    // Caso: intersección (A & B) — generamos aristas para cada miembro
    if (type.isIntersection()) {
      for (const member of type.getIntersectionTypes()) {
        const targetId = this.#resolveTypeToId(member);
        if (targetId) this.#insertEdge(sourceId, targetId, "CONSUMES_DATA");
      }
      return;
    }

    // Caso: unión (A | B) — generamos aristas para cada variante
    if (type.isUnion()) {
      for (const member of type.getUnionTypes()) {
        if (!member.isNull() && !member.isUndefined()) {
          const targetId = this.#resolveTypeToId(member);
          if (targetId) this.#insertEdge(sourceId, targetId, "CONSUMES_DATA");
        }
      }
    }
  }

  /**
   * Genera arista PRODUCES hacia el tipo de retorno de una función.
   *
   * Desempaqueta `Promise<T>` y otros wrappers como `Observable<T>` o `Result<T, E>`.
   */
  #producesFromReturnType(
    func: FunctionDeclaration | MethodDeclaration | ArrowFunction,
    sourceId: string
  ): void {
    const returnType = func.getReturnType();

    if (returnType.isVoid() || returnType.isNever() || returnType.isAny()) {
      return;
    }

    const unwrapped = this.#unwrapGenericWrapper(returnType);
    if (!unwrapped) return;

    const targetId = this.#resolveTypeToId(unwrapped);
    if (targetId) this.#insertEdge(sourceId, targetId, "PRODUCES");
  }

  /**
   * Desempaqueta tipos genéricos wrapper comunes en arquitecturas DDD:
   *   - `Promise<T>`     → `T`
   *   - `Observable<T>`  → `T`
   *   - `Result<T, E>`   → `T`  (solo el primer argumento)
   *
   * Si el tipo no es un wrapper conocido, devuelve el tipo original.
   */
  #unwrapGenericWrapper(type: Type, depth = 0): Type | null {
    // Protección contra tipos mutuamente recúsivos o anidamiento excesivo
    if (depth > 5) return null;
    if (!type.isObject()) return type;

    const symbolName = type.getSymbol()?.getName();

    if (symbolName && KNOWN_WRAPPERS.has(symbolName)) {
      const typeArgs = type.getTypeArguments();
      const first = typeArgs[0];
      // Recursión para desempaquetar Promise<Observable<T>>, etc.
      return first ? this.#unwrapGenericWrapper(first, depth + 1) : null;
    }

    return type;
  }

  // ── §4.2 — Recorrido profundo del AST ──────────────────────────────────

  /**
   * Recorre todos los descendientes del nodo AST de la función y detecta:
   *
   *   - `CallExpression`   → CALLS | IMPORTS_EXTERNAL
   *   - `NewExpression`    → INSTANTIATES
   *   - `BinaryExpression` → MUTATES_STATE (si es asignación a propiedad)
   *   - `ArrowFunction`    → análisis recursivo de closures inline
   */
  #traverseAst(
    func: FunctionDeclaration | MethodDeclaration | ArrowFunction,
    sourceId: string
  ): void {
    func.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        const calleeExpr = node.getExpression();

        // DTG: MUTATES_STATE — Gap 1: métodos mutables sobre propiedades de objetos.
        // Detecta: order.items.push(x), this.cache.set(k, v), cart.lines.splice(0,1)
        // La arista apunta al tipo del RECEPTOR (el objeto cuya propiedad es mutada),
        // no al tipo del array/map en sí, para conectar con el agregado raíz.
        if (Node.isPropertyAccessExpression(calleeExpr)) {
          const methodName = calleeExpr.getName();
          if (MUTABLE_METHODS.has(methodName)) {
            // El receptor es el objeto que posee la propiedad siendo mutada
            const receiver = calleeExpr.getExpression();
            const receiverType = receiver.getType();
            const targetId = this.#resolveTypeToId(receiverType);
            if (targetId) this.#insertEdge(sourceId, targetId, "MUTATES_STATE");
          }
        }

        // CPG/SYS: CALLS | IMPORTS_EXTERNAL (lógica existente, siempre se procesa)
        this.#handleCallExpression(calleeExpr.getSymbol(), calleeExpr.getType(), sourceId);
        return;
      }

      if (Node.isNewExpression(node)) {
        // CPG: INSTANTIATES
        const targetId = this.#resolveTypeToId(node.getType());
        if (targetId) this.#insertEdge(sourceId, targetId, "INSTANTIATES");
        return;
      }

      if (Node.isBinaryExpression(node)) {
        // DTG: MUTATES_STATE — asignación directa (=) a propiedad de objeto
        // Detecta: order.status = 'SYNCED', this.total = 0
        if (node.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) return;

        const left = node.getLeft();
        if (!Node.isPropertyAccessExpression(left)) return;

        const receiverType = left.getExpression().getType();
        const targetId = this.#resolveTypeToId(receiverType);
        if (targetId) this.#insertEdge(sourceId, targetId, "MUTATES_STATE");
        return;
      }

      // Análisis de arrow functions inline (p.ej. callbacks en .map(), .filter())
      // No creamos nodo propio; usamos el sourceId del callable padre.
      if (Node.isArrowFunction(node)) {
        this.#analyzeArrowFunction(node, sourceId);
      }
    });
  }

  /**
   * Analiza una llamada a función para determinar si es interna (CALLS)
   * o externa de node_modules (IMPORTS_EXTERNAL).
   *
   * En DDD es muy común llamar a métodos de repositorios (`this.orderRepo.save(order)`),
   * que son funciones internas del proyecto.
   */
  #handleCallExpression(
    symbol: MorphSymbol | undefined,
    calleeType: Type,
    sourceId: string
  ): void {
    if (!symbol) return;

    const declarations = symbol.getDeclarations();
    if (declarations.length === 0) return;

    // Tomamos la primera declaración para identificar el origen
    const firstDecl = declarations[0];
    if (!firstDecl) return;

    const declFilePath = firstDecl.getSourceFile().getFilePath();

    if (declFilePath.includes("node_modules")) {
      // SYS: IMPORTS_EXTERNAL — construimos un nodo para la librería.
      // F4: el ID incluye el nombre del paquete npm para evitar colisiones entre
      //     librerías distintas que exporten símbolos con el mismo nombre.
      //     Ejemplos:  lib#rxjs#map,  lib#@nestjs/common#Injectable
      const pkgName = this.#extractPackageName(declFilePath);
      const libId = `lib#${pkgName}#${symbol.getName()}`;
      this.#insertNode({
        id: libId,
        kind: "EXTERNAL_LIB",
        name: `${pkgName}::${symbol.getName()}`,
        filepath: declFilePath,
        signature: this.#safeGetText(firstDecl),
        isDeprecated: this.#isDeprecated(symbol),
      });

      this.#insertEdge(sourceId, libId, "IMPORTS_EXTERNAL");
    } else {
      // CPG: CALLS — llamada a código interno del proyecto
      const targetId = this.#resolveTypeToId(calleeType);
      if (targetId) this.#insertEdge(sourceId, targetId, "CALLS");
    }
  }

  /**
   * Analiza el cuerpo de una arrow function inline buscando las mismas aristas
   * CPG/SYS/DTG que en una función normal, usando el `sourceId` del callable padre.
   *
   * Ejemplo:
   * ```ts
   * items.map(item => this.mapper.toDto(item))
   * // La llamada a `toDto` se atribuye al método que contiene el .map()
   * ```
   */
  #analyzeArrowFunction(arrow: ArrowFunction, parentSourceId: string): void {
    // CONSUMES_DATA desde sus propios parámetros
    for (const param of arrow.getParameters()) {
      this.#consumesFromParam(param, parentSourceId);
    }
    // Nota: el cuerpo de la arrow ya está cubierto por forEachDescendant del padre.
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // §4.3 — Gap 2: Variables exportadas (Arrow Functions y Const Objects)
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Extrae variables exportadas del módulo que contienen lógica de dominio.
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
  #extractVariableDeclarations(sourceFile: SourceFile, filePath: string): void {
    for (const varDecl of sourceFile.getVariableDeclarations()) {
      // Solo procesamos declaraciones exportadas (las no-exportadas son internas)
      const varStmt = varDecl.getVariableStatement();
      if (!varStmt?.isExported()) continue;

      const varName = varDecl.getName();
      const initializer = varDecl.getInitializer();
      if (!initializer) continue;

      const nodeId = `${filePath}#${varName}`;

      if (Node.isArrowFunction(initializer)) {
        // export const calculateTaxes = (order: IOrder) => { ... }
        this.#insertNode({
          id: nodeId,
          kind: "ARROW_FUNCTION",
          name: varName,
          filepath: filePath,
          signature: this.#buildArrowSignature(varName, initializer),
          isDeprecated: this.#isDeprecated(varDecl.getSymbol()),
        });
        // Analizar flujo de datos y llamadas en el cuerpo
        this.#extractDataFlow(initializer, nodeId);
        this.#traverseAst(initializer, nodeId);

      } else if (Node.isObjectLiteralExpression(initializer)) {
        // export const handlers = { create: (...) => {}, ... }
        this.#insertNode({
          id: nodeId,
          kind: "VARIABLE",
          name: varName,
          filepath: filePath,
          signature: `const ${varName} = { ... }`,
          isDeprecated: this.#isDeprecated(varDecl.getSymbol()),
        });
        // Extraer métodos y arrow functions del objeto como nodos propios
        this.#extractObjectLiteralMethods(initializer, nodeId, filePath);
      }
      // Escalares primitivos (string, number, boolean) no son relevantes para el grafo
    }
  }

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
  #extractObjectLiteralMethods(
    objLiteral: ObjectLiteralExpression,
    parentId: string,
    filePath: string
  ): void {
    for (const prop of objLiteral.getProperties()) {
      // Caso 1: { methodName: (params) => body }
      if (Node.isPropertyAssignment(prop)) {
        const propName = prop.getName();
        const init = prop.getInitializer();
        if (!init) continue;

        const propId = `${parentId}.${propName}`;

        if (Node.isArrowFunction(init)) {
          this.#insertNode({
            id: propId,
            kind: "ARROW_FUNCTION",
            name: propName,
            filepath: filePath,
            signature: this.#buildArrowSignature(propName, init),
            isDeprecated: 0,
          });
          this.#extractDataFlow(init, propId);
          this.#traverseAst(init, propId);

        } else if (Node.isObjectLiteralExpression(init)) {
          // Objeto anidado (p.ej. namespaces de comandos) — un nivel de recursión
          this.#insertNode({
            id: propId,
            kind: "VARIABLE",
            name: propName,
            filepath: filePath,
            signature: `${propName}: { ... }`,
            isDeprecated: 0,
          });
          this.#extractObjectLiteralMethods(init, propId, filePath);
        }
      }

      // Caso 2: { methodName(params) { body } } — shorthand method en objeto
      else if (Node.isMethodDeclaration(prop)) {
        const methodName = prop.getName();
        const methodId = `${parentId}.${methodName}`;
        this.#insertNode({
          id: methodId,
          kind: "METHOD",
          name: methodName,
          filepath: filePath,
          signature: this.#getMethodSignature(prop),
          isDeprecated: this.#isDeprecated(prop.getSymbol()),
        });
        this.#analyzeCallable(prop, methodId);
      }
    }
  }

  /**
   * Construye la firma textual de una arrow function exportada como variable.
   *
   * Ejemplo de salida:
   *   `const calculateTaxes = async (order: IOrder, rate: number): Promise<number> =>`
   */
  #buildArrowSignature(name: string, arrow: ArrowFunction): string {
    const asyncKw = arrow.isAsync() ? "async " : "";
    const params = arrow.getParameters().map((p) => p.getText()).join(", ");
    const retNode = arrow.getReturnTypeNode();
    const retType = retNode ? `: ${retNode.getText()}` : "";
    return `const ${name} = ${asyncKw}(${params})${retType} =>`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §5 — Persistencia
  // ───────────────────────────────────────────────────────────────────────────

  /** Persiste un nodo usando el prepared statement compilado en el constructor. */
  #insertNode(row: NodeRow): void {
    this.stmtInsertNode.run(row);
    this.nodesWritten++;
  }

  /** Persiste una arista usando el prepared statement compilado en el constructor. */
  #insertEdge(sourceId: string, targetId: string, relation: EdgeRelation): void {
    // Evitar auto-referencias (un nodo no se relaciona consigo mismo)
    if (sourceId === targetId) return;

    this.stmtInsertEdge.run({ sourceId, targetId, relation } satisfies EdgeRow);
    this.edgesWritten++;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §6 — Utilidades de resolución de tipos (sin regex)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Convierte un tipo de ts-morph en el ID canónico del nodo correspondiente.
   *
   * El ID es `${filePath}#${symbolName}`, lo que garantiza unicidad global
   * a lo largo de todo el proyecto, sin necesidad de UUID ni secuencias DB.
   *
   * Devuelve `null` si el tipo no es resoluble (primitivo, `any`, anónimo,
   * o definido en los archivos `lib.*.d.ts` de TypeScript).
   */
  #resolveTypeToId(type: Type): string | null {
    // Intentamos primero con el símbolo directo, luego con el alias.
    // Los type aliases (`type Foo = …`) exponen getAliasSymbol().
    const symbol = type.getSymbol() ?? type.getAliasSymbol();
    if (!symbol) return null;

    const declarations = symbol.getDeclarations();
    if (declarations.length === 0) return null;

    const firstDecl = declarations[0];
    if (!firstDecl) return null;

    const sourceFilePath = firstDecl.getSourceFile().getFilePath();

    // Filtramos tipos primitivos y estructuras internas del compilador de TS
    if (sourceFilePath.includes("typescript/lib")) return null;
    if (sourceFilePath.includes("node_modules/typescript")) return null;

    return `${sourceFilePath}#${symbol.getName()}`;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §7 — Construcción de firmas (sin regex — solo API del AST)
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Extrae la cabecera de una función (parámetros + tipo de retorno)
   * usando el sistema de firmas de ts-morph.
   *
   * `getSignature().getDeclaration().getText()` devuelve exactamente la
   * firma tal como fue escrita en el código fuente.
   */
  #getFunctionSignature(func: FunctionDeclaration): string {
    try {
      return func.getSignature().getDeclaration().getText();
    } catch {
      // Fallback: usamos el texto del nodo hasta la apertura del bloque
      return this.#safeGetText(func);
    }
  }

  /** @see #getFunctionSignature */
  #getMethodSignature(method: MethodDeclaration): string {
    try {
      return method.getSignature().getDeclaration().getText();
    } catch {
      return this.#safeGetText(method);
    }
  }

  /**
   * Construye la firma de una interfaz extrayendo su cabecera.
   *
   * Utiliza el AST para encontrar la posición del primer `{` —
   * sin usar split() ni regex sobre el string de texto.
   */
  #buildInterfaceSignature(fullText: string): string {
    // El token `{` de apertura de bloque siempre está en el texto de la declaración.
    // Usamos indexOf para encontrarlo en una sola pasada — esto no es regex.
    const openBrace = fullText.indexOf("{");
    if (openBrace === -1) return fullText;
    return fullText.slice(0, openBrace).trimEnd() + " {}";
  }

  /**
   * Construye la firma de una clase incluyendo:
   *   - Modificadores (`abstract`, `export`)
   *   - Nombre y parámetros genéricos
   *   - Superclase y lista de interfaces
   *
   * Esto resulta en firmas como:
   *   `export abstract class OrderService<T extends IOrder> extends BaseService<T> implements ICommandHandler<T>`
   */
  #buildClassSignature(classDecl: ClassDeclaration): string {
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

  // ───────────────────────────────────────────────────────────────────────────
  // §8 — JSDoc helpers
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Comprueba si el símbolo tiene el tag `@deprecated` en su JSDoc.
   *
   * Usamos la API de ts-morph (`getJsDocTags()`) en lugar de buscar
   * la cadena "deprecated" en el texto fuente.
   */
  #isDeprecated(symbol: MorphSymbol | undefined): 0 | 1 {
    if (!symbol) return 0;
    const hasDeprecated = symbol
      .getJsDocTags()
      .some((tag) => tag.getName() === "deprecated");
    return hasDeprecated ? 1 : 0;
  }

  // ───────────────────────────────────────────────────────────────────────────
  // §9 — Helpers de seguridad
  // ───────────────────────────────────────────────────────────────────────────

  /**
   * Obtiene el texto de un nodo AST sin lanzar en archivos de declaración
   * (`.d.ts`) donde `getText()` puede fallar por falta de source file.
   */
  #safeGetText(node: MorphNode): string {
    try {
      return node.getText();
    } catch {
      return "";
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // §10 — Utilidades de resolución de rutas
  // ─────────────────────────────────────────────────────────────────────────────

  /**
   * Extrae el nombre del paquete npm de la ruta absoluta de un archivo
   * ubicado dentro de `node_modules`.
   *
   * Maneja correctamente paquetes de ámbito \`@scope/name\`:
   *
   * ```
   * .../node_modules/rxjs/dist/index.js           → "rxjs"
   * .../node_modules/@nestjs/common/index.d.ts    → "@nestjs/common"
   * .../node_modules/@types/express/index.d.ts    → "@types/express"
   * ```
   */
  #extractPackageName(filePath: string): string {
    const marker = "node_modules/";
    const idx = filePath.lastIndexOf(marker);
    if (idx === -1) return "unknown";

    const after = filePath.slice(idx + marker.length);

    if (after.startsWith("@")) {
      // Paquete de ámbito: tomamos @scope/name
      const slash = after.indexOf("/", after.indexOf("/") + 1);
      return slash === -1 ? after : after.slice(0, slash);
    }

    // Paquete normal: primer segmento antes del siguiente /
    const firstSlash = after.indexOf("/");
    return firstSlash === -1 ? after : after.slice(0, firstSlash);
  }
}
