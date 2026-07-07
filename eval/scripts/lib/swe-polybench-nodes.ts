/**
 * Traductor de ground truth node-level de SWE-PolyBench → node-id de LaCoCo.
 *
 * SWE-PolyBench publica, por instancia, `modified_nodes`: la lista de nodos
 * (función/clase/método) que toca el gold patch, ya calculada con CST. Cada
 * entrada es una **ruta CST** con la forma:
 *
 *     <relpath>->program->class_declaration:Foo->method_definition:bar
 *
 * LaCoCo direcciona sus nodos como `<relpath>#<símbolo>` (ver
 * `src/extractor/node-extraction.ts` y `class-extraction.ts`). Este módulo mapea
 * la ruta CST al node-id que **realmente produce el extractor de LaCoCo**, para
 * poblar `relevant_nodes` (M3–M5) sin anotación manual. La correspondencia es
 * exacta o el nodo no existirá en `tensor.sqlite` y el recall será 0
 * (ver memoria eval-ground-truth-mechanics).
 *
 * Reglas de nombrado replicadas del extractor:
 *   - función suelta          → `relpath#func`         (node-extraction.ts:152)
 *   - clase                   → `relpath#Clase`        (node-extraction.ts:181)
 *   - método de clase         → `relpath#Clase.metodo` (class-extraction.ts:151)
 *
 * Decisiones de granularidad (LaCoCo indexa hasta función/clase/método de nivel
 * superior; NO crea nodos para funciones/métodos anidados dentro de un cuerpo):
 *   - Cualquier segmento CST más profundo que el nodo LaCoCo direccionable se
 *     **colapsa** al ancestro direccionable (p. ej. una función anidada dentro
 *     de un método → el método que la contiene). Se marca `collapsed: true`.
 *   - `method_definition:constructor` NO es un nodo en LaCoCo (usa `getMethods()`,
 *     que excluye constructores) → se colapsa a la **clase** `relpath#Clase`.
 *   - Un `method_definition` sin `class_declaration` en la ruta (métodos de
 *     object-literal en CommonJS, típicos de serverless) NO lo indexa LaCoCo como
 *     nodo → queda **sin mapear a nivel nodo** (`nodeId: null`), pero su archivo
 *     sigue siendo señal válida a nivel archivo (File Retrieval).
 *
 * Limitación conocida: la ruta CST no distingue un método normal de un
 * getter/setter (ambos son `method_definition`), que LaCoCo nombra distinto
 * (`Clase::get:x`). Los accessors son raros y se emiten como `Clase.x`; el smoke
 * contra el grafo real los detectará como no encontrados. Se documenta aquí en
 * vez de adivinar.
 */

/** Granularidad de nodo direccionable en el grafo de LaCoCo. */
export type LacocoNodeKind = "FUNCTION" | "CLASS" | "METHOD";

/** Resultado de traducir una sola ruta CST de `modified_nodes`. */
export interface TranslatedNode {
  /** Ruta CST original de SWE-PolyBench (sin tocar). */
  readonly cstPath: string;
  /** Archivo repo-relativo (POSIX), primer segmento de la ruta CST. */
  readonly relpath: string;
  /**
   * Node-id en formato LaCoCo relativo (`<relpath>#<símbolo>`), o `null` si la
   * ruta no corresponde a ningún nodo que LaCoCo indexe. Los ids relativos se
   * resuelven a absolutos con `resolveNodeId` antes de comparar contra el grafo.
   */
  readonly nodeId: string | null;
  /** Parte tras `#` (p. ej. `Clase.metodo`), o `null` si no mapeó. */
  readonly symbol: string | null;
  /** Granularidad LaCoCo resuelta, o `null` si no mapeó. */
  readonly kind: LacocoNodeKind | null;
  /** `true` si la ruta CST era más profunda que el nodo LaCoCo (se colapsó). */
  readonly collapsed: boolean;
  /** Motivo por el que `nodeId` es `null` (solo presente cuando no mapeó). */
  readonly reason?: string;
}

/** Traducción agregada de todo el `modified_nodes` de una instancia. */
export interface ModifiedNodesTranslation {
  /** Node-ids únicos mapeados (el `relevant_nodes` de nivel nodo para M4/M5). */
  readonly nodeIds: string[];
  /** Archivos repo-relativos únicos tocados (relevante de nivel archivo, M3). */
  readonly files: string[];
  /** Detalle por cada ruta CST de entrada (mapeadas y no). */
  readonly translated: TranslatedNode[];
  /** Subconjunto de `translated` que no pudo mapear a nivel nodo. */
  readonly unmapped: TranslatedNode[];
}

interface CstSegment {
  readonly kind: string;
  readonly name: string | null;
}

/**
 * Parsea el campo `modified_nodes`, que llega como **repr de lista Python**
 * (comillas simples) o como JSON, y a veces ya como arreglo. Las rutas CST no
 * contienen comillas, así que se extraen de forma robusta por regex,
 * independientemente del estilo de comillas.
 */
export function parseModifiedNodes(raw: string | readonly string[] | null | undefined): string[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");

  const text = String(raw).trim();
  if (text === "" || text === "[]") return [];

  // Intento estricto: JSON válido (lista de strings con comillas dobles).
  try {
    const parsed = JSON.parse(text) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // cae al parser tolerante
  }

  // Tolerante: extrae cada cadena entrecomillada (simple o doble). Seguro porque
  // las rutas CST no incluyen `'` ni `"`.
  const out: string[] = [];
  const re = /(['"])(.*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[2] ?? "");
  return out;
}

/** Divide un segmento CST `kind:name` en sus partes (name `null` si no hay). */
function parseSegment(segment: string): CstSegment {
  const idx = segment.indexOf(":");
  if (idx === -1) return { kind: segment, name: null };
  return { kind: segment.slice(0, idx), name: segment.slice(idx + 1) };
}

function unmapped(
  cstPath: string,
  relpath: string,
  reason: string,
  collapsed = false,
): TranslatedNode {
  return { cstPath, relpath, nodeId: null, symbol: null, kind: null, collapsed, reason };
}

function mapped(
  cstPath: string,
  relpath: string,
  symbol: string,
  kind: LacocoNodeKind,
  collapsed: boolean,
): TranslatedNode {
  return { cstPath, relpath, nodeId: `${relpath}#${symbol}`, symbol, kind, collapsed };
}

/**
 * Traduce una sola ruta CST de SWE-PolyBench al node-id de LaCoCo (o la marca
 * como no mapeable a nivel nodo, conservando el archivo).
 */
export function cstPathToNodeId(cstPath: string): TranslatedNode {
  const segments = cstPath.split("->");
  const relpath = segments[0] ?? "";
  if (relpath === "") return unmapped(cstPath, relpath, "empty_path");

  // Cadena de nodos tras el archivo, descartando el `program` raíz.
  const chain = segments
    .slice(1)
    .map(parseSegment)
    .filter((s) => s.kind !== "program");

  if (chain.length === 0) return unmapped(cstPath, relpath, "no_node_segment");

  const first = chain[0]!;

  // Función de nivel superior: cualquier cosa anidada dentro se colapsa a ella.
  if (first.kind === "function_declaration") {
    if (!first.name) return unmapped(cstPath, relpath, "missing_symbol_name");
    return mapped(cstPath, relpath, first.name, "FUNCTION", chain.length > 1);
  }

  // Clase de nivel superior (posiblemente con un método directo).
  if (first.kind === "class_declaration") {
    if (!first.name) return unmapped(cstPath, relpath, "missing_symbol_name");
    const second = chain[1];

    if (second?.kind === "method_definition") {
      if (!second.name) return unmapped(cstPath, relpath, "missing_symbol_name");
      // El constructor no es un nodo METHOD en LaCoCo → colapsa a la clase.
      if (second.name === "constructor") {
        return mapped(cstPath, relpath, first.name, "CLASS", true);
      }
      // Método directo de la clase; niveles más profundos se colapsan al método.
      return mapped(cstPath, relpath, `${first.name}.${second.name}`, "METHOD", chain.length > 2);
    }

    // Clase sola (o con un hijo que LaCoCo no direcciona) → nodo de clase.
    return mapped(cstPath, relpath, first.name, "CLASS", chain.length > 1);
  }

  // `method_definition` sin clase contenedora: método de object-literal (CommonJS)
  // que LaCoCo no indexa como nodo. Se conserva a nivel archivo.
  if (first.kind === "method_definition") {
    return unmapped(cstPath, relpath, "orphan_method");
  }

  return unmapped(cstPath, relpath, `unsupported_kind:${first.kind}`);
}

/**
 * Traduce el `modified_nodes` completo de una instancia a los conjuntos de
 * `relevant_nodes` (nivel nodo) y archivos relevantes (nivel archivo).
 *
 * @param modifiedNodes  campo crudo `modified_nodes` (string repr o arreglo).
 * @param changedFiles   opcional: `changed_files` de la instancia; su unión con
 *                       los archivos de las rutas CST forma la señal de archivo.
 */
export function translateModifiedNodes(
  modifiedNodes: string | readonly string[] | null | undefined,
  changedFiles?: readonly string[] | null,
): ModifiedNodesTranslation {
  const translated = parseModifiedNodes(modifiedNodes).map(cstPathToNodeId);

  const nodeIds = [...new Set(translated.map((t) => t.nodeId).filter((id): id is string => id !== null))];

  const files = [
    ...new Set([
      ...translated.map((t) => t.relpath).filter((p) => p !== ""),
      ...(changedFiles ?? []),
    ]),
  ];

  const unmappedNodes = translated.filter((t) => t.nodeId === null);

  return { nodeIds, files, translated, unmapped: unmappedNodes };
}
