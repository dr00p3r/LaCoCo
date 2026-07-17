import { describe, expect, it } from "vitest";
import { pixelsToHalfBlockRows, type Rgba } from "../../../src/cli/banner/half-block.js";

const RESET = "\x1b[0m";
const RED: Rgba = { r: 255, g: 0, b: 0, a: 255 };
const BLUE: Rgba = { r: 0, g: 0, b: 255, a: 255 };
const GREEN: Rgba = { r: 0, g: 255, b: 0, a: 255 };
const CLEAR: Rgba = { r: 0, g: 0, b: 0, a: 0 };

describe("pixelsToHalfBlockRows", () => {
  it("empareja píxel superior (frente) e inferior (fondo) con ▀", () => {
    // 2×2: [ROJO, CLARO / AZUL, VERDE]
    const rows = pixelsToHalfBlockRows([RED, CLEAR, BLUE, GREEN], 2, 2);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toBe(
      `\x1b[38;2;255;0;0m\x1b[48;2;0;0;255m▀${RESET}` + // col0: rojo sobre azul
        `\x1b[38;2;0;255;0m▄${RESET}`, // col1: solo abajo (verde) => ▄
    );
  });

  it("usa ▀ con solo frente cuando el inferior es transparente", () => {
    const rows = pixelsToHalfBlockRows([RED, CLEAR], 1, 2);
    expect(rows[0]).toBe(`\x1b[38;2;255;0;0m▀${RESET}`);
  });

  it("emite espacio cuando ambos píxeles son transparentes", () => {
    const rows = pixelsToHalfBlockRows([CLEAR, CLEAR], 1, 2);
    expect(rows[0]).toBe(" ");
  });

  it("produce ceil(height/2) filas", () => {
    const px = Array.from({ length: 3 * 4 }, () => RED);
    const rows = pixelsToHalfBlockRows(px, 3, 4);
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      // 3 columnas, cada una un carácter visible
      expect(row.replace(/\x1b\[[0-9;]*m/g, "")).toHaveLength(3);
    }
  });

  it("rechaza buffers de tamaño incorrecto", () => {
    expect(() => pixelsToHalfBlockRows([RED], 2, 2)).toThrow(/se esperaban 4/);
  });
});
