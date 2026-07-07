import { describe, expect, it } from "vitest";
import {
  parseF2pTestId,
  parseTestCommand,
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
