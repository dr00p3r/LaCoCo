/**
 * Ramas del parser tolerante de semantic-term-enricher.ts: entradas mal formadas
 * del SLM (JSON inválido dentro de llaves, `terms` no-array, ítems no-objeto, ids
 * duplicados o por posición, aliases/dominios/descripciones inválidos) y el
 * saneamiento del parámetro de concurrencia en el constructor.
 *
 * Todo con un LlmClient falso (sin red ni modelos reales).
 */

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

/** LlmClient que devuelve, en orden, las respuestas dadas. */
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

describe("SemanticTermEnricher — saneamiento de concurrencia", () => {
  it("cae a 1 worker cuando la concurrencia redondea a cero", async () => {
    // Arrange — Math.floor(0.5) === 0 → rama `|| 1`.
    const { llm } = llmReturning(JSON.stringify({ terms: [{ id: "a", aliases: [], domains: [], description: "d" }] }));
    // Act
    const result = await new SemanticTermEnricher(llm, 0.5).enrich([term("a", "parse")]);
    // Assert — funciona con un solo worker.
    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("a");
  });
});

describe("SemanticTermEnricher — respuestas estructuralmente inválidas", () => {
  it("ignora JSON inválido dentro de llaves y repara en la segunda pasada", async () => {
    // Arrange — la 1ª respuesta tiene llaves pero no es JSON parseable.
    const good = JSON.stringify({ terms: [{ id: "a", aliases: [], domains: [], description: "ok" }] });
    const { llm, chat } = llmReturning("ruido {esto no es json} cola", good);
    // Act
    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);
    // Assert
    expect(result!.id).toBe("a");
    expect(chat).toHaveBeenCalledTimes(2);
  });

  it("ignora una respuesta cuyo campo terms no es un array", async () => {
    // Arrange
    const good = JSON.stringify({ terms: [{ id: "a", aliases: [], domains: [], description: "ok" }] });
    const { llm } = llmReturning(JSON.stringify({ terms: "no-soy-array" }), good);
    // Act
    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);
    // Assert — cae a la reparación y se recupera.
    expect(result!.description).toBe("ok");
  });

  it("salta ítems que no son objetos dentro de terms", async () => {
    // Arrange — el primer ítem es null, el segundo es válido.
    const response = JSON.stringify({
      terms: [null, { id: "a", aliases: [], domains: [], description: "valido" }],
    });
    const { llm } = llmReturning(response);
    // Act
    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);
    // Assert
    expect(result!.description).toBe("valido");
  });

  it("ignora un segundo ítem con id duplicado", async () => {
    // Arrange — dos ítems con el mismo id; el segundo se descarta.
    const response = JSON.stringify({
      terms: [
        { id: "a", aliases: ["primero"], domains: [], description: "d" },
        { id: "a", aliases: ["segundo"], domains: [], description: "d" },
      ],
    });
    const { llm } = llmReturning(response);
    // Act
    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);
    // Assert — gana el primero.
    expect(result!.aliases.map(({ value }) => value)).toEqual(["primero"]);
  });

  it("descarta un ítem sin id cuyo índice excede la entrada", async () => {
    // Arrange — entrada de 1 término; respuesta con 2 ítems sin id. El segundo
    // (índice 1) no tiene término origen → se descarta.
    const response = JSON.stringify({
      terms: [
        { aliases: ["a1"], domains: [], description: "primero" },
        { aliases: ["b1"], domains: [], description: "sobrante" },
      ],
    });
    const { llm } = llmReturning(response);
    // Act
    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "alpha")]);
    // Assert — solo el término de índice 0 se enriquece.
    expect(result!.aliases.map(({ value }) => value)).toEqual(["a1"]);
  });
});

describe("SemanticTermEnricher — saneamiento de aliases", () => {
  it("descarta aliases mal formados (no-array, vacíos, sin value, idioma inválido, tipo raro)", async () => {
    // Arrange — mezcla de formas inválidas y una válida.
    const response = JSON.stringify({
      terms: [
        {
          id: "a",
          aliases: [
            "   ",                                  // string vacío tras trim
            { language: "en", confidence: 0.5 },     // objeto sin value
            { value: "x", language: "fr", confidence: 0.5 }, // idioma inválido
            42,                                      // tipo no soportado
            ["arr"],                                 // array → tipo no soportado
            "valido",                                // único alias que sobrevive
          ],
          domains: [],
          description: "d",
        },
      ],
    });
    const { llm } = llmReturning(response);
    // Act
    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);
    // Assert
    expect(result!.aliases.map(({ value }) => value)).toEqual(["valido"]);
  });

  it("trata un campo aliases no-array como lista vacía", async () => {
    // Arrange
    const response = JSON.stringify({
      terms: [{ id: "a", aliases: "no-array", domains: [], description: "d" }],
    });
    const { llm } = llmReturning(response);
    // Act
    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);
    // Assert
    expect(result!.aliases).toEqual([]);
  });
});

describe("SemanticTermEnricher — saneamiento de dominios y descripción", () => {
  it("descarta dominios mal formados (no-array, no-objeto, nombre inválido, score inválido)", async () => {
    // Arrange
    const response = JSON.stringify({
      terms: [
        {
          id: "a",
          aliases: [],
          domains: [
            null,                                    // no-objeto
            { domain: "no-existe", score: 0.5 },      // nombre no canónico
            { domain: "validation", score: "alto" },  // score no numérico
            { domain: "validation", score: 5 },        // score fuera de rango
            { domain: "api", score: 0.7 },             // único válido
          ],
          description: "d",
        },
      ],
    });
    const { llm } = llmReturning(response);
    // Act
    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);
    // Assert
    expect(result!.domains).toEqual([{ name: "api", score: 0.7 }]);
  });

  it("trata un campo domains no-array como lista vacía", async () => {
    // Arrange
    const response = JSON.stringify({
      terms: [{ id: "a", aliases: [], domains: "no-array", description: "d" }],
    });
    const { llm } = llmReturning(response);
    // Act
    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);
    // Assert
    expect(result!.domains).toEqual([]);
  });

  it("usa el término canónico como descripción cuando no es un string", async () => {
    // Arrange — description numérica → coerceDescription usa el fallback.
    const response = JSON.stringify({
      terms: [{ id: "a", aliases: [], domains: [], description: 123 }],
    });
    const { llm } = llmReturning(response);
    // Act
    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);
    // Assert
    expect(result!.description).toBe("parse");
  });
});
