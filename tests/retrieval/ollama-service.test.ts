import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaService } from "../../src/slms/ollama-service.js";

describe("OllamaService", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("usa el timeout configurado para generate y chat", async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      const signal = init?.signal as AbortSignal;
      signals.push(signal);
      return rejectWhenAborted(signal);
    });

    const ollama = new OllamaService("http://localhost:11434", "test-model", 1_234);

    const generate = ollama.generate("prompt");
    const generateRejection = expect(generate).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(1_233);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await generateRejection;

    const chat = ollama.chat([{ role: "user", content: "prompt" }]);
    const chatRejection = expect(chat).rejects.toThrow("aborted");
    await vi.advanceTimersByTimeAsync(1_234);
    await chatRejection;
    expect(signals).toHaveLength(2);
  });

  it("acota isAvailable a cinco segundos aunque el timeout configurado sea mayor", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      signal = init?.signal as AbortSignal;
      return rejectWhenAborted(signal);
    });

    const ollama = new OllamaService("http://localhost:11434", "test-model", 30_000);

    const availability = ollama.isAvailable();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(availability).resolves.toBe(false);
  });

  it("cancela solicitudes activas de forma explícita", async () => {
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      signal = init?.signal as AbortSignal;
      return rejectWhenAborted(signal);
    });

    const ollama = new OllamaService("http://localhost:11434", "test-model", 30_000);
    const generate = ollama.generate("prompt");
    const rejection = expect(generate).rejects.toThrow("aborted");

    ollama.abort();

    expect(signal?.aborted).toBe(true);
    await rejection;
  });

  it("mantiene el timeout activo mientras consume el cuerpo", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    vi.spyOn(globalThis, "fetch").mockImplementation((_input, init) => {
      signal = init?.signal as AbortSignal;
      return Promise.resolve({
        ok: true,
        text: () => rejectWhenAborted(signal!),
      } as unknown as Response);
    });

    const ollama = new OllamaService("http://localhost:11434", "test-model", 1_000);
    const generate = ollama.generate("prompt");
    const rejection = expect(generate).rejects.toThrow("aborted");

    await vi.advanceTimersByTimeAsync(1_000);

    expect(signal?.aborted).toBe(true);
    await rejection;
  });

  it("rechaza generate con error HTTP", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    } as Response);

    const ollama = new OllamaService("http://localhost:11434", "test-model", 5_000);
    await expect(ollama.generate("prompt")).rejects.toThrow("Ollama error 500");
  });

  it("rechaza chat con error HTTP", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: false,
      status: 404,
      text: async () => "Not Found",
    } as Response);

    const ollama = new OllamaService("http://localhost:11434", "test-model", 5_000);
    await expect(ollama.chat([{ role: "user", content: "hola" }])).rejects.toThrow(
      "Ollama chat error 404"
    );
  });

  it("envía esquema y opciones de generación en chat", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ message: { content: "{}" } }),
    } as Response);
    const schema = {
      type: "object",
      properties: { route: { type: "string" } },
      required: ["route"],
    };
    const ollama = new OllamaService("http://localhost:11434", "test-model", 5_000);

    await ollama.chat(
      [{ role: "user", content: "clasifica" }],
      { format: schema, options: { temperature: 0, seed: 42 } },
    );

    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(request.format).toEqual(schema);
    expect(request.options).toEqual({ temperature: 0, seed: 42 });
  });

  it("reenvía think en chat cuando se especifica", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ message: { content: "{}" } }),
    } as Response);
    const ollama = new OllamaService("http://localhost:11434", "test-model", 5_000);

    await ollama.chat([{ role: "user", content: "clasifica" }], { think: false });

    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect(request.think).toBe(false);
  });

  it("omite think en chat cuando no se especifica", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ message: { content: "{}" } }),
    } as Response);
    const ollama = new OllamaService("http://localhost:11434", "test-model", 5_000);

    await ollama.chat([{ role: "user", content: "clasifica" }]);

    const request = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, unknown>;
    expect("think" in request).toBe(false);
  });

  it("rechaza generate con JSON de respuesta invalido", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ wrong: "field" }),
    } as Response);

    const ollama = new OllamaService("http://localhost:11434", "test-model", 5_000);
    await expect(ollama.generate("prompt")).rejects.toThrow("no devolvió una respuesta válida");
  });

  it("rechaza chat con JSON de respuesta invalido", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ message: "no object" }),
    } as Response);

    const ollama = new OllamaService("http://localhost:11434", "test-model", 5_000);
    await expect(ollama.chat([{ role: "user", content: "hola" }])).rejects.toThrow(
      "no devolvió una respuesta válida"
    );
  });

  it("retorna false en isAvailable si fetch falla", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));

    const ollama = new OllamaService("http://localhost:11434", "test-model", 5_000);
    await expect(ollama.isAvailable()).resolves.toBe(false);
  });
});

function rejectWhenAborted(signal: AbortSignal): Promise<Response> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("request aborted")), { once: true });
  });
}
