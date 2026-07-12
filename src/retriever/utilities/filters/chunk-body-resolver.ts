/**
 * ChunkBodyResolver — Reemplaza el `text` de cada chunk (una FIRMA) por el
 * CUERPO real del símbolo, cortado del working tree en retrieve-time.
 *
 * Por qué leer del disco y no de la BDD: el cuerpo queda siempre fresco con el
 * árbol de trabajo (más incluso que el índice), y la BDD se mantiene pequeña
 * (solo guarda `startLine`/`endLine`). Si el archivo se movió, se borró o se
 * desfasó respecto al índice, se cae de vuelta a la firma sin romper nada.
 */

import fs from "node:fs";
import { type ContextChunk } from "../../models/strategies/types.js";
import { type NodeSpan } from "../../../persistence/lacoco-graph-manager/lacoco-sqlite-service.js";

/** Origen de los spans; solo se necesita `getNodeSpans`. */
export interface NodeSpanSource {
  getNodeSpans(ids: string[]): Map<string, NodeSpan>;
}

export interface BodyResolverOptions {
  /** Umbral: símbolos con más líneas se sirven recortados (head + tail). */
  maxBodyLines: number;
  headLines: number;
  tailLines: number;
}

// ~60 líneas ≈ 500-700 tokens cl100k. Head+tail preserva firma y `return` de
// funciones largas sin monopolizar el presupuesto de un solo chunk.
export const DEFAULT_BODY_OPTIONS: BodyResolverOptions = {
  maxBodyLines: 60,
  headLines: 45,
  tailLines: 10,
};

export class ChunkBodyResolver {
  constructor(
    private readonly db: NodeSpanSource,
    private readonly options: BodyResolverOptions = DEFAULT_BODY_OPTIONS,
  ) {}

  /**
   * Devuelve copias de los chunks con `text` = cuerpo y `location` poblado
   * cuando se puede resolver; el chunk original (firma) en caso contrario.
   */
  resolve(chunks: ContextChunk[]): ContextChunk[] {
    if (chunks.length === 0) return chunks;

    const spans = this.db.getNodeSpans(chunks.map((c) => c.nodeId));
    const fileCache = new Map<string, string[] | null>();

    return chunks.map((chunk) => {
      const span = spans.get(chunk.nodeId);
      if (!span || span.startLine === null || span.endLine === null) return chunk;

      const lines = this.#readLines(span.filepath, fileCache);
      if (!lines) return chunk;

      const { startLine, endLine } = span;
      // Índice desfasado: el símbolo ya no cabe o ya no está donde dice el span.
      if (startLine < 1 || endLine > lines.length || endLine < startLine) return chunk;
      const slice = lines.slice(startLine - 1, endLine);
      if (span.name !== "default" && !slice.some((line) => line.includes(span.name))) {
        return chunk;
      }

      const { text, truncated } = this.#capBody(slice, startLine, endLine);
      return {
        ...chunk,
        text,
        location: { filepath: span.filepath, startLine, endLine, truncated },
      };
    });
  }

  #readLines(filepath: string, cache: Map<string, string[] | null>): string[] | null {
    const cached = cache.get(filepath);
    if (cached !== undefined) return cached;
    let lines: string[] | null;
    try {
      lines = fs.readFileSync(filepath, "utf8").split("\n");
    } catch {
      lines = null; // archivo movido/borrado → fallback a firma
    }
    cache.set(filepath, lines);
    return lines;
  }

  #capBody(slice: string[], startLine: number, endLine: number): { text: string; truncated: boolean } {
    const { maxBodyLines, headLines, tailLines } = this.options;
    if (slice.length <= maxBodyLines) {
      return { text: slice.join("\n"), truncated: false };
    }
    const head = slice.slice(0, headLines);
    const tail = slice.slice(slice.length - tailLines);
    const omittedFrom = startLine + headLines;
    const omittedTo = endLine - tailLines;
    const ellipsis = `// … [${slice.length - headLines - tailLines} líneas omitidas: L${omittedFrom}–L${omittedTo}] …`;
    return { text: [...head, ellipsis, ...tail].join("\n"), truncated: true };
  }
}
