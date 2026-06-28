import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readJsonl } from "./jsonl.js";
import { EVAL_ROOT } from "./paths.js";

describe("readJsonl", () => {
  it("loads the retrieval fixture line by line", () => {
    const entries = readJsonl(join(EVAL_ROOT, "fixtures", "retrieval", "sample.jsonl"));
    expect(entries).toHaveLength(5);
    expect(entries[0]?.line).toBe(1);
  });
});
