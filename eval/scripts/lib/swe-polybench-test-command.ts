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

/**
 * Runner CONCRETO ejecutable localmente. A diferencia de {@link TestRunner}, no
 * incluye los delegadores `npm-script`/`yarn-script`: esos se resuelven al binario
 * real (mocha/jest/vitest) inspeccionando el `package.json` del repo checked-out.
 */
export type ConcreteRunner = "mocha" | "jest" | "vitest";

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
 * Resuelve el runner CONCRETO ejecutable a partir del `test_command` parseado y,
 * cuando este delega (`npm-script`/`yarn-script`), del cuerpo del script delegado
 * (`scripts[scriptName]`) leído del `package.json` del repo checked-out.
 *
 * Por qué leer el repo y no un mapeo estático per-repo: el runner delegado puede
 * variar entre refs del mismo repo (p.ej. prettier migró de mocha a jest), y un
 * mapeo manual se desactualiza. Los runners directos (mocha/jest/vitest) ya traen
 * el binario explícito y se devuelven tal cual.
 *
 * Fallback a `"mocha"` cuando el cuerpo no está disponible o no se reconoce: es el
 * comportamiento histórico que mantiene verde a svelte (cuyo `scripts.test` corre
 * mocha y cuyo cuerpo puede no leerse). `bespoke` → `null`.
 */
export function resolveConcreteRunner(
  parsed: ParsedTestCommand,
  scriptBody: string | null,
): ConcreteRunner | null {
  if (parsed.runner === "mocha" || parsed.runner === "jest" || parsed.runner === "vitest") {
    return parsed.runner;
  }
  if (parsed.runner === "npm-script" || parsed.runner === "yarn-script") {
    if (scriptBody !== null) {
      if (/\bjest\b/.test(scriptBody)) return "jest";
      if (/\bvitest\b/.test(scriptBody)) return "vitest";
      if (/\bmocha\b/.test(scriptBody)) return "mocha";
    }
    return "mocha"; // fallback compatible con svelte (scripts.test → mocha)
  }
  return null; // bespoke
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

/** Escapa los metacaracteres de regex para usar el texto como patrón literal. */
function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Variantes de sufijo/prefijo que NO forman parte del nombre del fixture. */
const F2P_VARIANT_TOKENS = new Set(["shared", "inline", "helpers", "with", "hydration", "runtime"]);

/**
 * Extrae el "slug de fixture" de un título F2P para usarlo como patrón `--grep`.
 *
 * Los formatos de F2P son inconsistentes entre versiones de un mismo repo
 * (verificado en svelte: v2 mocha3 usa bag-of-words `"runtime shared helpers
 * each-block-dynamic-else-static"`; v3 mocha5 usa el canónico `"runtime
 * <fixture> (with hydration)"`). En ambos, el nombre del fixture es el token
 * hifenado más largo, que aparece verbatim como directorio de sample y como
 * parte del `fullTitle` real de mocha. Grepear ese slug matchea TODAS sus
 * variantes (shared/inline/hydration) — justo lo que pide el F2P.
 *
 * Fallback: si el título no tiene token hifenado (otros repos), devuelve el
 * título completo saneado. La guarda anti-cero-match del runner atrapa un slug
 * que no matchee nada (ver {@link expectedF2pCount}).
 */
export function f2pFixtureSlug(title: string): string {
  const cleaned = title.replace(/\([^)]*\)/g, " ").trim(); // quita variantes `(...)`
  const tokens = cleaned.split(/\s+/).filter((t) => t !== "");
  const hyphenated = tokens
    .filter((t) => t.includes("-") && !F2P_VARIANT_TOKENS.has(t.toLowerCase()))
    .sort((a, b) => b.length - a.length);
  return hyphenated[0] ?? cleaned;
}

/** Comando de test local sintetizado a partir del `test_command` + los F2P. */
export interface SynthesizedF2pRun {
  /** Invocación del runner (mocha) filtrada a los F2P, o `null` si no sintetizable. */
  readonly testInvocation: string | null;
  /** Patrón `--grep` (regex) usado, para logging/diagnóstico. */
  readonly grepPattern: string | null;
  /** Fixtures únicos esperados (guarda anti-cero-match: `passed+failed` debe cubrirlos). */
  readonly expectedFixtures: string[];
  /** Motivo cuando `testInvocation` es `null`. */
  readonly reason?: string;
}

/** Opciones de {@link synthesizeF2pTestRun}. */
export interface SynthesizeOptions {
  /**
   * Runner concreto ya resuelto (vía {@link resolveConcreteRunner}). Si se omite,
   * se mapea desde `parsed.runner` (npm-script/yarn-script → mocha, el histórico).
   */
  readonly concreteRunner?: ConcreteRunner | null;
  /** Ruta al binario de mocha (def. `./node_modules/.bin/mocha`). */
  readonly mochaBin?: string;
  /**
   * Fichero de opciones de mocha del repo, resuelto por el caller vía fs
   * (root `mocha.opts` en svelte vs `test/mocha.opts` en mui v5). `undefined`
   * → default histórico `"mocha.opts"`; `null` → NO emitir `--opts` (repos sin
   * fichero de opts).
   */
  readonly mochaOpts?: string | null;
  /** Ruta al binario de jest (def. `./node_modules/.bin/jest`). */
  readonly jestBin?: string;
}

/** Extensiones de spec que jest puede correr como archivo de test. */
const JEST_SPEC_RE = /\.(spec|test)\.[cm]?[jt]sx?$/;

/**
 * Filtra los `testTargets` del `test_command` a lo que jest puede correr como
 * test file. jest rechaza fixtures (`.snap`/`.svg`/`.html`) con "no tests found";
 * solo acepta specs. Preferimos los `.spec.js`/`.test.js` explícitos; si no hay
 * ninguno (el comando lista solo fixtures), caemos a los DIRECTORIOS únicos de
 * esos fixtures como patrones de path — jest los trata como regex sobre rutas de
 * test y corre el `jsfmt.spec.js` de cada dir. Esto cubre el modelo snapshot de
 * prettier, donde el spec de un directorio testea todos sus fixtures hermanos.
 */
function jestScopeTargets(targets: string[]): string[] {
  const specs = targets.filter((t) => JEST_SPEC_RE.test(t));
  if (specs.length > 0) return [...new Set(specs)];
  const dirs = targets
    .filter((t) => t.includes("/"))
    .map((t) => t.slice(0, t.lastIndexOf("/")));
  return [...new Set(dirs)];
}

/**
 * Sintetiza la invocación local del runner que corre SOLO los tests F2P y cuyo
 * exit code refleja su pass/fail. Es la pieza runner-side que
 * {@link toLocalTestCommand} dejó explícitamente sin hacer ("NO inventa
 * patrones `--grep`/`-t` de F2P").
 *
 * Cubre mocha (svelte/mui y la mayoría del whitelist) y jest (prettier). El
 * runner concreto se pasa vía `opts.concreteRunner` (resuelto con
 * {@link resolveConcreteRunner} leyendo el `package.json` del repo); si se omite,
 * se mapea desde `parsed.runner` con el histórico (delegadores → mocha). El
 * llamador DEBE, aparte: (1) aplicar el `test_patch` antes —los tests F2P los crea
 * ese patch—, (2) construir el repo si el fix va en `src/`, y (3) validar la
 * guarda anti-cero-match con {@link expectedFixtures}. vitest/bespoke → `null`.
 *
 * Nota sobre la guarda para jest: NO se aísla por título F2P (los ids de prettier
 * son símbolos como `isScriptLikeTag`, no títulos jest, y `-t` sería demasiado
 * amplio); se acota corriendo los spec files del `test_command`. Por eso la guarda
 * `expectedF2pCount` actúa como **liveness check** (ran===0 ⇒ inválido), no como
 * conteo exacto: el `exitCode` agregado del spec es la señal de grading correcta,
 * porque el snapshot F2P vive en el `test_patch` aplicado.
 */
export function synthesizeF2pTestRun(
  parsed: ParsedTestCommand,
  f2pTitles: string[],
  opts: SynthesizeOptions = {},
): SynthesizedF2pRun {
  const mochaBin = opts.mochaBin ?? "./node_modules/.bin/mocha";
  // `undefined` → default histórico; `null` sobrevive (no emitir --opts).
  const mochaOpts = opts.mochaOpts === undefined ? "mocha.opts" : opts.mochaOpts;
  const jestBin = opts.jestBin ?? "./node_modules/.bin/jest";

  const fixtures = [...new Set(f2pTitles.map((t) => f2pFixtureSlug(t)).filter((s) => s !== ""))];
  if (fixtures.length === 0) {
    return { testInvocation: null, grepPattern: null, expectedFixtures: [], reason: "no F2P titles" };
  }

  // Runner concreto: preferir el resuelto vía package.json; si no, mapear
  // parsed.runner (delegadores npm-script/yarn-script → mocha, el histórico).
  const runner: ConcreteRunner | null = opts.concreteRunner
    ?? (parsed.runner === "mocha" || parsed.runner === "npm-script" || parsed.runner === "yarn-script"
      ? "mocha"
      : parsed.runner === "jest"
        ? "jest"
        : parsed.runner === "vitest"
          ? "vitest"
          : null);

  if (runner === "mocha") {
    const grepPattern = fixtures.map(escapeRegex).join("|");
    // Reporter `dot`: compacto y parseable por parseTestRunnerOutput; NO usar
    // `json`, que el volcado de código-generado-en-fallo de svelte corrompe.
    // Construido por partes para: (a) omitir --opts cuando el repo no tiene
    // fichero (mochaOpts===null); (b) pasar los spec files del test_command
    // (parsed.testTargets) — svelte los deja vacíos y su mocha.opts enumera el
    // suite (test/test.js), pero mui v5 los necesita en la CLI porque su
    // test/mocha.opts solo registra @babel/register, no enumera specs. Byte-
    // idéntico a la versión previa cuando testTargets=[] y mochaOpts="mocha.opts".
    const parts = [mochaBin];
    if (mochaOpts !== null) parts.push("--opts", mochaOpts);
    for (const t of parsed.testTargets) parts.push(`'${t.replace(/'/g, "'\\''")}'`);
    parts.push("--grep", `'${grepPattern.replace(/'/g, "'\\''")}'`, "--reporter", "dot");
    return { testInvocation: parts.join(" "), grepPattern, expectedFixtures: fixtures };
  }

  if (runner === "jest") {
    const specTargets = jestScopeTargets(parsed.testTargets);
    if (specTargets.length === 0) {
      // Sin file scope (test_command = `yarn test` pelado, sin target). Fallback
      // defense-in-depth: acota por TÍTULO F2P con `-t` sobre la suite completa.
      // Liveness-check (exit agregado + guarda ran>0), no conteo exacto: el
      // snapshot graded vive en el test_patch aplicado y `--ci` impide reescritura.
      // Solo se alcanza sin path-targets (coste de suite completa); el scoping por
      // spec (arriba) sigue siendo la ruta primaria y la del manifiesto actual.
      const titlePattern = f2pTitles.map(escapeRegex).join("|");
      const testInvocation = `${jestBin} -t '${titlePattern.replace(/'/g, "'\\''")}' --ci --runInBand --colors=false`;
      return { testInvocation, grepPattern: titlePattern, expectedFixtures: fixtures };
    }
    const quoted = specTargets.map((t) => `'${t.replace(/'/g, "'\\''")}'`).join(" ");
    // Sin --json (parseJest lee la línea "Tests: N passed, M total" del reporter
    // por defecto, que --json suprime). --ci: no escribe snapshots nuevos → un F2P
    // cuyo snapshot no matchea FALLA (grading correcto). --runInBand: determinista.
    const testInvocation = `${jestBin} ${quoted} --ci --runInBand --colors=false`;
    return { testInvocation, grepPattern: null, expectedFixtures: fixtures };
  }

  // vitest/bespoke aún no soportados en generación.
  return {
    testInvocation: null,
    grepPattern: null,
    expectedFixtures: fixtures,
    reason: `runner ${runner ?? parsed.runner} not supported yet (mocha/jest only)`,
  };
}

/** Quoteo shell (comillas simples) de un path para la invocación del runner. */
function singleQuote(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

/**
 * Detecta runners "bespoke" que el grading file-scoped NO puede correr de forma
 * fiable: grunt/karma (axios — orquestación tipo-Docker) y `jest --projects`
 * (insomnia — monorepo multi-proyecto). Devuelve el motivo (para `invalid_reason`)
 * o `null` si el runner es tratable (jest/mocha directo). Se aplica solo a MSWE,
 * caller-side, sobre el cuerpo resuelto de `scripts.test`. Clasificar como bespoke
 * (medición inválida) es preferible a un pase falso.
 */
export function detectBespokeRunner(scriptBody: string | null): string | null {
  if (scriptBody === null) return null;
  if (/\b(grunt|karma)\b/.test(scriptBody)) return "bespoke_runner:grunt/karma";
  if (/--projects\b/.test(scriptBody)) return "bespoke_runner:jest-projects";
  return null;
}

/** Opciones de {@link synthesizeFileScopedTestRun}. */
export interface FileScopedOptions {
  /** Ruta al binario de mocha (def. `./node_modules/.bin/mocha`). */
  readonly mochaBin?: string;
  /** Fichero de opts de mocha; `undefined` → `"mocha.opts"`, `null` → sin `--opts`. */
  readonly mochaOpts?: string | null;
  /** Ruta al binario de jest (def. `./node_modules/.bin/jest`). */
  readonly jestBin?: string;
}

/**
 * Sintetiza una invocación que corre el/los **test file completos** que toca el
 * test_patch, SIN aislar por título/fixture (no hay `-t`/`--grep`). Es el régimen
 * de grading para Multi-SWE-bench, que NO trae títulos F2P upstream: el exit code
 * agregado del file es la señal de pass/fail y la guarda anti-cero-match
 * (`ran>0`) actúa como liveness — mismo modelo que ya usa jest en SWE-PolyBench,
 * pero acotado al file en vez de a un patrón F2P.
 *
 * jest → `<jestBin> '<file>'… --ci --runInBand --colors=false` (los `.snap` del
 * test_patch se filtran a su spec/dir vía {@link jestScopeTargets}; `--ci` impide
 * reescribir snapshots → un fix roto FALLA). mocha → `<mochaBin> [--opts <opts>]
 * '<file>'… --reporter dot`. vitest/bespoke/null → `null` con motivo.
 *
 * El caller DEBE, aparte: (1) aplicar el test_patch antes, (2) construir el repo si
 * el fix va en `src/`, (3) llamar con `expectedF2pCount = 1` (liveness, NO
 * `testFiles.length`, que mataría files con varios tests).
 */
export function synthesizeFileScopedTestRun(
  runner: ConcreteRunner | null,
  testFiles: string[],
  opts: FileScopedOptions = {},
): SynthesizedF2pRun {
  const mochaBin = opts.mochaBin ?? "./node_modules/.bin/mocha";
  const mochaOpts = opts.mochaOpts === undefined ? "mocha.opts" : opts.mochaOpts;
  const jestBin = opts.jestBin ?? "./node_modules/.bin/jest";

  const files = [...new Set(testFiles.filter((f) => f !== ""))];
  if (files.length === 0) {
    return { testInvocation: null, grepPattern: null, expectedFixtures: [], reason: "no test files" };
  }

  if (runner === "mocha") {
    const parts = [mochaBin];
    if (mochaOpts !== null) parts.push("--opts", mochaOpts);
    for (const f of files) parts.push(singleQuote(f));
    parts.push("--reporter", "dot");
    return { testInvocation: parts.join(" "), grepPattern: null, expectedFixtures: files };
  }

  if (runner === "jest") {
    // Filtra fixtures (.snap) a su spec/dir: jest rechaza correr un .snap como test.
    const specTargets = jestScopeTargets(files);
    const scoped = specTargets.length > 0 ? specTargets : files;
    const quoted = scoped.map(singleQuote).join(" ");
    const testInvocation = `${jestBin} ${quoted} --ci --runInBand --colors=false`;
    return { testInvocation, grepPattern: null, expectedFixtures: scoped };
  }

  return {
    testInvocation: null,
    grepPattern: null,
    expectedFixtures: files,
    reason: `runner ${runner ?? "desconocido"} not supported for file-scoped run (mocha/jest only)`,
  };
}
