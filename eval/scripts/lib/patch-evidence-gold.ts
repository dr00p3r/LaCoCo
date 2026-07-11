/**
 * Extractor de **patch-evidence gold**: deriva el gold de "contexto útil"
 * AUTOMÁTICAMENTE del patch de referencia, no del grafo de LaCoCo.
 *
 * Motivación (ver docs/plan-rediseño): evaluar una estrategia graph-based contra
 * un gold construido por el mismo grafo la favorece estructuralmente sin que eso
 * signifique que ayuda al agente. El gold debe salir de "lo que toca el patch".
 *
 * INVARIANTE DE INDEPENDENCIA (constraint de implementación, no solo de diseño):
 * este módulo resuelve símbolos vía `ts-morph` DIRECTO y NO importa nada de
 * `src/graph/*` ni reusa el índice/tensor de LaCoCo. Así un bug de resolución de
 * LaCoCo (re-exports, barrel files, overloads) no queda compartido entre el gold
 * y la estrategia evaluada. Hay un test estructural que falla si este archivo
 * importa desde `src/graph`.
 *
 * Dos tiers, por dependencia de datos:
 *  - Tier 1 (sin repo): `edited_files`, `edited_symbols`, `touched_tests`. Se
 *    calcula en el import, solo con el patch y `modified_nodes`.
 *  - Tier 2 (con repo parcheado + ts-morph): `introduced_refs` (identificadores
 *    en líneas AÑADIDAS) y `resolved_definitions` (su definición dentro del repo).
 */

import { relative as nodeRelative } from "node:path";
import type { Node, Project, SourceFile } from "ts-morph";
import { SyntaxKind } from "ts-morph";

import type { PatchEvidenceGold, SymbolKind, SymbolRef } from "./types.js";
import { parseF2pTestId } from "./swe-polybench-test-command.js";
import { translateModifiedNodes, type LacocoNodeKind } from "./swe-polybench-nodes.js";

/** Cambios de un archivo en un unified diff: ruta (lado b) + líneas añadidas. */
export interface DiffFileChange {
  /** Ruta repo-relativa (POSIX), del lado nuevo (`b/…`). */
  readonly path: string;
  /** Números de línea (1-based, lado nuevo) de las líneas `+` añadidas. */
  readonly addedLines: number[];
  /**
   * Números de línea (1-based, lado VIEJO/base) que el fix toca, para mapear el
   * diff al símbolo que lo contiene en el árbol BASE (pre-fix, que es lo que
   * indexa el pipeline). Por hunk: las líneas `-` eliminadas; si el hunk es de
   * pura inserción (sin `-`), sus líneas de contexto, que en el base caen dentro
   * del símbolo donde se inserta. Ver `deriveEditedSymbolsFromCheckout`.
   */
  readonly oldSideLines: number[];
}

const DIFF_GIT_RE = /^diff --git a\/(.+?) b\/(.+)$/;
const PLUS_FILE_RE = /^\+\+\+ b\/(.+)$/;
const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parsea un unified diff en cambios por archivo. Por archivo extrae los números
 * de línea del lado NUEVO donde hay líneas añadidas (`+`, para que el Tier 2 sepa
 * qué introdujo el patch) y los del lado VIEJO que el fix toca (`oldSideLines`,
 * para mapear al símbolo del árbol base). Nunca lanza: un diff malformado produce
 * menos entradas, no un error.
 */
export function parseUnifiedDiff(diff: string): DiffFileChange[] {
  const files: DiffFileChange[] = [];
  let current: { path: string; addedLines: number[]; oldSideLines: number[] } | null = null;
  let cursor = 0; // lado nuevo
  let oldCursor = 0; // lado viejo
  let hunkRemoved: number[] = [];
  let hunkContext: number[] = [];

  // Al cerrar un hunk: si tuvo líneas eliminadas, esas son las que mapean al
  // símbolo modificado (preciso); si fue pura inserción, el contexto es el único
  // ancla al símbolo base donde se insertó.
  const commitHunk = (): void => {
    if (current !== null) {
      const src = hunkRemoved.length > 0 ? hunkRemoved : hunkContext;
      for (const line of src) current.oldSideLines.push(line);
    }
    hunkRemoved = [];
    hunkContext = [];
  };

  const flush = (): void => {
    commitHunk();
    if (current !== null) {
      files.push({ path: current.path, addedLines: current.addedLines, oldSideLines: current.oldSideLines });
    }
  };

  for (const rawLine of diff.split("\n")) {
    const gitMatch = DIFF_GIT_RE.exec(rawLine);
    if (gitMatch) {
      flush();
      current = { path: gitMatch[2]!, addedLines: [], oldSideLines: [] };
      cursor = 0;
      oldCursor = 0;
      continue;
    }
    const plusFile = PLUS_FILE_RE.exec(rawLine);
    if (plusFile && current !== null) {
      // El header `+++ b/path` confirma/corrige la ruta del lado nuevo.
      current = { path: plusFile[1]!, addedLines: current.addedLines, oldSideLines: current.oldSideLines };
      continue;
    }
    const hunk = HUNK_RE.exec(rawLine);
    if (hunk) {
      commitHunk();
      oldCursor = Number(hunk[1]);
      cursor = Number(hunk[2]);
      continue;
    }
    if (current === null || cursor === 0) continue;
    if (rawLine.startsWith("+++") || rawLine.startsWith("---")) continue;
    if (rawLine.startsWith("+")) {
      current.addedLines.push(cursor);
      cursor += 1;
    } else if (rawLine.startsWith("-")) {
      // línea eliminada: mapea al símbolo base; avanza solo el lado viejo.
      hunkRemoved.push(oldCursor);
      oldCursor += 1;
    } else {
      // contexto (espacio) o línea vacía dentro del hunk: existe en ambos lados.
      hunkContext.push(oldCursor);
      cursor += 1;
      oldCursor += 1;
    }
  }
  flush();
  return files;
}

/** Rutas (lado nuevo) de todos los archivos tocados por un diff. */
export function filesInDiff(diff: string): string[] {
  return [...new Set(parseUnifiedDiff(diff).map((f) => f.path))];
}

function lacocoKindToSymbolKind(kind: LacocoNodeKind): SymbolKind {
  switch (kind) {
    case "FUNCTION":
      return "function";
    case "CLASS":
      return "class";
    case "METHOD":
      return "method";
  }
}

/** Entrada del extractor Tier 1 (genérica, no atada a SWE-PolyBench). */
export interface PatchEvidenceTier1Input {
  /** Diff del patch de referencia (el fix). */
  readonly patch: string;
  /** Diff del patch de tests, si lo hay. */
  readonly testPatch?: string | null;
  /** `modified_nodes` de SWE-PolyBench (rutas CST) si está disponible. */
  readonly modifiedNodes?: string | readonly string[] | null;
  /** `changed_files` de la instancia (corrobora los archivos del patch). */
  readonly changedFiles?: readonly string[] | null;
  /** `F2P` de SWE-PolyBench (para archivos de test cuando el id trae ruta). */
  readonly f2p?: string | readonly string[] | null;
}

export function dedupeSymbols(refs: SymbolRef[]): SymbolRef[] {
  const seen = new Map<string, SymbolRef>();
  for (const ref of refs) seen.set(`${ref.file}#${ref.symbol}`, ref);
  return [...seen.values()];
}

/** Divide un F2P repr (lista Python o JSON) en ids sueltos. */
function parseF2pList(raw: string | readonly string[] | null | undefined): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  const text = String(raw).trim();
  if (text === "" || text === "[]") return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    /* cae al parser tolerante */
  }
  const out: string[] = [];
  const re = /(['"])(.*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[2] ?? "");
  return out;
}

/**
 * Tier 1: deriva edit-site (archivos + símbolos) y tests tocados sin necesitar
 * el repo checked-out. Los símbolos salen del `modified_nodes` traducido; si
 * ninguno mapea (patch sin nodo direccionable), el gold cae a nivel archivo y se
 * marca `resolution.fell_back_to_file_level = true`.
 */
export function extractPatchEvidenceTier1(input: PatchEvidenceTier1Input): PatchEvidenceGold {
  const translation = translateModifiedNodes(input.modifiedNodes ?? null, input.changedFiles ?? null);

  // Archivos editados: unión de los archivos del diff del fix + los que aporta la
  // traducción (que ya incluye `changed_files`). Excluye lo que sea del test_patch.
  const patchFiles = filesInDiff(input.patch);
  const editedFiles = [
    ...new Set([...patchFiles, ...translation.files]),
  ];

  const editedSymbols = dedupeSymbols(
    translation.translated
      .filter((t) => t.nodeId !== null && t.symbol !== null && t.kind !== null)
      .map((t) => ({
        file: t.relpath,
        symbol: t.symbol!,
        kind: lacocoKindToSymbolKind(t.kind!),
      })),
  );

  // Tests tocados: archivos del test_patch + archivos que traiga el F2P (ids con
  // `<file>-><title>`). Nivel archivo: es lo comparable contra el retrieval.
  const testFiles = new Set<string>();
  if (input.testPatch != null && input.testPatch !== "") {
    for (const f of filesInDiff(input.testPatch)) testFiles.add(f);
  }
  for (const id of parseF2pList(input.f2p)) {
    const parsed = parseF2pTestId(id);
    if (parsed.file !== null) testFiles.add(parsed.file);
  }

  const fellBackToFileLevel = editedSymbols.length === 0 && editedFiles.length > 0;

  return {
    source: "patch",
    edited_files: editedFiles,
    edited_symbols: editedSymbols,
    touched_tests: [...testFiles],
    introduced_refs: [],
    resolved_definitions: [],
    resolution: {
      fell_back_to_file_level: fellBackToFileLevel,
      unresolved_refs: [],
    },
  };
}

/** Nombre del símbolo direccionable que contiene a `node` (o null). */
export function enclosingSymbol(node: Node): { symbol: string; kind: SymbolKind } | null {
  let current: Node | undefined = node;
  let method: string | null = null;
  while (current !== undefined) {
    const kind = current.getKind();
    if (kind === SyntaxKind.MethodDeclaration) {
      const name = current.asKind(SyntaxKind.MethodDeclaration)?.getName();
      if (name && name !== "constructor") method = name;
    } else if (kind === SyntaxKind.ClassDeclaration) {
      const name = current.asKind(SyntaxKind.ClassDeclaration)?.getName();
      if (name) return { symbol: method ? `${name}.${method}` : name, kind: method ? "method" : "class" };
    } else if (kind === SyntaxKind.FunctionDeclaration) {
      const name = current.asKind(SyntaxKind.FunctionDeclaration)?.getName();
      if (name) return { symbol: name, kind: "function" };
    } else if (kind === SyntaxKind.InterfaceDeclaration) {
      const name = current.asKind(SyntaxKind.InterfaceDeclaration)?.getName();
      if (name) return { symbol: name, kind: "interface" };
    } else if (kind === SyntaxKind.TypeAliasDeclaration) {
      const name = current.asKind(SyntaxKind.TypeAliasDeclaration)?.getName();
      if (name) return { symbol: name, kind: "type" };
    } else if (
      kind === SyntaxKind.VariableStatement &&
      current.getParent()?.getKind() === SyntaxKind.SourceFile
    ) {
      const decl = current.asKind(SyntaxKind.VariableStatement)?.getDeclarations()[0];
      const name = decl?.getName();
      if (name) return { symbol: name, kind: "variable" };
    }
    current = current.getParent();
  }
  return null;
}

/**
 * Deriva el gold a nivel SÍMBOLO desde un diff, resolviéndolo contra el árbol
 * BASE (pre-fix) checked-out. Para cada archivo, mapea las líneas del lado VIEJO
 * (`change.oldSideLines`) al símbolo direccionable que las contiene en el base
 * (vía `enclosingSymbol`). Es la contraparte "sin `modified_nodes`" de lo que
 * SWE-PolyBench trae nativo: convierte un patch estilo SWE-bench en `edited_symbols`.
 *
 * Sutileza base-vs-patched: el pipeline indexa el repo en `base_commit`, así que
 * el `project` debe ser un árbol ts-morph sobre ese checkout y se mapean las
 * líneas viejas (no las añadidas). Un hunk que solo añade código nuevo que no
 * existe en el base no aporta símbolo → queda cubierto a nivel archivo por
 * `edited_files`.
 *
 * INDEPENDENCIA: usa ts-morph directo; NO importa de `src/graph`.
 */
export function deriveEditedSymbolsFromCheckout(
  changes: DiffFileChange[],
  project: Project,
  repoDir: string,
  resolveSourcePath?: (repoRelPath: string) => string,
): SymbolRef[] {
  const resolvePath = resolveSourcePath ?? ((rel: string) => `${repoDir.replace(/\/$/, "")}/${rel}`);
  const symbols: SymbolRef[] = [];

  for (const change of changes) {
    if (change.oldSideLines.length === 0) continue;
    const abs = resolvePath(change.path);
    const sourceFile: SourceFile | undefined = project.getSourceFile(abs);
    if (sourceFile === undefined) continue;
    const oldLineSet = new Set(change.oldSideLines);

    const visit = (node: Node): void => {
      if (oldLineSet.has(node.getStartLineNumber())) {
        const enclosing = enclosingSymbol(node);
        if (enclosing !== null) {
          symbols.push({ file: change.path, symbol: enclosing.symbol, kind: enclosing.kind });
        }
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
  }

  return dedupeSymbols(symbols);
}

/** Opciones del enriquecimiento Tier 2. */
export interface Tier2Options {
  /** Project de ts-morph con el árbol POST-patch cargado. */
  readonly project: Project;
  /** Directorio absoluto del repo, para hacer las rutas repo-relativas. */
  readonly repoDir: string;
  /** Cambios del diff del fix (para saber qué líneas introdujo el patch). */
  readonly changes: DiffFileChange[];
  /** Resuelve la ruta absoluta del archivo `path` (repo-relativo). */
  readonly resolveSourcePath?: (repoRelPath: string) => string;
}

/** Convierte una ruta absoluta a repo-relativa POSIX, o null si cae fuera del repo. */
function toRepoRelative(absPath: string, repoDir: string): string | null {
  const rel = nodeRelative(repoDir, absPath);
  if (rel.startsWith("..") || rel === "") return null;
  return rel.split("\\").join("/");
}

/** ¿La declaración vive dentro del repo y no es un `.d.ts` de node_modules? */
function isInternalDeclaration(declFile: string, repoDir: string): boolean {
  if (declFile.includes("/node_modules/")) return false;
  return toRepoRelative(declFile, repoDir) !== null;
}

/**
 * Tier 2: analiza las líneas AÑADIDAS del patch sobre el árbol post-patch y
 * resuelve, vía ts-morph, las definiciones (dentro del repo) de los símbolos que
 * el patch introduce (llamadas, `new`, referencias de tipo, imports nombrados).
 *
 * Devuelve una copia del gold con `introduced_refs`, `resolved_definitions` y
 * `resolution.unresolved_refs` poblados. Best-effort: cualquier símbolo que no
 * resuelva a una definición interna engrosa `unresolved_refs` y se sigue.
 */
export function enrichPatchEvidenceWithDefinitions(
  gold: PatchEvidenceGold,
  options: Tier2Options,
): PatchEvidenceGold {
  const { project, repoDir } = options;
  const resolvePath = options.resolveSourcePath
    ?? ((rel: string) => `${repoDir.replace(/\/$/, "")}/${rel}`);

  const introduced: SymbolRef[] = [];
  const definitions: SymbolRef[] = [];
  const unresolved = new Set<string>();

  for (const change of options.changes) {
    if (change.addedLines.length === 0) continue;
    const abs = resolvePath(change.path);
    const sourceFile: SourceFile | undefined = project.getSourceFile(abs);
    if (sourceFile === undefined) continue;
    const addedSet = new Set(change.addedLines);

    const visit = (node: Node): void => {
      const line = node.getStartLineNumber();
      if (addedSet.has(line)) {
        const identifier = pickIdentifier(node);
        if (identifier !== null) {
          const name = identifier.getText();
          introduced.push({ file: change.path, symbol: name, kind: refKind(node) });
          const decls = safeDeclarations(identifier);
          let resolvedAny = false;
          for (const decl of decls) {
            const declFile = decl.getSourceFile().getFilePath();
            if (!isInternalDeclaration(declFile, repoDir)) continue;
            const rel = toRepoRelative(declFile, repoDir);
            if (rel === null) continue;
            const enclosing = enclosingSymbol(decl) ?? { symbol: name, kind: refKind(node) };
            definitions.push({ file: rel, symbol: enclosing.symbol, kind: enclosing.kind });
            resolvedAny = true;
          }
          if (!resolvedAny) unresolved.add(name);
        }
      }
      node.forEachChild(visit);
    };
    sourceFile.forEachChild(visit);
  }

  return {
    ...gold,
    introduced_refs: dedupeSymbols(introduced),
    resolved_definitions: dedupeSymbols(definitions),
    resolution: {
      ...gold.resolution,
      unresolved_refs: [...unresolved].sort(),
    },
  };
}

/** El identificador "cabeza" de una llamada/new/tipo/import, o null. */
function pickIdentifier(node: Node): Node | null {
  const kind = node.getKind();
  if (kind === SyntaxKind.CallExpression) {
    const expr = node.asKindOrThrow(SyntaxKind.CallExpression).getExpression();
    return rightmostName(expr);
  }
  if (kind === SyntaxKind.NewExpression) {
    const expr = node.asKindOrThrow(SyntaxKind.NewExpression).getExpression();
    return rightmostName(expr);
  }
  if (kind === SyntaxKind.TypeReference) {
    const name = node.asKindOrThrow(SyntaxKind.TypeReference).getTypeName();
    return rightmostName(name);
  }
  if (kind === SyntaxKind.ImportSpecifier) {
    return node.asKindOrThrow(SyntaxKind.ImportSpecifier).getNameNode();
  }
  return null;
}

/** Para `a.b.c` devuelve el nodo `c`; para un identificador simple, sí mismo. */
function rightmostName(node: Node): Node | null {
  const kind = node.getKind();
  if (kind === SyntaxKind.Identifier) return node;
  if (kind === SyntaxKind.PropertyAccessExpression) {
    return node.asKindOrThrow(SyntaxKind.PropertyAccessExpression).getNameNode();
  }
  if (kind === SyntaxKind.QualifiedName) {
    return node.asKindOrThrow(SyntaxKind.QualifiedName).getRight();
  }
  return null;
}

function refKind(node: Node): SymbolKind {
  const kind = node.getKind();
  if (kind === SyntaxKind.NewExpression) return "class";
  if (kind === SyntaxKind.TypeReference) return "type";
  return "function";
}

/**
 * Nodos de DEFINICIÓN de un identificador (sigue imports/aliases hasta la
 * definición real, no la re-declaración local). Nunca lanza (degrada a []).
 */
function safeDeclarations(identifier: Node): Node[] {
  try {
    const id = identifier.asKind(SyntaxKind.Identifier);
    if (id !== undefined) return id.getDefinitionNodes();
    const symbol = identifier.getSymbol();
    return symbol === undefined ? [] : symbol.getDeclarations();
  } catch {
    return [];
  }
}

/**
 * Deriva el mapa `path → líneas añadidas` restringido a los archivos de código
 * del fix (excluye los tests, que se comparan a nivel archivo). Útil para el CLI
 * que arma las `Tier2Options.changes`.
 */
export function sourceChangesFromPatch(patch: string, testPatch?: string | null): DiffFileChange[] {
  const testFiles = new Set(testPatch != null && testPatch !== "" ? filesInDiff(testPatch) : []);
  return parseUnifiedDiff(patch).filter((c) => !testFiles.has(c.path));
}
