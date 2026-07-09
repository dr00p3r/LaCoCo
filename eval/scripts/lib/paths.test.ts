import { afterEach, describe, expect, it } from "vitest";
import { isAbsolute, join } from "node:path";
import { PROJECT_ROOT, resolveManifestsDir } from "./paths.js";

const ENV_KEY = "LACOCO_EVAL_MANIFESTS_DIR";

describe("resolveManifestsDir", () => {
  const previous = process.env[ENV_KEY];

  afterEach(() => {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  });

  it("devuelve undefined cuando no hay flag ni env var", () => {
    delete process.env[ENV_KEY];
    expect(resolveManifestsDir(undefined)).toBeUndefined();
    expect(resolveManifestsDir()).toBeUndefined();
  });

  it("resuelve el flag relativo contra PROJECT_ROOT", () => {
    delete process.env[ENV_KEY];
    expect(resolveManifestsDir("eval/manifests/swe-polybench")).toBe(
      join(PROJECT_ROOT, "eval/manifests/swe-polybench"),
    );
  });

  it("respeta rutas absolutas en el flag", () => {
    delete process.env[ENV_KEY];
    const abs = "/tmp/absolute/manifests";
    expect(resolveManifestsDir(abs)).toBe(abs);
    expect(isAbsolute(resolveManifestsDir(abs)!)).toBe(true);
  });

  it("lee LACOCO_EVAL_MANIFESTS_DIR cuando no hay flag", () => {
    delete process.env[ENV_KEY];
    process.env[ENV_KEY] = "eval/manifests/swe-polybench";
    expect(resolveManifestsDir()).toBe(
      join(PROJECT_ROOT, "eval/manifests/swe-polybench"),
    );
  });

  it("el flag explicito tiene precedencia sobre la env var", () => {
    process.env[ENV_KEY] = "eval/manifests/desde-env";
    const explicit = "eval/manifests/desde-flag";
    expect(resolveManifestsDir(explicit)).toBe(join(PROJECT_ROOT, explicit));
  });

  it("ignora env var vacia y cae al default", () => {
    process.env[ENV_KEY] = "";
    expect(resolveManifestsDir()).toBeUndefined();
  });

  it("respeta rutas absolutas en la env var", () => {
    const abs = "/opt/lacoco/manifests";
    process.env[ENV_KEY] = abs;
    expect(resolveManifestsDir()).toBe(abs);
  });
});
