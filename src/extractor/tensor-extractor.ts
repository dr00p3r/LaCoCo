import {
  Project,
  type SourceFile,
  Node,
  type ClassDeclaration,
  type MethodDeclaration,
  type FunctionDeclaration,
  SyntaxKind,
  type Symbol as MorphSymbol,
  type Type,
} from "ts-morph";
import * as chokidar from "chokidar";
import type { SqliteManager } from "../db/sqlite-manager.js";

// ---------------------------------------------------------------------------
// TensorExtractor
// ---------------------------------------------------------------------------

/**
 * Motor principal de análisis estático.
 *
 * Responsabilidades:
 *   - Cargar el proyecto TypeScript vía ts-morph.
 *   - Extraer nodos (CLASS, METHOD, FUNCTION, INTERFACE, TYPE, EXTERNAL_LIB).
 *   - Extraer aristas (EXTENDS, IMPLEMENTS, CALLS, INSTANTIATES, …).
 *   - Delegar la persistencia al SqliteManager inyectado.
 *   - Modo watch: observar cambios con chokidar y re-analizar incrementalmente.
 */
export class TensorExtractor {
  private readonly project: Project;

  /**
   * @param tsConfigFilePath Ruta al tsconfig.json del proyecto a analizar.
   * @param db               Instancia del gestor de base de datos.
   */
  constructor(
    private readonly tsConfigFilePath: string,
    private readonly db: SqliteManager
  ) {
    this.project = new Project({ tsConfigFilePath });
  }

  // -------------------------------------------------------------------------
  // Ciclo de vida
  // -------------------------------------------------------------------------

  /** Análisis completo + modo daemon. */
  run(): void {
    console.log("🚀 [Extractor] Iniciando análisis completo...");
    const files = this.project.getSourceFiles();

    this.db.transaction(() => {
      for (const file of files) this.processFile(file);
    });

    const { nodes, edges } = this.db.stats();
    console.log(
      `✅ [Extractor] Grafo construido — ${nodes} nodos, ${edges} aristas.`
    );

    this.#startWatcher();
  }

  // -------------------------------------------------------------------------
  // Watcher incremental
  // -------------------------------------------------------------------------

  #startWatcher(): void {
    console.log("👀 [Watcher] Modo daemon activado...");

    const watcher = chokidar.watch("src/**/*.ts", { persistent: true });

    watcher.on("change", (changedPath) => {
      console.time(`[Watcher] Update ${changedPath}`);

      const sourceFile = this.project.getSourceFile(changedPath);
      if (sourceFile) {
        sourceFile.refreshFromFileSystemSync();
        this.db.deleteNodesByFile(changedPath);
        this.db.transaction(() => this.processFile(sourceFile));
      }

      console.timeEnd(`[Watcher] Update ${changedPath}`);
    });
  }

  // -------------------------------------------------------------------------
  // Procesamiento de archivo
  // -------------------------------------------------------------------------

  processFile(file: SourceFile): void {
    const filePath = file.getFilePath();

    // 1. INTERFACES
    for (const iface of file.getInterfaces()) {
      const nodeId = `${filePath}#${iface.getName()}`;
      this.db.insertNode({
        id: nodeId,
        kind: "INTERFACE",
        name: iface.getName(),
        filepath: filePath,
        signature: iface.getText().split("{")[0] + "{}",
        isDeprecated: this.#checkDeprecated(iface.getSymbol()),
      });
    }

    // 2. TYPE ALIASES
    for (const typeAlias of file.getTypeAliases()) {
      const nodeId = `${filePath}#${typeAlias.getName()}`;
      this.db.insertNode({
        id: nodeId,
        kind: "TYPE",
        name: typeAlias.getName(),
        filepath: filePath,
        signature: typeAlias.getText(),
        isDeprecated: this.#checkDeprecated(typeAlias.getSymbol()),
      });
    }

    // 3. FUNCIONES SUELTAS
    for (const func of file.getFunctions()) {
      const funcName = func.getName();
      if (!funcName) continue;

      const nodeId = `${filePath}#${funcName}`;
      this.db.insertNode({
        id: nodeId,
        kind: "FUNCTION",
        name: funcName,
        filepath: filePath,
        signature: func.getSignature().getDeclaration().getText(),
        isDeprecated: this.#checkDeprecated(func.getSymbol()),
      });
      this.#processFunctionBody(func, nodeId, filePath);
    }

    // 4. CLASES + MÉTODOS
    for (const classDecl of file.getClasses()) {
      const className = classDecl.getName();
      if (!className) continue;

      const classId = `${filePath}#${className}`;
      this.db.insertNode({
        id: classId,
        kind: "CLASS",
        name: className,
        filepath: filePath,
        signature: `class ${className}`,
        isDeprecated: this.#checkDeprecated(classDecl.getSymbol()),
      });

      this.#extractClassRelations(classDecl, classId, filePath);
    }
  }

  // -------------------------------------------------------------------------
  // Relaciones de clase
  // -------------------------------------------------------------------------

  #extractClassRelations(
    classDecl: ClassDeclaration,
    classId: string,
    filePath: string
  ): void {
    // SYS: herencia e implementación
    const baseClass = classDecl.getBaseClass();
    if (baseClass) {
      const targetId = this.#resolveTypeId(baseClass.getType());
      if (targetId)
        this.db.insertEdge({ sourceId: classId, targetId, relation: "EXTENDS" });
    }

    for (const impl of classDecl.getImplements()) {
      const targetId = this.#resolveTypeId(impl.getType());
      if (targetId)
        this.db.insertEdge({
          sourceId: classId,
          targetId,
          relation: "IMPLEMENTS",
        });
    }

    // CPG: inyección en constructores
    for (const ctor of classDecl.getConstructors()) {
      for (const param of ctor.getParameters()) {
        const targetId = this.#resolveTypeId(param.getType());
        if (targetId)
          this.db.insertEdge({
            sourceId: classId,
            targetId,
            relation: "INJECTS",
          });
      }
    }

    // Métodos
    for (const method of classDecl.getMethods()) {
      const methodId = `${classId}.${method.getName()}`;
      this.db.insertNode({
        id: methodId,
        kind: "METHOD",
        name: method.getName(),
        filepath: filePath,
        signature: method.getSignature().getDeclaration().getText(),
        isDeprecated: this.#checkDeprecated(method.getSymbol()),
      });
      this.#processFunctionBody(method, methodId, filePath);
    }
  }

  // -------------------------------------------------------------------------
  // Análisis del cuerpo de funciones / métodos
  // -------------------------------------------------------------------------

  #processFunctionBody(
    func: MethodDeclaration | FunctionDeclaration,
    sourceId: string,
    _filePath: string
  ): void {
    // DTG: CONSUMES_DATA (parámetros de tipo objeto)
    for (const param of func.getParameters()) {
      const type = param.getType();
      if (type.isObject() && !type.isAny()) {
        const targetId = this.#resolveTypeId(type);
        if (targetId)
          this.db.insertEdge({ sourceId, targetId, relation: "CONSUMES_DATA" });
      }
    }

    // DTG: PRODUCES (tipo de retorno)
    const returnType = func.getReturnType();
    if (!returnType.isVoid() && !returnType.isAny()) {
      const actualType =
        returnType.isObject() &&
        returnType.getSymbol()?.getName() === "Promise"
          ? returnType.getTypeArguments()[0]
          : returnType;

      if (actualType) {
        const targetId = this.#resolveTypeId(actualType);
        if (targetId)
          this.db.insertEdge({ sourceId, targetId, relation: "PRODUCES" });
      }
    }

    // Recorrido profundo del AST
    func.forEachDescendant((node) => {
      if (Node.isCallExpression(node)) {
        const symbol = node.getExpression().getSymbol();
        if (!symbol) return;

        const decl = symbol.getDeclarations()[0];
        if (!decl) return;

        const targetPath = decl.getSourceFile().getFilePath();
        const targetName = symbol.getName();

        if (targetPath.includes("node_modules")) {
          const libId = `lib#${targetName}`;
          this.db.insertNode({
            id: libId,
            kind: "EXTERNAL_LIB",
            name: targetName,
            filepath: targetPath,
            signature: decl.getText(),
            isDeprecated: this.#checkDeprecated(symbol),
          });
          this.db.insertEdge({ sourceId, targetId: libId, relation: "IMPORTS_EXTERNAL" });
        } else {
          const targetId = this.#resolveTypeId(node.getExpression().getType());
          if (targetId)
            this.db.insertEdge({ sourceId, targetId, relation: "CALLS" });
        }
      } else if (Node.isNewExpression(node)) {
        const targetId = this.#resolveTypeId(node.getType());
        if (targetId)
          this.db.insertEdge({ sourceId, targetId, relation: "INSTANTIATES" });
      } else if (Node.isBinaryExpression(node)) {
        if (
          node.getOperatorToken().getKind() === SyntaxKind.EqualsToken
        ) {
          const left = node.getLeft();
          if (Node.isPropertyAccessExpression(left)) {
            const targetId = this.#resolveTypeId(
              left.getExpression().getType()
            );
            if (targetId)
              this.db.insertEdge({
                sourceId,
                targetId,
                relation: "MUTATES_STATE",
              });
          }
        }
      }
    });
  }

  // -------------------------------------------------------------------------
  // Utilidades privadas
  // -------------------------------------------------------------------------

  #resolveTypeId(type: Type): string | null {
    const symbol = type.getSymbol() ?? type.getAliasSymbol();
    if (!symbol) return null;

    const decl = symbol.getDeclarations()[0];
    if (!decl) return null;

    // Evitar tipos primitivos internos de TypeScript
    if (decl.getSourceFile().getFilePath().includes("typescript/lib"))
      return null;

    return `${decl.getSourceFile().getFilePath()}#${symbol.getName()}`;
  }

  #checkDeprecated(symbol: MorphSymbol | undefined): number {
    if (!symbol) return 0;
    return symbol
      .getJsDocTags()
      .some((tag) => tag.getName() === "deprecated")
      ? 1
      : 0;
  }
}
