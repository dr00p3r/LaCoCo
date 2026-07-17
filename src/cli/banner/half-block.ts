/**
 * Conversión de un mapa de píxeles RGBA a arte ANSI usando "half-blocks".
 *
 * Cada celda de terminal representa DOS píxeles verticales: el carácter `▀`
 * (medio bloque superior) pinta el píxel de arriba con el color de *frente* y
 * el de abajo con el color de *fondo*. Así una imagen de N filas cabe en N/2
 * filas de texto conservando la relación de aspecto (las celdas de terminal
 * son ~2× más altas que anchas). Los píxeles transparentes (`a === 0`) se
 * dejan como espacio para que el fondo del terminal se transparente.
 */

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const RESET = "\x1b[0m";

function fg({ r, g, b }: Rgba): string {
  return `\x1b[38;2;${r};${g};${b}m`;
}

function bg({ r, g, b }: Rgba): string {
  return `\x1b[48;2;${r};${g};${b}m`;
}

/**
 * Convierte un buffer RGBA row-major (`width`×`height`) en `ceil(height/2)`
 * filas de texto ANSI. Cada fila resultante termina en `\x1b[0m`.
 *
 * `pixels` debe contener exactamente `width * height` elementos. Un píxel con
 * `a === 0` se considera transparente.
 */
export function pixelsToHalfBlockRows(pixels: Rgba[], width: number, height: number): string[] {
  if (pixels.length !== width * height) {
    throw new Error(
      `pixelsToHalfBlockRows: se esperaban ${width * height} píxeles (${width}×${height}), llegaron ${pixels.length}`,
    );
  }

  const at = (x: number, y: number): Rgba => pixels[y * width + x]!;
  const rows: string[] = [];

  for (let y = 0; y < height; y += 2) {
    let line = "";
    for (let x = 0; x < width; x++) {
      const top = at(x, y);
      const bottom = y + 1 < height ? at(x, y + 1) : { r: 0, g: 0, b: 0, a: 0 };
      const topVisible = top.a > 0;
      const bottomVisible = bottom.a > 0;

      if (!topVisible && !bottomVisible) {
        line += " ";
      } else if (topVisible && bottomVisible) {
        line += fg(top) + bg(bottom) + "▀" + RESET;
      } else if (topVisible) {
        line += fg(top) + "▀" + RESET;
      } else {
        line += fg(bottom) + "▄" + RESET;
      }
    }
    rows.push(line);
  }

  return rows;
}
