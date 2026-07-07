import { afterEach, describe, expect, it } from "vitest";
import { resolveIntermediaryModel } from "../../src/cli/config.js";

const ENV_KEYS = ["LACOCO_INTERMEDIARY_MODEL", "LACOCO_AGENT_MODEL"] as const;

describe("resolveIntermediaryModel", () => {
  const snapshot = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const));

  afterEach(() => {
    for (const [key, value] of snapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("usa intermediary.model cuando está definido", () => {
    process.env.LACOCO_INTERMEDIARY_MODEL = "gemma4:e4b";
    process.env.LACOCO_AGENT_MODEL = "qwen2.5-coder:1.5b";

    expect(resolveIntermediaryModel()).toBe("gemma4:e4b");
  });

  it("hereda agent.model cuando intermediary.model está vacío", () => {
    process.env.LACOCO_INTERMEDIARY_MODEL = "";
    process.env.LACOCO_AGENT_MODEL = "qwen-personalizado";

    expect(resolveIntermediaryModel()).toBe("qwen-personalizado");
  });
});
