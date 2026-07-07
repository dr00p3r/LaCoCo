/**
 * Parser/clasificador del `test_command` de SWE-PolyBench → estructura local.
 *
 * Cada instancia trae un `test_command` pensado para el harness Docker oficial,
 * con la forma:
 *
 *     . /usr/local/nvm/nvm.sh && nvm use 16.20.2 && \
 *       npm pkg set scripts.lint="echo noop" && \
 *       yarn cross-env NODE_ENV=test mocha <archivo> --reporter /testbed/custom-reporter.js --exit
 *
 * Este módulo NO ejecuta nada: descompone el comando en una estructura
 * verificable (versión de Node, runner, reporter, archivos objetivo, si es
 * "bespoke"), para que:
 *   1. El loader de instancias registre metadata de test por instancia.
 *   2. El runner local (paso posterior, requiere el repo clonado) sintetice el
 *      comando real a partir de esta estructura + los ids de `F2P`.
 *
 * Por qué parser y no sintetizador directo: el string de ejecución local no se
 * puede *validar* sin el repo checked-out (deps, scripts de package.json, rutas).
 * Clasificar es correcto y verificable ahora; sintetizar-y-correr es del runner.
 *
 * Taxonomía observada (200 instancias, SWE-PolyBench_Verified TS/JS):
 *   - mocha       (mui, serverless)          — 103
 *   - npm-script  (svelte, three.js)         —  50   (delega en el runner del repo)
 *   - yarn-script (prettier, code-server)    —  20
 *   - jest        (tailwindcss)              —   3
 *   - bespoke     (vscode scripts/test.sh,   —  24
 *                  angular bazel)                    NO ejecutable sin su toolchain
 */

/** Runner de pruebas detectado en el comando. */
export type TestRunner =
  | "mocha"
  | "jest"
  | "vitest"
  | "npm-script"
  | "yarn-script"
  | "bespoke";

/** Estilo de reporter de resultados. */
export type TestReporter = "json" | "custom-reporter" | "default";

/** Descomposición estructurada de un `test_command`. */
export interface ParsedTestCommand {
  /** Comando original, sin tocar. */
  readonly raw: string;
  /** Comando tras quitar el prefijo Docker (nvm + lint-noop). */
  readonly tail: string;
  /** Versión de Node fijada por `nvm use`, o `null` si no se fija. */
  readonly nodeVersion: string | null;
  /** Gestor de paquetes que invoca al runner (`npm`/`yarn`/`npx`), o `null`. */
  readonly packageManager: "npm" | "yarn" | "npx" | null;
  /** Runner detectado. */
  readonly runner: TestRunner;
  /** Para runners que delegan: nombre del script (`test`, `test:unit`, …). */
  readonly scriptName: string | null;
  /** Reporter solicitado. */
  readonly reporter: TestReporter;
  /** `true` si usa `/testbed/custom-reporter.js` (inexistente localmente). */
  readonly usesCustomReporter: boolean;
  /** Archivos/globs de prueba pasados explícitamente al runner. */
  readonly testTargets: string[];
  /** `true` si no es ejecutable localmente sin su toolchain (bazel, test.sh). */
  readonly bespoke: boolean;
  /** Motivo del bespoke (solo presente cuando `bespoke` es `true`). */
  readonly bespokeReason?: string;
}

/** Un id de prueba de `F2P` descompuesto en archivo (si viene) y título. */
export interface ParsedTestId {
  /** Archivo de prueba repo-relativo (sin el prefijo Docker `/testbed/`), o `null`. */
  readonly file: string | null;
  /** Título del test (parte tras `->`, o el id completo si no hay `->`). */
  readonly title: string;
  /** Id original. */
  readonly raw: string;
}

const NVM_PREFIX_RE = /^\.\s+\/usr\/local\/nvm\/nvm\.sh\s+&&\s+/;
const NVM_USE_RE = /nvm use ([\d.]+)/;
const LINT_NOOP_RE = /npm pkg set scripts\.lint="echo noop"\s+&&\s+/;
const CUSTOM_REPORTER = "/testbed/custom-reporter.js";
const TESTBED_PREFIX = "/testbed/";

/** Quita el prefijo Docker (nvm.sh, `nvm use`, lint-noop) y devuelve la cola. */
function stripDockerPrefix(cmd: string): string {
  let tail = cmd.replace(NVM_PREFIX_RE, "");
  tail = tail.replace(new RegExp(`^${NVM_USE_RE.source}\\s+&&\\s+`), "");
  tail = tail.replace(LINT_NOOP_RE, "");
  return tail.trim();
}

/** Detecta el reporter a partir del comando completo. */
function detectReporter(cmd: string): { reporter: TestReporter; custom: boolean } {
  if (cmd.includes(CUSTOM_REPORTER)) return { reporter: "custom-reporter", custom: true };
  if (/--reporter[= ]json\b|--json\b/.test(cmd)) return { reporter: "json", custom: false };
  return { reporter: "default", custom: false };
}

/** Heurística: ¿un token parece un archivo/glob de prueba (no una bandera)? */
function looksLikeTarget(token: string): boolean {
  if (token.startsWith("-")) return false;
  if (token.includes("=")) return false;
  return token.includes("/") || /\.(m?[jt]sx?|snap)$/.test(token);
}

/** Extrae los archivos/globs de prueba pasados al runner en la cola. */
function extractTargets(tail: string): string[] {
  const tokens = tail.split(/\s+/);
  const targets: string[] = [];
  for (const tok of tokens) {
    if (looksLikeTarget(tok) && !tok.includes("custom-reporter.js")) {
      targets.push(tok.replace(new RegExp(`^${TESTBED_PREFIX}`), ""));
    }
  }
  return targets;
}

/** Detecta el gestor de paquetes que invoca al runner en la cola. */
function detectPackageManager(tail: string): "npm" | "yarn" | "npx" | null {
  if (/\bnpx\b/.test(tail)) return "npx";
  if (/\byarn\b/.test(tail)) return "yarn";
  if (/\bnpm\b/.test(tail)) return "npm";
  return null;
}

/** Extrae el nombre de script para runners que delegan (`npm run <x>`/`yarn <x>`). */
function detectScriptName(tail: string): string | null {
  const npmRun = tail.match(/\bnpm run ([\w:-]+)/);
  if (npmRun) return npmRun[1]!;
  if (/\bnpm test\b/.test(tail)) return "test";
  const yarnScript = tail.match(/\byarn (?:run )?([\w:-]+)/);
  if (yarnScript && yarnScript[1] !== "cross-env") return yarnScript[1]!;
  return null;
}

/**
 * Descompone un `test_command` en estructura. Nunca lanza: los comandos no
 * reconocidos caen a `runner: "bespoke"` con su motivo.
 */
export function parseTestCommand(raw: string): ParsedTestCommand {
  const nodeVersion = raw.match(NVM_USE_RE)?.[1] ?? null;
  const tail = stripDockerPrefix(raw);
  const { reporter, custom } = detectReporter(raw);
  const packageManager = detectPackageManager(tail);
  const testTargets = extractTargets(tail);

  const base = {
    raw,
    tail,
    nodeVersion,
    packageManager,
    reporter,
    usesCustomReporter: custom,
    testTargets,
  };

  // Bespoke: requieren toolchain propia y no se corren con un runner estándar.
  if (/\bbazel\b/.test(tail)) {
    return { ...base, runner: "bespoke", scriptName: null, bespoke: true, bespokeReason: "bazel" };
  }
  if (tail.includes("scripts/test.sh")) {
    return {
      ...base,
      runner: "bespoke",
      scriptName: null,
      bespoke: true,
      bespokeReason: "vscode-test-sh",
    };
  }

  // Runners directos (el binario aparece explícito en la cola).
  if (/\bmocha\b/.test(tail)) {
    return { ...base, runner: "mocha", scriptName: null, bespoke: false };
  }
  if (/\bvitest\b/.test(tail)) {
    return { ...base, runner: "vitest", scriptName: null, bespoke: false };
  }
  if (/\bjest\b/.test(tail)) {
    return { ...base, runner: "jest", scriptName: null, bespoke: false };
  }

  // Runners que delegan en un script de package.json.
  const scriptName = detectScriptName(tail);
  if (/\bnpm (run |test\b)/.test(tail)) {
    return { ...base, runner: "npm-script", scriptName, bespoke: false };
  }
  if (/\byarn\b/.test(tail)) {
    return { ...base, runner: "yarn-script", scriptName, bespoke: false };
  }

  return {
    ...base,
    runner: "bespoke",
    scriptName: null,
    bespoke: true,
    bespokeReason: "unrecognized",
  };
}

/**
 * Descompone un id de prueba de `F2P` en archivo (si el id lo incluye antes de
 * `->`) y título. Los formatos observados son `<file>-><title>` (code-server,
 * mui, prettier, tailwind) y `<title-anidado>` sin archivo (three.js/qunit,
 * serverless/mocha, svelte, vscode). El prefijo Docker `/testbed/` se retira.
 */
export function parseF2pTestId(raw: string): ParsedTestId {
  const arrow = raw.indexOf("->");
  if (arrow === -1) return { file: null, title: raw.trim(), raw };
  const file = raw.slice(0, arrow).replace(new RegExp(`^${TESTBED_PREFIX}`), "").trim();
  const title = raw.slice(arrow + 2).trim();
  return { file: file === "" ? null : file, title, raw };
}

/** Resultado de intentar sintetizar un comando local. */
export interface LocalTestCommand {
  /** Comando local, o `null` si el runner es bespoke. */
  readonly command: string | null;
  /** `true` si se produjo un comando ejecutable localmente. */
  readonly runnable: boolean;
  /** `true` si se reemplazó `custom-reporter.js` por un reporter local. */
  readonly reporterReplaced: boolean;
  /** Motivo cuando no es ejecutable. */
  readonly reason?: string;
}

/**
 * Best-effort: sintetiza un comando local a partir de la estructura parseada.
 * Se limita a lo verificablemente correcto sin el repo: quita el prefijo Docker
 * y reemplaza `custom-reporter.js` por un reporter local. NO inventa patrones
 * `--grep`/`-t` de F2P (eso lo hace el runner con el repo presente, usando
 * {@link parseF2pTestId}); preserva los archivos objetivo que ya venían.
 *
 * @param localReporter reporter local con el que sustituir el custom (def. `json`).
 */
export function toLocalTestCommand(
  parsed: ParsedTestCommand,
  localReporter = "json",
): LocalTestCommand {
  if (parsed.bespoke) {
    return {
      command: null,
      runnable: false,
      reporterReplaced: false,
      reason: `bespoke:${parsed.bespokeReason}`,
    };
  }

  let command = parsed.tail;
  let reporterReplaced = false;
  if (parsed.usesCustomReporter) {
    command = command.replaceAll(CUSTOM_REPORTER, localReporter);
    reporterReplaced = true;
  }
  // Retira referencias absolutas al sandbox Docker en los objetivos.
  command = command.replaceAll(TESTBED_PREFIX, "");

  return { command, runnable: true, reporterReplaced };
}
