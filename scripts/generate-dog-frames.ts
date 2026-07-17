/**
 * Generador (build-time) del arte ANSI del banner de indexación.
 *
 * Convierte los assets PNG de `animation/` en módulos TypeScript commiteados
 * con las filas half-block ya calculadas, de modo que el runtime del CLI NO
 * necesite ningún decodificador de imágenes ni dependencia de terminal:
 *
 *   - `animation/Perrito1..6.png` (19×24, 6 frames) → `src/cli/banner/dog-frames.ts`
 *   - `animation/wordmark.png`    (72×24)           → `src/cli/banner/wordmark.ts`
 *
 * Se ejecuta manualmente (`pnpm gen:frames`), NO forma parte de `pnpm build`.
 * `pngjs` es una devDependency usada solo aquí.
 *
 * El wordmark PNG se produjo una vez renderizando el texto "LaCoCo" con la
 * fuente Noto Sans Condensed Bold en amarillo (255,216,9) y recortándolo,
 * centrado en un lienzo de 24 px de alto para igualar la altura del perrito.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import { pixelsToHalfBlockRows, type Rgba } from "../src/cli/banner/half-block.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const ANIMATION_DIR = resolve(ROOT, "animation");
const BANNER_DIR = resolve(ROOT, "src", "cli", "banner");

const DOG_FRAME_COUNT = 6;
const DOG_EXPECTED_WIDTH = 19;
const DOG_EXPECTED_HEIGHT = 24;

interface Decoded {
  rows: string[];
  width: number;
  height: number;
}

function decodePngToRows(path: string, expected?: { width: number; height: number }): Decoded {
  const png = PNG.sync.read(readFileSync(path));
  const { width, height, data } = png;
  if (expected && (width !== expected.width || height !== expected.height)) {
    throw new Error(
      `${path}: dimensiones ${width}×${height}, se esperaban ${expected.width}×${expected.height}`,
    );
  }
  const pixels: Rgba[] = [];
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    pixels.push({ r: data[o]!, g: data[o + 1]!, b: data[o + 2]!, a: data[o + 3]! });
  }
  return { rows: pixelsToHalfBlockRows(pixels, width, height), width, height };
}

function toLiteral(rows: string[]): string {
  return rows.map((row) => JSON.stringify(row)).join(",\n    ");
}

// --- Perrito (6 frames animados) ---
const frames: string[][] = [];
for (let n = 1; n <= DOG_FRAME_COUNT; n++) {
  const { rows } = decodePngToRows(resolve(ANIMATION_DIR, `Perrito${n}.png`), {
    width: DOG_EXPECTED_WIDTH,
    height: DOG_EXPECTED_HEIGHT,
  });
  frames.push(rows);
}
const dogHeight = frames[0]!.length;
const dogFramesLiteral = frames
  .map((rows) => `  [\n    ${toLiteral(rows)},\n  ]`)
  .join(",\n");

const dogModule = `// GENERADO por scripts/generate-dog-frames.ts — no editar a mano.
// Fuente: animation/Perrito1..6.png. Regenerar con \`pnpm gen:frames\`.

export const DOG_WIDTH = ${DOG_EXPECTED_WIDTH};
export const DOG_HEIGHT = ${dogHeight};

/** 6 frames del perrito; cada frame es un array de ${dogHeight} filas ANSI. */
export const DOG_FRAMES: readonly (readonly string[])[] = [
${dogFramesLiteral},
];
`;
writeFileSync(resolve(BANNER_DIR, "dog-frames.ts"), dogModule, "utf-8");

// --- Wordmark "LaCoCo" ---
const wordmark = decodePngToRows(resolve(ANIMATION_DIR, "wordmark.png"));
const wordmarkModule = `// GENERADO por scripts/generate-dog-frames.ts — no editar a mano.
// Fuente: animation/wordmark.png (texto "LaCoCo", Noto Sans Condensed Bold,
// amarillo 255,216,9, centrado en 24px). Regenerar con \`pnpm gen:frames\`.

export const WORDMARK_HEIGHT = ${wordmark.rows.length};

/** Wordmark "LaCoCo" en arte half-block, ${wordmark.rows.length} filas. */
export const WORDMARK: readonly string[] = [
  ${toLiteral(wordmark.rows)},
];
`;
writeFileSync(resolve(BANNER_DIR, "wordmark.ts"), wordmarkModule, "utf-8");

console.log(
  `[gen:frames] dog-frames.ts (${frames.length} frames × ${dogHeight} filas) + ` +
    `wordmark.ts (${wordmark.rows.length} filas) escritos en src/cli/banner/`,
);
