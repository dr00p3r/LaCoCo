import { describe, it, expect } from "vitest";
import { PropositionEnricher, type PropositionInput } from "../../src/semantic-profile/proposition-enricher.js";
import type { ChatMessage, ChatOptions, LlmClient } from "../../src/slms/llm-client.js";

class FakeLlm implements LlmClient {
  constructor(private readonly responder: (messages: ChatMessage[]) => string) {}
  abort(): void {}
  async isAvailable(): Promise<boolean> { return true; }
  async generate(): Promise<string> { return ""; }
  async chat(messages: ChatMessage[], _options?: ChatOptions): Promise<string> {
    return this.responder(messages);
  }
}

const node = (id: string, name: string, signature = ""): PropositionInput => ({ id, name, signature });

describe("PropositionEnricher", () => {
  it("parses propositions per node from the SLM JSON", async () => {
    const llm = new FakeLlm(() => JSON.stringify({
      nodes: [
        { id: "n1", propositions: ["persiste una orden en el repositorio", "valida el dto de entrada"] },
        { id: "n2", propositions: ["renderiza un botón"] },
      ],
    }));

    const out = await new PropositionEnricher(llm).enrich([node("n1", "createOrder"), node("n2", "Button")]);

    expect(out).toEqual([
      { id: "n1", propositions: ["persiste una orden en el repositorio", "valida el dto de entrada"] },
      { id: "n2", propositions: ["renderiza un botón"] },
    ]);
  });

  it("matches by positional index when the SLM omits the id", async () => {
    const llm = new FakeLlm(() => JSON.stringify({ nodes: [{ propositions: ["hace algo"] }] }));

    const out = await new PropositionEnricher(llm).enrich([node("n1", "foo")]);

    expect(out).toEqual([{ id: "n1", propositions: ["hace algo"] }]);
  });

  it("coerces: caps count, dedupes, drops empties and over-length strings are truncated", async () => {
    const long = "x".repeat(300);
    const llm = new FakeLlm(() => JSON.stringify({
      nodes: [{ id: "n1", propositions: ["a", "a", "", "b", "c", "d", long] }],
    }));

    const out = await new PropositionEnricher(llm).enrich([node("n1", "foo")]);

    expect(out[0]!.propositions).toEqual(["a", "b", "c"]); // dedup "a", drop "", cap to 3
  });

  it("falls back to the humanized node name when the SLM keeps failing", async () => {
    const llm = new FakeLlm(() => { throw new Error("boom"); });

    const out = await new PropositionEnricher(llm).enrich([node("n1", "createOrderHandler")]);

    expect(out).toEqual([{ id: "n1", propositions: ["create order handler"] }]);
  });

  it("falls back per-node when the SLM omits some ids", async () => {
    const llm = new FakeLlm(() => JSON.stringify({
      nodes: [{ id: "n1", propositions: ["cubierto"] }],
    }));

    const out = await new PropositionEnricher(llm).enrich([node("n1", "Alpha"), node("n2", "BetaGamma")]);

    expect(out).toEqual([
      { id: "n1", propositions: ["cubierto"] },
      { id: "n2", propositions: ["beta gamma"] },
    ]);
  });
});
