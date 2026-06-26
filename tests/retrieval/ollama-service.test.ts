import { afterEach, describe, expect, it, vi } from "vitest";
import { OllamaService } from "../../src/slms/ollama-service.js";

describe("OllamaService", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("usa el timeout configurado para generate y chat", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ response: "ok", message: { content: "ok" } }),
    } as Response);

    const ollama = new OllamaService("http://localhost:11434", "test-model", 1_234);

    await ollama.generate("prompt");
    await ollama.chat([{ role: "user", content: "prompt" }]);

    expect(timeout).toHaveBeenNthCalledWith(1, 1_234);
    expect(timeout).toHaveBeenNthCalledWith(2, 1_234);
  });

  it("acota isAvailable a cinco segundos aunque el timeout configurado sea mayor", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      text: async () => "{}",
    } as Response);

    const ollama = new OllamaService("http://localhost:11434", "test-model", 30_000);

    await expect(ollama.isAvailable()).resolves.toBe(true);
    expect(timeout).toHaveBeenCalledWith(5_000);
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
