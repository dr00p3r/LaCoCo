import { 
    Project, 
    SourceFile, 
    Node, 
    ClassDeclaration, 
    MethodDeclaration,
    FunctionDeclaration,
    SyntaxKind,
    Symbol
} from "ts-morph";
import * as chokidar from "chokidar";
import Database from "better-sqlite3";

class TensorExtractor {
    private project: Project;
    private db: Database.Database;

    constructor(tsConfigFilePath: string, dbPath: string) {
        this.project = new Project({ tsConfigFilePath });
        this.db = new Database(dbPath);
        this.initDB();
    }

    private initDB() {
        // Schema actualizado exactamente a tu interfaz GraphNode y GraphEdge
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS nodes (
                id TEXT PRIMARY KEY, 
                kind TEXT, 
                name TEXT, 
                filepath TEXT, 
                signature TEXT, 
                isDeprecated INTEGER
            );
            CREATE TABLE IF NOT EXISTS edges (
                sourceId TEXT, 
                targetId TEXT, 
                relation TEXT,
                UNIQUE(sourceId, targetId, relation)
            );
            CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(sourceId);
            
            DELETE FROM nodes;
            DELETE FROM edges;
        `);
    }

    public start() {
        console.log("🚀 [Extractor] Iniciando análisis determinista completo...");
        const files = this.project.getSourceFiles();
        
        this.db.transaction(() => {
            files.forEach(f => this.processFile(f));
        })();
        console.log(`✅ [Extractor] Grafo Multirrelacional construido en SQLite.`);

        console.log("👀 [Watcher] Modo daemon activado...");
        const watcher = chokidar.watch("src/**/*.ts", { persistent: true });

        watcher.on("change", (path) => {
            console.time(`Update ${path}`);
            const sourceFile = this.project.getSourceFile(path);
            if (sourceFile) {
                sourceFile.refreshFromFileSystemSync();
                // Limpieza en cascada simulada para el archivo modificado
                this.db.prepare(`DELETE FROM nodes WHERE filepath = ?`).run(path);
                this.db.transaction(() => this.processFile(sourceFile))();
            }
            console.timeEnd(`Update ${path}`);
        });
    }

    private processFile(file: SourceFile) {
        const filePath = file.getFilePath();

        // 1. EXTRAER: INTERFACE
        file.getInterfaces().forEach(iface => {
            const nodeId = `${filePath}#${iface.getName()}`;
            const isDep = this.checkDeprecated(iface.getSymbol());
            this.insertNode(nodeId, "INTERFACE", iface.getName(), filePath, iface.getText().split('{')[0] + '{}', isDep);
        });

        // 2. EXTRAER: TYPE
        file.getTypeAliases().forEach(typeAlias => {
            const nodeId = `${filePath}#${typeAlias.getName()}`;
            const isDep = this.checkDeprecated(typeAlias.getSymbol());
            this.insertNode(nodeId, "TYPE", typeAlias.getName(), filePath, typeAlias.getText(), isDep);
        });

        // 3. EXTRAER: FUNCTION (Funciones sueltas)
        file.getFunctions().forEach(func => {
            const funcName = func.getName();
            if (funcName) {
                const nodeId = `${filePath}#${funcName}`;
                const isDep = this.checkDeprecated(func.getSymbol());
                this.insertNode(nodeId, "FUNCTION", funcName, filePath, func.getSignature().getDeclaration().getText(), isDep);
                this.processFunctionLogic(func, nodeId, filePath);
            }
        });

        // 4. EXTRAER: CLASS y METHOD
        file.getClasses().forEach(classDecl => {
            const className = classDecl.getName();
            if (!className) return;
            const classId = `${filePath}#${className}`;
            const isDep = this.checkDeprecated(classDecl.getSymbol());
            
            this.insertNode(classId, "CLASS", className, filePath, `class ${className}`, isDep);

            // Relaciones de Sistema (SYS)
            const baseClass = classDecl.getBaseClass();
            if (baseClass) {
                const targetId = this.resolveTypeId(baseClass.getType());
                if (targetId) this.insertEdge(classId, targetId, "EXTENDS");
            }
            classDecl.getImplements().forEach(impl => {
                const targetId = this.resolveTypeId(impl.getType());
                if (targetId) this.insertEdge(classId, targetId, "IMPLEMENTS");
            });

            // Relaciones Estructurales (CPG)
            classDecl.getConstructors().forEach(ctor => {
                ctor.getParameters().forEach(param => {
                    const targetId = this.resolveTypeId(param.getType());
                    if (targetId) this.insertEdge(classId, targetId, "INJECTS");
                });
            });

            classDecl.getMethods().forEach(m => {
                const methodId = `${classId}.${m.getName()}`;
                const mDep = this.checkDeprecated(m.getSymbol());
                this.insertNode(methodId, "METHOD", m.getName(), filePath, m.getSignature().getDeclaration().getText(), mDep);
                this.processFunctionLogic(m, methodId, filePath);
            });
        });
    }

    /**
     * Analiza el AST interno para extraer CALLS, IMPORTS_EXTERNAL, CONSUMES_DATA, PRODUCES y MUTATES_STATE
     */
    private processFunctionLogic(func: MethodDeclaration | FunctionDeclaration, sourceId: string, filePath: string) {
        // DTG: CONSUMES_DATA
        func.getParameters().forEach(param => {
            const type = param.getType();
            if (type.isObject() && !type.isAny()) {
                const targetId = this.resolveTypeId(type);
                if (targetId) this.insertEdge(sourceId, targetId, "CONSUMES_DATA");
            }
        });

        // DTG: PRODUCES
        const returnType = func.getReturnType();
        if (!returnType.isVoid() && !returnType.isAny()) {
            const actualType = returnType.isObject() && returnType.getSymbol()?.getName() === "Promise" 
                ? returnType.getTypeArguments()[0] 
                : returnType;
            const targetId = this.resolveTypeId(actualType);
            if (targetId) this.insertEdge(sourceId, targetId, "PRODUCES");
        }

        // Recorrido profundo del AST para CPG, SYS y DTG(Mutaciones)
        func.forEachDescendant(node => {
            // CPG/SYS: CALLS e IMPORTS_EXTERNAL
            if (Node.isCallExpression(node)) {
                const symbol = node.getExpression().getSymbol();
                if (symbol) {
                    const decl = symbol.getDeclarations()[0];
                    if (decl) {
                        const targetPath = decl.getSourceFile().getFilePath();
                        const targetName = symbol.getName();
                        
                        if (targetPath.includes("node_modules")) {
                            const libId = `lib#${targetName}`;
                            const isDep = this.checkDeprecated(symbol);
                            this.insertNode(libId, "EXTERNAL_LIB", targetName, targetPath, decl.getText(), isDep);
                            this.insertEdge(sourceId, libId, "IMPORTS_EXTERNAL");
                        } else {
                            const targetId = this.resolveTypeId(node.getExpression().getType());
                            if (targetId) this.insertEdge(sourceId, targetId, "CALLS");
                        }
                    }
                }
            } 
            // CPG: INSTANTIATES
            else if (Node.isNewExpression(node)) {
                const targetId = this.resolveTypeId(node.getType());
                if (targetId) this.insertEdge(sourceId, targetId, "INSTANTIATES");
            }
            // DTG: MUTATES_STATE (Detecta asignaciones a propiedades, ej. order.status = 'synced')
            else if (Node.isBinaryExpression(node)) {
                if (node.getOperatorToken().getKind() === SyntaxKind.EqualsToken) {
                    const left = node.getLeft();
                    if (Node.isPropertyAccessExpression(left)) {
                        const baseType = left.getExpression().getType();
                        const targetId = this.resolveTypeId(baseType);
                        if (targetId) this.insertEdge(sourceId, targetId, "MUTATES_STATE");
                    }
                }
            }
        });
    }

    // --- UTILIDADES ---
    private resolveTypeId(type: any): string | null {
        const symbol = type.getSymbol() || type.getAliasSymbol();
        if (!symbol) return null;
        const decl = symbol.getDeclarations()[0];
        if (!decl) return null;
        // Evitamos mapear tipos primitivos internos de TS
        if (decl.getSourceFile().getFilePath().includes("typescript/lib")) return null;
        return `${decl.getSourceFile().getFilePath()}#${symbol.getName()}`;
    }

    private checkDeprecated(symbol: Symbol | undefined): number {
        if (!symbol) return 0;
        return symbol.getJsDocTags().some(tag => tag.getName() === 'deprecated') ? 1 : 0;
    }

    private insertNode(id: string, kind: string, name: string, filepath: string, signature: string, isDeprecated: number) {
        this.db.prepare(`INSERT OR REPLACE INTO nodes (id, kind, name, filepath, signature, isDeprecated) VALUES (?, ?, ?, ?, ?, ?)`).run(id, kind, name, filepath, signature, isDeprecated);
    }

    private insertEdge(sourceId: string, targetId: string, relation: string) {
        this.db.prepare(`INSERT OR IGNORE INTO edges (sourceId, targetId, relation) VALUES (?, ?, ?)`).run(sourceId, targetId, relation);
    }
}

const extractor = new TensorExtractor("./tsconfig.json", "./tensor.sqlite");
extractor.start();