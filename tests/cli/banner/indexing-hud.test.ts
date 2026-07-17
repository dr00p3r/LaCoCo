import { afterEach, describe, expect, it, vi } from "vitest";
import { createIndexingHud, resolveHudEnabled } from "../../../src/cli/banner/indexing-hud.js";
import { DOG_FRAMES, DOG_HEIGHT, DOG_WIDTH } from "../../../src/cli/banner/dog-frames.js";
import { WORDMARK } from "../../../src/cli/banner/wordmark.js";
import { visibleWidth } from "../../../src/cli/banner/ansi.js";

function makeStream(overrides: Partial<NodeJS.WriteStream> = {}): {
  stream: NodeJS.WriteStream;
  writes: () => string;
  clear: () => void;
} {
  const write = vi.fn();
  const stream = { isTTY: true, columns: 200, write } as unknown as NodeJS.WriteStream;
  Object.assign(stream, overrides);
  return {
    stream,
    writes: () => write.mock.calls.map((c) => String(c[0])).join(""),
    clear: () => write.mockClear(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("assets del banner", () => {
  it("el perrito tiene 6 frames de DOG_HEIGHT filas y DOG_WIDTH columnas visibles", () => {
    expect(DOG_FRAMES).toHaveLength(6);
    for (const frame of DOG_FRAMES) {
      expect(frame).toHaveLength(DOG_HEIGHT);
      for (const row of frame) expect(visibleWidth(row)).toBe(DOG_WIDTH);
    }
  });

  it("el wordmark tiene la misma altura que el perrito", () => {
    expect(WORDMARK).toHaveLength(DOG_HEIGHT);
  });
});

describe("resolveHudEnabled", () => {
  it("es falso si se pide desactivar, o si no es TTY", () => {
    const tty = { isTTY: true } as unknown as NodeJS.WriteStream;
    const notTty = { isTTY: false } as unknown as NodeJS.WriteStream;
    expect(resolveHudEnabled(true, tty)).toBe(false);
    expect(resolveHudEnabled(false, notTty)).toBe(false);
  });

  it("respeta NO_COLOR / CI / LACOCO_NO_ANIMATION", () => {
    const tty = { isTTY: true } as unknown as NodeJS.WriteStream;
    vi.stubEnv("CI", "");
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("LACOCO_NO_ANIMATION", "");
    expect(resolveHudEnabled(false, tty)).toBe(true);

    vi.stubEnv("LACOCO_NO_ANIMATION", "1");
    expect(resolveHudEnabled(false, tty)).toBe(false);
    vi.stubEnv("LACOCO_NO_ANIMATION", "");
    vi.stubEnv("NO_COLOR", "1");
    expect(resolveHudEnabled(false, tty)).toBe(false);
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("CI", "1");
    expect(resolveHudEnabled(false, tty)).toBe(false);
  });
});

describe("HUD activo (TTY simulado)", () => {
  it("start oculta el cursor, pinta el banner y captura console", () => {
    const { stream, writes } = makeStream();
    const origLog = console.log;
    const hud = createIndexingHud({ stream, enabled: true, now: () => 0 });
    hud.start({ phase: "Indexando" });

    expect(writes()).toContain("\x1b[?25l"); // cursor oculto
    expect(writes()).toContain("▀"); // arte del perrito
    expect(console.log).not.toBe(origLog); // console capturado

    hud.stop();
    expect(console.log).toBe(origLog); // console restaurado
  });

  it("update repinta la barra con porcentaje y contadores correctos", () => {
    let now = 0;
    const { stream, writes, clear } = makeStream();
    const hud = createIndexingHud({ stream, enabled: true, now: () => now });
    hud.start({ phase: "Idx" });
    clear();

    now = 100; // supera el throttle de 50ms => repinta síncronamente
    hud.update({ current: 5, total: 10, nodes: 3, edges: 7 });

    const out = writes();
    expect(out).toContain("50%");
    expect(out).toContain("(5/10 archivos)");
    expect(out).toContain("nodos: 3");
    expect(out).toContain("aristas: 7");

    hud.stop();
  });

  it("anima los frames de forma cíclica según el reloj", () => {
    vi.useFakeTimers();
    let clock = 0;
    const { stream, writes, clear } = makeStream();
    const hud = createIndexingHud({ stream, enabled: true, fps: 8, now: () => clock });
    hud.start();

    const blocks: string[] = [];
    for (let i = 0; i < DOG_FRAMES.length + 1; i++) {
      clear();
      clock += 125; // 1000/8: un frame por tick
      vi.advanceTimersByTime(125);
      blocks.push(writes());
    }
    // El frame vuelve a empezar tras DOG_FRAMES.length ticks.
    expect(blocks[0]).toBe(blocks[DOG_FRAMES.length]);
    // Y hay más de un frame distinto (realmente anima).
    expect(new Set(blocks).size).toBeGreaterThan(1);

    hud.stop();
  });

  it("log imprime una línea permanente y vuelve a pintar debajo", () => {
    const { stream, writes, clear } = makeStream();
    const hud = createIndexingHud({ stream, enabled: true, now: () => 0 });
    hud.start({ phase: "P" });
    clear();

    hud.log("LINEA-PERMANENTE");
    const out = writes();
    expect(out).toContain("LINEA-PERMANENTE\n");
    expect(out).toContain("▀"); // re-render del banner

    hud.stop();
  });

  it("stop muestra el cursor, imprime el resumen y es idempotente", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { stream, writes } = makeStream();
    const hud = createIndexingHud({ stream, enabled: true, now: () => 0 });
    hud.start();
    hud.stop("RESUMEN-FINAL");

    expect(writes()).toContain("\x1b[?25h"); // cursor mostrado
    expect(logSpy).toHaveBeenCalledWith("RESUMEN-FINAL");

    // Segunda llamada: no lanza ni repite.
    logSpy.mockClear();
    expect(() => hud.stop("OTRO")).not.toThrow();
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("con terminal estrecho muestra solo el perrito (sin wordmark)", () => {
    const { stream, writes } = makeStream({ columns: 30 } as Partial<NodeJS.WriteStream>);
    const hud = createIndexingHud({ stream, enabled: true, now: () => 0 });
    hud.start({ phase: "X" });
    // El primer bloque no debe exceder el ancho del perrito + margen del progreso.
    const bannerLines = writes()
      .split("\n")
      .filter((l) => l.includes("▀"));
    for (const line of bannerLines) expect(visibleWidth(line)).toBeLessThanOrEqual(DOG_WIDTH);
    hud.stop();
  });
});

describe("HUD inerte (no TTY)", () => {
  it("no emite escapes; log y stop pasan por console.log", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { stream, writes } = makeStream({ isTTY: false } as Partial<NodeJS.WriteStream>);
    const hud = createIndexingHud({ stream }); // enabled se resuelve a false

    hud.start({ phase: "x" });
    hud.update({ current: 1, total: 2 });
    hud.log("LINE");
    hud.stop("SUM");

    expect(writes()).toBe(""); // nunca escribió al stream
    expect(logSpy).toHaveBeenCalledWith("LINE");
    expect(logSpy).toHaveBeenCalledWith("SUM");
  });
});
