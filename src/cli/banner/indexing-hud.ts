/**
 * HUD (Heads-Up Display) animado para la indexación.
 *
 * Dibuja el perrito animado junto al wordmark "LaCoCo" y, debajo, una barra de
 * progreso en vivo. Se repinta *in situ* con secuencias ANSI.
 *
 * Contrato de seguridad:
 *   - SOLO se activa en un TTY interactivo. El stdout del CLI lo parsea el arnés
 *     de eval (AGENTS.md reserva stdout para salida máquina), así que el HUD
 *     dibuja en `process.stderr` y, cuando la salida está redirigida/CI/NO_COLOR,
 *     queda totalmente desactivado: cero escapes ANSI y el `console.log` normal
 *     sigue byte a byte como antes.
 *   - Los bucles de indexación son síncronos, por lo que el `setInterval` no
 *     puede repintar en medio; por eso `update()` fuerza un repintado síncrono
 *     (limitado por reloj) para que la barra avance aunque el sprite se congele.
 */
import { DOG_FRAMES, DOG_WIDTH } from "./dog-frames.js";
import { WORDMARK } from "./wordmark.js";
import { joinSideBySide, visibleWidth } from "./ansi.js";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";
const RESET = "\x1b[0m";
const YELLOW = "\x1b[38;2;255;216;9m";
const DIM = "\x1b[2m";

const GAP = 3;
const WORDMARK_WIDTH = WORDMARK.reduce((max, row) => Math.max(max, visibleWidth(row)), 0);
const BANNER_WIDTH = DOG_WIDTH + GAP + WORDMARK_WIDTH;
const BAR_WIDTH = 24;
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const UPDATE_REPAINT_MS = 50; // ~20 fps de tope para el repintado síncrono

export interface HudState {
  phase: string;
  current?: number;
  total?: number;
  detail?: string;
  nodes?: number;
  edges?: number;
}

export interface HudOptions {
  /** Flujo de salida; por defecto process.stderr. */
  stream?: NodeJS.WriteStream;
  /** Si el HUD está activo; por defecto se resuelve con resolveHudEnabled. */
  enabled?: boolean;
  /** Frames por segundo de la animación del sprite; por defecto 8. */
  fps?: number;
  /** Reloj inyectable (tests); por defecto Date.now. */
  now?: () => number;
}

export interface IndexingHud {
  start(initial?: Partial<HudState>): void;
  update(patch: Partial<HudState>): void;
  log(line: string): void;
  stop(summary?: string): void;
}

/**
 * Decide si el HUD debe animar. Falso si se pidió desactivar, si el entorno lo
 * inhibe (CI / NO_COLOR / LACOCO_NO_ANIMATION) o si el flujo no es un TTY.
 */
export function resolveHudEnabled(flagNoAnimation: boolean, stream: NodeJS.WriteStream): boolean {
  if (flagNoAnimation) return false;
  if (process.env.LACOCO_NO_ANIMATION || process.env.CI || process.env.NO_COLOR) return false;
  return stream.isTTY === true;
}

function renderBar(current: number, total: number): string {
  const ratio = total > 0 ? Math.min(1, Math.max(0, current / total)) : 0;
  const filled = Math.round(ratio * BAR_WIDTH);
  const pct = Math.round(ratio * 100);
  const bar = "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
  return `${YELLOW}[${bar}]${RESET} ${pct}%  (${current}/${total} archivos)`;
}

class ActiveHud implements IndexingHud {
  readonly #stream: NodeJS.WriteStream;
  readonly #fps: number;
  readonly #now: () => number;
  readonly #state: HudState = { phase: "" };
  #startedAt = 0;
  #lineCount = 0;
  #timer: NodeJS.Timeout | undefined;
  #lastPaint = 0;
  #stopped = false;
  #origLog: typeof console.log | undefined;
  #origError: typeof console.error | undefined;
  #exitHandler: (() => void) | undefined;

  constructor(stream: NodeJS.WriteStream, fps: number, now: () => number) {
    this.#stream = stream;
    this.#fps = fps;
    this.#now = now;
  }

  start(initial?: Partial<HudState>): void {
    if (initial) Object.assign(this.#state, initial);
    this.#startedAt = this.#now();
    this.#stream.write(HIDE_CURSOR);
    this.#captureConsole();
    this.#exitHandler = () => this.stop();
    process.once("exit", this.#exitHandler);
    process.once("SIGINT", this.#exitHandler);
    this.#paint();
    // El temporizador solo cubre los ratos en que el event loop está libre; el
    // frame se deriva del reloj (ver #currentFrame), así que el sprite también
    // avanza en los repintados síncronos de update() durante la indexación.
    this.#timer = setInterval(() => this.#paint(), Math.max(1, Math.round(1000 / this.#fps)));
    this.#timer.unref?.();
  }

  update(patch: Partial<HudState>): void {
    Object.assign(this.#state, patch);
    // Repintado síncrono (los bucles de indexación bloquean el event loop),
    // limitado por reloj para no saturar el terminal.
    const t = this.#now();
    if (t - this.#lastPaint >= UPDATE_REPAINT_MS) this.#paint();
  }

  log(line: string): void {
    if (this.#stopped) {
      this.#origLog?.(line);
      return;
    }
    this.#clearRegion();
    this.#stream.write(line + "\n");
    this.#paint();
  }

  stop(summary?: string): void {
    if (this.#stopped) return;
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#exitHandler) {
      process.removeListener("exit", this.#exitHandler);
      process.removeListener("SIGINT", this.#exitHandler);
    }
    this.#clearRegion();
    this.#stream.write(SHOW_CURSOR);
    this.#restoreConsole();
    if (summary) console.log(summary);
  }

  // --- interno ---

  #captureConsole(): void {
    // Guardamos la referencia tal cual (sin bind) para restaurar la identidad
    // exacta de console.log/console.error al terminar.
    this.#origLog = console.log;
    this.#origError = console.error;
    console.log = (...args: unknown[]) => this.log(args.map(String).join(" "));
    console.error = (...args: unknown[]) => this.log(args.map(String).join(" "));
  }

  #restoreConsole(): void {
    if (this.#origLog) console.log = this.#origLog;
    if (this.#origError) console.error = this.#origError;
    this.#origLog = undefined;
    this.#origError = undefined;
  }

  #clearRegion(): void {
    if (this.#lineCount > 0) {
      this.#stream.write(`\x1b[${this.#lineCount}A\x1b[0J`);
      this.#lineCount = 0;
    }
  }

  /** Índice de frame derivado del tiempo transcurrido (anima aunque el event
   *  loop esté bloqueado por el bucle síncrono de indexación). */
  #currentFrame(): number {
    const frameMs = Math.max(1, 1000 / this.#fps);
    const elapsed = Math.max(0, this.#now() - this.#startedAt);
    return Math.floor(elapsed / frameMs) % DOG_FRAMES.length;
  }

  #buildLines(): string[] {
    const frame = this.#currentFrame();
    const dog = [...DOG_FRAMES[frame]!];
    const wide = this.#fitsSideBySide();
    const banner = wide ? joinSideBySide(dog, [...WORDMARK], GAP) : dog;

    const { phase, current, total, detail, nodes, edges } = this.#state;
    let progress: string;
    if (typeof current === "number" && typeof total === "number" && total > 0) {
      progress = `${renderBar(current, total)}  ${DIM}${phase}${RESET}`;
    } else {
      const spin = SPINNER[frame % SPINNER.length]!;
      progress = `${YELLOW}${spin}${RESET} ${phase}`;
    }
    const counters: string[] = [];
    if (typeof nodes === "number") counters.push(`nodos: ${nodes}`);
    if (typeof edges === "number") counters.push(`aristas: ${edges}`);
    if (detail) counters.push(detail);

    // Siempre 15 líneas (banner + separador + progreso + contadores), aunque los
    // contadores estén vacíos: un recuento fijo permite repintar en el sitio sin
    // borrar toda la región (evita el parpadeo).
    return [
      ...banner,
      "",
      this.#truncate(progress),
      this.#truncate(counters.length > 0 ? `${DIM}${counters.join("   ")}${RESET}` : ""),
    ];
  }

  /**
   * Repinta en el sitio: sube al inicio de la región y sobrescribe cada línea
   * con `\x1b[K` (borra el resto de la línea). No usa `\x1b[0J` (borrado de toda
   * la pantalla), que es lo que producía el destello en cada frame.
   */
  #paint(): void {
    if (this.#stopped) return;
    const lines = this.#buildLines();
    let out = "";
    if (this.#lineCount > 0) out += `\x1b[${this.#lineCount}A`;
    for (let i = 0; i < lines.length; i++) {
      out += lines[i] + "\x1b[K";
      if (i < lines.length - 1) out += "\n";
    }
    out += "\n"; // deja el cursor en la línea siguiente a la región
    this.#stream.write(out);
    this.#lineCount = lines.length;
    this.#lastPaint = this.#now();
  }

  #fitsSideBySide(): boolean {
    const cols = this.#stream.columns;
    return typeof cols !== "number" || cols >= BANNER_WIDTH;
  }

  #truncate(line: string): string {
    const cols = this.#stream.columns;
    if (typeof cols !== "number" || visibleWidth(line) <= cols) return line;
    // Truncado consciente de SGR: recorta por caracteres visibles.
    let out = "";
    let width = 0;
    let i = 0;
    while (i < line.length && width < cols) {
      if (line[i] === "\x1b") {
        const end = line.indexOf("m", i);
        if (end !== -1) {
          out += line.slice(i, end + 1);
          i = end + 1;
          continue;
        }
      }
      out += line[i];
      width++;
      i++;
    }
    return out + RESET;
  }
}

/** HUD inerte para modo no-TTY: nunca emite escapes ni toca console. */
class DisabledHud implements IndexingHud {
  start(): void {
    /* no-op */
  }
  update(): void {
    /* no-op: sin spam por-archivo en salida no interactiva */
  }
  log(line: string): void {
    console.log(line);
  }
  stop(summary?: string): void {
    if (summary) console.log(summary);
  }
}

export function createIndexingHud(opts: HudOptions = {}): IndexingHud {
  const stream = opts.stream ?? process.stderr;
  const enabled = opts.enabled ?? resolveHudEnabled(false, stream);
  if (!enabled) return new DisabledHud();
  return new ActiveHud(stream, opts.fps ?? 12, opts.now ?? Date.now);
}
