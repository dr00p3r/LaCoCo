/**
 * Primitivas de terminal conscientes de SGR (Select Graphic Rendition).
 *
 * El arte del banner mezcla texto visible con secuencias de color truecolor
 * (`\x1b[38;2;r;g;bm`, `\x1b[0m`, …) que NO ocupan columnas en pantalla. Para
 * componer el perrito y el wordmark uno al lado del otro hay que medir y
 * rellenar por el ancho *visible*, ignorando esos códigos.
 */

/**
 * Coincide con cualquier secuencia CSI (`\x1b[…<letra>`): color SGR (`m`),
 * borrado (`K`/`J`), movimientos de cursor (`A`/`H`), mostrar/ocultar (`h`/`l`)…
 * Todas ocupan 0 columnas en pantalla.
 */
export const STRIP_SGR = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** Ancho en columnas de una cadena, descontando las secuencias de control. */
export function visibleWidth(text: string): number {
  return text.replace(STRIP_SGR, "").length;
}

/**
 * Rellena `text` con espacios a la derecha hasta ocupar `width` columnas
 * visibles. Si ya es igual o más ancho, se devuelve tal cual. El relleno son
 * espacios planos (sin color), por lo que nunca arrastra el color previo.
 */
export function padVisible(text: string, width: number): string {
  const pad = width - visibleWidth(text);
  return pad > 0 ? text + " ".repeat(pad) : text;
}

/**
 * Une dos bloques de texto (arrays de filas) lado a lado, fila por fila.
 *
 * Cada fila del bloque izquierdo se rellena al ancho visible máximo de ese
 * bloque más `gap` columnas de separación, de modo que el bloque derecho
 * quede alineado en una columna fija aunque las filas izquierdas tengan
 * distinto ancho visible. Si los bloques tienen distinta altura, se rellenan
 * con filas en blanco hasta la altura mayor.
 */
export function joinSideBySide(left: string[], right: string[], gap: number): string[] {
  const leftWidth = left.reduce((max, row) => Math.max(max, visibleWidth(row)), 0);
  const target = leftWidth + Math.max(0, gap);
  const height = Math.max(left.length, right.length);

  const rows: string[] = [];
  for (let i = 0; i < height; i++) {
    const leftRow = left[i] ?? "";
    const rightRow = right[i] ?? "";
    rows.push(padVisible(leftRow, target) + rightRow);
  }
  return rows;
}
