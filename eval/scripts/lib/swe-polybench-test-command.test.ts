import { describe, expect, it } from "vitest";
import {
  parseF2pTestId,
  parseTestCommand,
  resolveConcreteRunner,
  synthesizeF2pTestRun,
  toLocalTestCommand,
} from "./swe-polybench-test-command.js";

// Comandos reales (uno por repo/runner) tomados de instances.tsjs.jsonl.
const CMD = {
  mochaMui:
    '. /usr/local/nvm/nvm.sh && nvm use 16.20.2 && npm pkg set scripts.lint="echo noop" && yarn cross-env NODE_ENV=test mocha packages/material-ui/src/ListItem/ListItem.test.js --reporter /testbed/custom-reporter.js --exit',
  mochaServerless:
    ". /usr/local/nvm/nvm.sh && npx mocha lib/plugins/aws/package/compile/events/apiGateway/lib/method/index.test.js --reporter json",
  npmSvelte:
    '. /usr/local/nvm/nvm.sh && nvm use 16.20.2 && npm pkg set scripts.lint="echo noop" && npm run test -- --reporter json --exit',
  yarnPrettier:
    '. /usr/local/nvm/nvm.sh && nvm use 20.16.0 && npm pkg set scripts.lint="echo noop" && yarn test tests/format/html/svg/svg.html tests/config/utils/check-parsers.js',
  yarnPrettierSpec:
    '. /usr/local/nvm/nvm.sh && nvm use 20.16.0 && npm pkg set scripts.lint="echo noop" && yarn test tests/format/html/svg/embeded/jsfmt.spec.js tests/format/html/svg/embeded/svg.svg tests/format/html/svg/__snapshots__/jsfmt.spec.js.snap',
  jestTailwind: ". /usr/local/nvm/nvm.sh && npx jest --json --forceExit",
  bespokeVscode:
    ". /usr/local/nvm/nvm.sh && yarn compile ; xvfb-run --auto-servernum --server-args='-screen 0 1024x768x24' ./scripts/test.sh --run src/vs/editor/contrib/suggest/test/suggestModel.test.ts --reporter json --no-sandbox --exit",
  bespokeAngular:
    ". /usr/local/nvm/nvm.sh && bazel test packages/core/test/render3 --keep_going --test_output=summary",
};

describe("parseTestCommand — runners", () => {
  it("mocha con custom-reporter (mui)", () => {
    const p = parseTestCommand(CMD.mochaMui);
    expect(p.runner).toBe("mocha");
    expect(p.nodeVersion).toBe("16.20.2");
    expect(p.usesCustomReporter).toBe(true);
    expect(p.reporter).toBe("custom-reporter");
    expect(p.bespoke).toBe(false);
    expect(p.testTargets).toEqual(["packages/material-ui/src/ListItem/ListItem.test.js"]);
  });

  it("mocha vía npx con reporter json (serverless), sin nvm use", () => {
    const p = parseTestCommand(CMD.mochaServerless);
    expect(p.runner).toBe("mocha");
    expect(p.packageManager).toBe("npx");
    expect(p.nodeVersion).toBeNull();
    expect(p.reporter).toBe("json");
    expect(p.testTargets).toEqual([
      "lib/plugins/aws/package/compile/events/apiGateway/lib/method/index.test.js",
    ]);
  });

  it("npm-script delegado (svelte)", () => {
    const p = parseTestCommand(CMD.npmSvelte);
    expect(p.runner).toBe("npm-script");
    expect(p.scriptName).toBe("test");
    expect(p.reporter).toBe("json");
    expect(p.bespoke).toBe(false);
  });

  it("yarn-script con archivos objetivo (prettier)", () => {
    const p = parseTestCommand(CMD.yarnPrettier);
    expect(p.runner).toBe("yarn-script");
    expect(p.scriptName).toBe("test");
    expect(p.testTargets).toContain("tests/format/html/svg/svg.html");
    expect(p.testTargets).toContain("tests/config/utils/check-parsers.js");
  });

  it("jest vía npx (tailwind)", () => {
    const p = parseTestCommand(CMD.jestTailwind);
    expect(p.runner).toBe("jest");
    expect(p.reporter).toBe("json");
    expect(p.testTargets).toEqual([]);
  });

  it("bespoke: vscode scripts/test.sh", () => {
    const p = parseTestCommand(CMD.bespokeVscode);
    expect(p.runner).toBe("bespoke");
    expect(p.bespoke).toBe(true);
    expect(p.bespokeReason).toBe("vscode-test-sh");
  });

  it("bespoke: angular bazel", () => {
    const p = parseTestCommand(CMD.bespokeAngular);
    expect(p.runner).toBe("bespoke");
    expect(p.bespokeReason).toBe("bazel");
  });
});

describe("parseF2pTestId", () => {
  it("formato <file>-><title>, retira /testbed/", () => {
    const r = parseF2pTestId("/testbed/tests/format/html/svg/embeded/jsfmt.spec.js->format");
    expect(r.file).toBe("tests/format/html/svg/embeded/jsfmt.spec.js");
    expect(r.title).toBe("format");
  });

  it("formato sin archivo (qunit anidado) → todo es título", () => {
    const r = parseF2pTestId("988 Source > Maths > Box3 > intersectsPlane");
    expect(r.file).toBeNull();
    expect(r.title).toBe("988 Source > Maths > Box3 > intersectsPlane");
  });
});

describe("toLocalTestCommand", () => {
  it("reemplaza custom-reporter por reporter local y quita /testbed/", () => {
    const local = toLocalTestCommand(parseTestCommand(CMD.mochaMui));
    expect(local.runnable).toBe(true);
    expect(local.reporterReplaced).toBe(true);
    expect(local.command).toContain("--reporter json");
    expect(local.command).not.toContain("/testbed/");
    expect(local.command).not.toContain("nvm use");
  });

  it("bespoke → no ejecutable con motivo", () => {
    const local = toLocalTestCommand(parseTestCommand(CMD.bespokeAngular));
    expect(local.command).toBeNull();
    expect(local.runnable).toBe(false);
    expect(local.reason).toBe("bespoke:bazel");
  });
});

describe("resolveConcreteRunner", () => {
  it("yarn-script cuyo scripts.test corre jest (prettier) → jest", () => {
    expect(resolveConcreteRunner(parseTestCommand(CMD.yarnPrettier), "jest")).toBe("jest");
  });

  it("npm-script cuyo scripts.test corre mocha (svelte) → mocha", () => {
    expect(resolveConcreteRunner(parseTestCommand(CMD.npmSvelte), "mocha -r ts-node/register")).toBe(
      "mocha",
    );
  });

  it("npm-script sin cuerpo legible → fallback mocha (preserva svelte)", () => {
    expect(resolveConcreteRunner(parseTestCommand(CMD.npmSvelte), null)).toBe("mocha");
  });

  it("mocha directo (mui) → mocha, sin importar el cuerpo", () => {
    expect(resolveConcreteRunner(parseTestCommand(CMD.mochaMui), "jest")).toBe("mocha");
  });

  it("yarn-script cuyo scripts.test corre vitest → vitest", () => {
    expect(resolveConcreteRunner(parseTestCommand(CMD.yarnPrettier), "vitest run")).toBe("vitest");
  });

  it("bespoke → null", () => {
    expect(resolveConcreteRunner(parseTestCommand(CMD.bespokeAngular), null)).toBeNull();
  });
});

describe("synthesizeF2pTestRun", () => {
  it("mocha: invocación con --grep --reporter dot (sin regresión svelte/mui)", () => {
    const synth = synthesizeF2pTestRun(parseTestCommand(CMD.mochaMui), ["some-fixture-name"], {
      concreteRunner: "mocha",
    });
    expect(synth.testInvocation).toBe(
      "./node_modules/.bin/mocha --opts mocha.opts --grep 'some-fixture-name' --reporter dot",
    );
    expect(synth.expectedFixtures).toEqual(["some-fixture-name"]);
  });

  it("jest (prettier): corre el .spec.js, no fixtures ni --json", () => {
    const synth = synthesizeF2pTestRun(parseTestCommand(CMD.yarnPrettierSpec), ["format"], {
      concreteRunner: "jest",
    });
    expect(synth.testInvocation).not.toBeNull();
    expect(synth.testInvocation!).toContain("./node_modules/.bin/jest");
    expect(synth.testInvocation!).toContain("tests/format/html/svg/embeded/jsfmt.spec.js");
    expect(synth.testInvocation!).not.toContain(".snap");
    expect(synth.testInvocation!).not.toContain(".svg");
    expect(synth.testInvocation!).not.toContain("--json");
    expect(synth.testInvocation!).toContain("--ci");
    expect(synth.testInvocation!).toContain("--runInBand");
  });

  it("jest fallback: solo fixtures (sin .spec.js) → usa los directorios", () => {
    const synth = synthesizeF2pTestRun(parseTestCommand(CMD.yarnPrettier), ["format"], {
      concreteRunner: "jest",
    });
    expect(synth.testInvocation).not.toBeNull();
    expect(synth.testInvocation!).toContain("tests/format/html/svg");
    expect(synth.testInvocation!).toContain("tests/config/utils");
  });

  it("jest sin targets usables → null con motivo", () => {
    const parsed = { ...parseTestCommand(CMD.jestTailwind), testTargets: [] as string[] };
    const synth = synthesizeF2pTestRun(parsed, ["format"], { concreteRunner: "jest" });
    expect(synth.testInvocation).toBeNull();
    expect(synth.reason).toContain("no spec targets");
  });

  it("sin títulos F2P → null (comportamiento preservado)", () => {
    const synth = synthesizeF2pTestRun(parseTestCommand(CMD.mochaMui), [], {
      concreteRunner: "mocha",
    });
    expect(synth.testInvocation).toBeNull();
    expect(synth.reason).toBe("no F2P titles");
  });
});
