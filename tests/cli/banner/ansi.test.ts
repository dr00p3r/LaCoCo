import { describe, expect, it } from "vitest";
import { joinSideBySide, padVisible, visibleWidth } from "../../../src/cli/banner/ansi.js";

const RED = "\x1b[38;2;255;0;0m";
const RESET = "\x1b[0m";

describe("visibleWidth", () => {
  it("cuenta solo los caracteres visibles, ignorando SGR", () => {
    expect(visibleWidth("abc")).toBe(3);
    expect(visibleWidth(`${RED}abc${RESET}`)).toBe(3);
    expect(visibleWidth(`${RED}${RESET}`)).toBe(0);
  });

  it("ignora fondo y frente truecolor combinados", () => {
    expect(visibleWidth("\x1b[38;2;1;2;3m\x1b[48;2;4;5;6m▀\x1b[0m")).toBe(1);
  });
});

describe("padVisible", () => {
  it("rellena con espacios planos hasta el ancho visible", () => {
    expect(padVisible("ab", 5)).toBe("ab   ");
    expect(padVisible(`${RED}ab${RESET}`, 5)).toBe(`${RED}ab${RESET}   `);
  });

  it("no recorta si ya es igual o más ancho", () => {
    expect(padVisible("abcde", 3)).toBe("abcde");
  });
});

describe("joinSideBySide", () => {
  it("alinea el bloque derecho en una columna fija según el ancho visible", () => {
    const rows = joinSideBySide([`${RED}x${RESET}`, "yy"], ["A", "B"], 2);
    // izquierda ancho visible máx = 2; gap 2 => bloque derecho arranca en col 4
    expect(visibleWidth(rows[0]!)).toBe(5); // "x" + 3 espacios + "A"
    expect(rows[0]!.endsWith("A")).toBe(true);
    expect(rows[1]).toBe("yy  B");
  });

  it("rellena con filas en blanco cuando las alturas difieren", () => {
    const rows = joinSideBySide(["a"], ["A", "B", "C"], 1);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toBe("a A");
    expect(rows[1]).toBe("  B"); // fila izquierda vacía rellenada
    expect(rows[2]).toBe("  C");
  });
});
