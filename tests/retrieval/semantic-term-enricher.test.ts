import { describe, expect, it, vi } from "vitest";
import { SemanticTermEnricher } from "../../src/semantic-profile/semantic-term-enricher.js";
import type { DeterministicTerm } from "../../src/semantic-profile/types.js";
import type { LlmClient } from "../../src/slms/llm-client.js";

function term(id: string, canonicalTerm: string): DeterministicTerm {
  return {
    id,
    canonicalTerm,
    normalizedTerm: canonicalTerm.toLowerCase(),
    kind: "symbol",
    dimensions: ["CPG"],
    evidence: [`evidencia de ${canonicalTerm}`],
    sourceHash: `hash-${id}`,
  };
}

function enriched(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    aliases: [{ value: "alias", language: "en", confidence: 0.9 }],
    domains: [{ name: "validation", score: 0.9 }],
    description: `descripción de ${id}`,
    confidence: 0.9,
    ...overrides,
  };
}

function llmReturning(...responses: string[]): { llm: LlmClient; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn();
  for (const response of responses) chat.mockResolvedValueOnce(response);
  const llm = {
    chat,
    abort: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue(""),
  } as unknown as LlmClient;
  return { llm, chat };
}

describe("SemanticTermEnricher", () => {
  it("desactiva el razonamiento del modelo (think:false) para no vaciar num_predict", async () => {
    const { llm, chat } = llmReturning(JSON.stringify({ terms: [enriched("a")] }));

    await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ think: false }),
    );
  });

  it("deduplica alias y respeta el máximo sin abortar el lote", async () => {
    const aliases: Array<Record<string, unknown>> = [];
    for (let i = 0; i < 10; i += 1) {
      // Cada alias aparece dos veces: 20 entradas → 10 únicos → recorte a 8.
      aliases.push({ value: `Alias${i}`, language: "en", confidence: 0.9 });
      aliases.push({ value: `Alias${i}`, language: "en", confidence: 0.9 });
    }
    const { llm } = llmReturning(JSON.stringify({ terms: [enriched("a", { aliases })] }));

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(result!.aliases).toHaveLength(8);
    expect(new Set(result!.aliases.map(({ value }) => value.toLowerCase())).size).toBe(8);
  });

  it("deduplica dominios y respeta el máximo de tres", async () => {
    const domains = [
      { name: "validation", score: 0.9 },
      { name: "validation", score: 0.7 },
      { name: "api", score: 0.8 },
      { name: "auth", score: 0.7 },
      { name: "testing", score: 0.6 },
    ];
    const { llm } = llmReturning(JSON.stringify({ terms: [enriched("a", { domains })] }));

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(result!.domains).toHaveLength(3);
    expect(new Set(result!.domains.map(({ name }) => name)).size).toBe(3);
  });

  it("descarta contenido mal formado del SLM sin abortar el lote", async () => {
    // Reproduce el fallo real con qwen2.5:7b-instruct: un alias con confianza
    // fuera de rango tumbaba todo el perfil. Ahora se descarta esa entrada, la
    // confianza no numérica del término cae al neutro y la descripción vacía usa
    // el término canónico — sin lanzar.
    const noisy = enriched("a", {
      aliases: [
        { value: "bueno", language: "en", confidence: 0.9 },
        { value: "malo", language: "en", confidence: 5 },
      ],
      confidence: "alta",
      description: "",
    });
    const { llm } = llmReturning(JSON.stringify({ terms: [noisy] }));

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(result!.aliases.map(({ value }) => value)).toEqual(["bueno"]);
    expect(result!.confidence).toBe(0.5);
    expect(result!.description).toBe("parse");
  });

  it("recupera los términos omitidos pidiendo solo los que faltan", async () => {
    // Primera pasada: el modelo solo enriquece "a". La reparación pide únicamente
    // "b" (entrada distinta → decodificación fresca) y esta vez lo devuelve.
    const onlyA = JSON.stringify({ terms: [enriched("a")] });
    const onlyB = JSON.stringify({ terms: [enriched("b")] });
    const { llm, chat } = llmReturning(onlyA, onlyB);

    const result = await new SemanticTermEnricher(llm).enrich([
      term("a", "alpha"),
      term("b", "bravo"),
    ]);

    expect(result.map(({ id }) => id)).toEqual(["a", "b"]);
    expect(chat).toHaveBeenCalledTimes(2);
    // La segunda llamada pide solo el término faltante "b", no el lote entero.
    const repairInput = chat.mock.calls[1]?.[0]?.at(-1)?.content as string;
    expect(repairInput).toContain("bravo");
    expect(repairInput).not.toContain("alpha");
  });

  it("sintetiza enriquecimiento mínimo para un término que el SLM nunca devuelve", async () => {
    // El modelo omite "b" en ambas pasadas → no se aborta: "b" recibe un
    // enriquecimiento mínimo (sin alias/dominios) preservando la completitud.
    const onlyA = JSON.stringify({ terms: [enriched("a")] });
    const { llm } = llmReturning(onlyA, onlyA);

    const result = await new SemanticTermEnricher(llm).enrich([
      term("a", "parse"),
      term("b", "safeParse"),
    ]);

    const b = result.find(({ id }) => id === "b");
    expect(b).toBeDefined();
    expect(b!.aliases).toEqual([]);
    expect(b!.domains).toEqual([]);
    expect(b!.description).toBe("safeParse");
    expect(b!.confidence).toBe(0);
  });

  it("repara una primera respuesta sin JSON y luego acepta el lote", async () => {
    const good = JSON.stringify({ terms: [enriched("a")] });
    const { llm, chat } = llmReturning("no hay json aquí", good);

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(result!.id).toBe("a");
    expect(chat).toHaveBeenCalledTimes(2);
  });
});
