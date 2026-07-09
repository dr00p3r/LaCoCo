import { describe, expect, it, vi } from "vitest";
import {
  MAX_ALIASES,
  MAX_DOMAINS,
  MAX_DESCRIPTION_LENGTH,
  SemanticTermEnricher,
} from "../../src/semantic-profile/semantic-term-enricher.js";
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

/** Formato natural del 4B (Fase 0): aliases como strings planos, dominios con
 * la clave `domain`, sin `confidence` per-term. El parser debe aceptarlo y
 * transformarlo al formato interno `SemanticAlias`/`SemanticDomainScore`. */
function enriched4B(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    aliases: ["alias-en", "alias-es"],
    domains: [{ domain: "validation", score: 0.9 }],
    description: `descripción de ${id}`,
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

/** LLM que falla N veces con un error (e.g. 500) y luego responde OK. */
function llmFailingThenOk(
  failCount: number,
  okResponse: string,
): { llm: LlmClient; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn();
  for (let i = 0; i < failCount; i++) chat.mockRejectedValueOnce(new Error("Ollama 500"));
  chat.mockResolvedValueOnce(okResponse);
  const llm = {
    chat,
    abort: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue(""),
  } as unknown as LlmClient;
  return { llm, chat };
}

/** LLM que siempre falla (e.g. 500 permanente). */
function llmAlwaysFailing(): { llm: LlmClient; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn().mockRejectedValue(new Error("Ollama 500"));
  const llm = {
    chat,
    abort: vi.fn(),
    isAvailable: vi.fn().mockResolvedValue(true),
    generate: vi.fn().mockResolvedValue(""),
  } as unknown as LlmClient;
  return { llm, chat };
}

/** LLM que devuelve un enriquecimiento válido para exactamente los ids del lote
 * que recibe (sin faltantes → sin reparación). Al responder por contenido y no por
 * orden de llamada, sirve para probar la ejecución concurrente de lotes. */
function llmEchoing(): { llm: LlmClient; chat: ReturnType<typeof vi.fn> } {
  const chat = vi.fn(async (messages: Array<{ content: string }>) => {
    const content = messages.at(-1)!.content;
    const payload = content.match(/Entrada:\n([\s\S]*)\nSalida:/)![1]!;
    const input = JSON.parse(payload) as Array<{ id: string }>;
    return JSON.stringify({ terms: input.map(({ id }) => enriched(id)) });
  });
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
    // MAX_ALIASES + 2 únicos: garantiza que el cap recorta y que la deduplicación
    // funciona (entrada duplicada no sobrevive).
    for (let i = 0; i < MAX_ALIASES + 2; i += 1) {
      aliases.push({ value: `Alias${i}`, language: "en", confidence: 0.9 });
      aliases.push({ value: `Alias${i}`, language: "en", confidence: 0.9 });
    }
    const { llm } = llmReturning(JSON.stringify({ terms: [enriched("a", { aliases })] }));

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(result!.aliases).toHaveLength(MAX_ALIASES);
    expect(new Set(result!.aliases.map(({ value }) => value.toLowerCase())).size).toBe(MAX_ALIASES);
  });

  it("deduplica dominios y respeta el máximo", async () => {
    // MAX_DOMAINS + 1 dominios únicos: garantiza que el cap recorta.
    const extras = ["validation", "api", "auth"];
    const domains = [
      { name: extras[0]!, score: 0.9 },
      { name: extras[0]!, score: 0.7 },
      { name: extras[1]!, score: 0.8 },
      { name: extras[2]!, score: 0.7 },
    ];
    const { llm } = llmReturning(JSON.stringify({ terms: [enriched("a", { domains })] }));

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(result!.domains).toHaveLength(MAX_DOMAINS);
    expect(new Set(result!.domains.map(({ name }) => name)).size).toBe(MAX_DOMAINS);
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

  it("mantiene el modelo residente entre llamadas (keep_alive)", async () => {
    const { llm, chat } = llmReturning(JSON.stringify({ terms: [enriched("a")] }));

    await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ keep_alive: "5m" }),
    );
  });

  it("preserva el orden de entrada al enriquecer lotes en paralelo", async () => {
    // 12 términos → 4 lotes (3/3/3/3 con BATCH_SIZE=3); con concurrencia 4
    // corren solapados. El resultado debe reensamblarse en el orden de entrada,
    // idéntico al secuencial.
    const ids = Array.from({ length: 12 }, (_, i) => `t${String(i).padStart(2, "0")}`);
    const terms = ids.map((id) => term(id, id));

    const parallel = await new SemanticTermEnricher(llmEchoing().llm, 4).enrich(terms);
    const sequential = await new SemanticTermEnricher(llmEchoing().llm, 1).enrich(terms);

    expect(parallel.map(({ id }) => id)).toEqual(ids);
    expect(parallel).toEqual(sequential);
  });

  it("recorta description a MAX_DESCRIPTION_LENGTH", async () => {
    // Fase 0: `coerceDescription` aplica el cap duro en storage. La schema
    // permite hasta MAX_DESCRIPTION_LENGTH chars; valores mayores se truncan
    // para no inflar la FTS index ni el prompt del grounder.
    const longDescription = "x".repeat(MAX_DESCRIPTION_LENGTH + 50);
    const { llm } = llmReturning(
      JSON.stringify({ terms: [enriched("a", { description: longDescription })] }),
    );

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(result!.description).toHaveLength(MAX_DESCRIPTION_LENGTH);
  });

  it("acepta lote sin dominios (minItems: 0)", async () => {
    // Fase 0: dominios opcionales; un lote con domains=[] es válido.
    const { llm } = llmReturning(
      JSON.stringify({ terms: [enriched("a", { domains: [] })] }),
    );

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(result!.domains).toEqual([]);
  });

  it("expone num_predict y num_ctx en OPTIONS para evitar prompt cache thrashing", async () => {
    const { llm, chat } = llmReturning(JSON.stringify({ terms: [enriched("a")] }));

    await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(chat).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({
        options: expect.objectContaining({
          num_predict: 2048,
          num_ctx: 8192,
        }),
      }),
    );
  });

  it("ignora el campo confidence del SLM (ya no es parte del schema)", async () => {
    // El SLM podría emitir "confidence" en el item, pero el schema Fase 0 lo
    // rechaza. #collectInto usa siempre el valor neutro (0.5) — el grounder
    // no consulta term.confidence.
    const { llm } = llmReturning(
      JSON.stringify({ terms: [enriched("a", { confidence: 0.99 })] }),
    );

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(result!.confidence).toBe(0.5);
  });

  it("acepta aliases como strings planos (formato natural del 4B)", async () => {
    // El 4B produce `["alias1", "alias2"]` (sin metadata). El parser debe
    // transformarlos a `{value, language: "unknown", confidence: 0.5}`.
    const { llm } = llmReturning(
      JSON.stringify({ terms: [enriched4B("a", { aliases: ["foo", "bar", "baz"] })] }),
    );

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(result!.aliases).toHaveLength(3);
    expect(result!.aliases.map(({ value }) => value)).toEqual(["foo", "bar", "baz"]);
    expect(result!.aliases.every(({ language }) => language === "unknown")).toBe(true);
    expect(result!.aliases.every(({ confidence }) => confidence === 0.5)).toBe(true);
  });

  it("acepta dominios con la clave 'domain' (formato 4B)", async () => {
    // El 4B produce `[{domain: "validation", score: 0.9}]`. El parser debe
    // mapear `domain` → `name` para mantener el contrato interno.
    const { llm } = llmReturning(
      JSON.stringify({
        terms: [
          enriched4B("a", { domains: [{ domain: "validation", score: 0.9 }] }),
        ],
      }),
    );

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(result!.domains).toEqual([{ name: "validation", score: 0.9 }]);
  });

  it("mezcla aliases en formato string y objeto en el mismo lote", async () => {
    // Compat: el parser acepta string[] y {value, language, confidence}[] en
    // la misma respuesta. El 4B puede alternar formatos entre batches.
    const { llm } = llmReturning(
      JSON.stringify({
        terms: [
          enriched4B("a", { aliases: ["str1", "str2"] }),
          enriched("b", { aliases: [{ value: "obj1", language: "en", confidence: 0.8 }] }),
        ],
      }),
    );

    const result = await new SemanticTermEnricher(llm).enrich([
      term("a", "alpha"),
      term("b", "bravo"),
    ]);

    expect(result[0]!.aliases.map(({ value }) => value)).toEqual(["str1", "str2"]);
    expect(result[0]!.aliases[0]!.language).toBe("unknown");
    expect(result[1]!.aliases[0]!.value).toBe("obj1");
    expect(result[1]!.aliases[0]!.language).toBe("en");
    expect(result[1]!.aliases[0]!.confidence).toBe(0.8);
  });

  it("matchea término por índice posicional cuando el SLM omite el id", async () => {
    // La 4B a veces omite el `id` en el output. El parser usa la posición
    // en el array como fallback: la SLM preserva el orden de entrada.
    const response = JSON.stringify({
      terms: [
        { aliases: ["a1"], domains: [], description: "first" },  // sin id
        { aliases: ["b1"], domains: [], description: "second" }, // sin id
      ],
    });
    const { llm } = llmReturning(response);

    const result = await new SemanticTermEnricher(llm).enrich([
      term("first-id", "alpha"),
      term("second-id", "bravo"),
    ]);

    expect(result[0]!.id).toBe("first-id");
    expect(result[0]!.aliases[0]!.value).toBe("a1");
    expect(result[1]!.id).toBe("second-id");
    expect(result[1]!.aliases[0]!.value).toBe("b1");
  });

  it("reintenta cuando Ollama devuelve 500 (transient)", async () => {
    // 1er intento: 500. 2do intento: respuesta válida. El build NO aborta.
    const okResponse = JSON.stringify({ terms: [enriched("a")] });
    const { llm, chat } = llmFailingThenOk(1, okResponse);

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(chat).toHaveBeenCalledTimes(2);
    expect(result!.id).toBe("a");
  });

  it("degrada a minimalEnrichment si Ollama falla 3 veces consecutivas", async () => {
    // El batch entero cae a minimalEnrichment (sin aliases/dominios) en
    // lugar de abortar el perfil. El build sigue adelante.
    const { llm, chat } = llmAlwaysFailing();

    const result = await new SemanticTermEnricher(llm).enrich([
      term("a", "parse"),
      term("b", "safeParse"),
    ]);

    expect(chat).toHaveBeenCalledTimes(3); // exactamente 3 reintentos
    expect(result).toHaveLength(2);
    expect(result[0]!.aliases).toEqual([]);
    expect(result[0]!.domains).toEqual([]);
    expect(result[0]!.description).toBe("parse");
    expect(result[0]!.confidence).toBe(0);
    expect(result[1]!.aliases).toEqual([]);
    expect(result[1]!.description).toBe("safeParse");
  });

  it("cap de MAX_ALIASES con strings planos del 4B", async () => {
    // MAX_ALIASES=4: el 4B produce naturalmente 1-5; si produce 6, cap a 4.
    const aliases = ["uno", "dos", "tres", "cuatro", "cinco", "seis"];
    const { llm } = llmReturning(
      JSON.stringify({ terms: [enriched4B("a", { aliases })] }),
    );

    const [result] = await new SemanticTermEnricher(llm).enrich([term("a", "parse")]);

    expect(result!.aliases).toHaveLength(MAX_ALIASES);
    expect(result!.aliases.map(({ value }) => value)).toEqual([
      "uno", "dos", "tres", "cuatro",
    ]);
  });
});
