import type {
  OllamaGenerateRequest,
} from "./model/types.js";
import type { LlmClient, ChatMessage, ChatOptions } from "./llm-client.js";

export class OllamaService implements LlmClient {
  private readonly activeControllers = new Set<AbortController>();

  constructor(
    private readonly endpoint = "http://localhost:11434",
    private readonly model = "qwen2.5-coder:1.5b",
    private readonly timeoutMs = 30_000,
  ) {}

  async generate(prompt: string, system?: string): Promise<string> {
    const { response, text } = await this.#fetchText(`${this.endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        system,
        stream: false,
      } as OllamaGenerateRequest),
    });

    if (!response.ok) {
      throw new Error(`Ollama error ${response.status}: ${text}`);
    }

    const data = JSON.parse(text) as Record<string, unknown>;
    if (typeof data.response !== "string") {
      throw new Error("Ollama generate no devolvió una respuesta válida");
    }
    return data.response.trim();
  }

  async chat(
    messages: ChatMessage[],
    options: ChatOptions = {}
  ): Promise<string> {
    const { response, text } = await this.#fetchText(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        ...(options.format ? { format: options.format } : {}),
        ...(options.options ? { options: options.options } : {}),
        ...(options.think !== undefined ? { think: options.think } : {}),
        ...(options.keep_alive !== undefined ? { keep_alive: options.keep_alive } : {}),
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama chat error ${response.status}: ${text}`);
    }

    const data = JSON.parse(text) as Record<string, unknown>;
    const message = data.message as Record<string, unknown> | undefined;
    if (!message || typeof message.content !== "string") {
      throw new Error("Ollama chat no devolvió una respuesta válida");
    }
    return message.content.trim();
  }

  async isAvailable(): Promise<boolean> {
    try {
      const { response } = await this.#fetchText(`${this.endpoint}/api/tags`, {
        method: "GET",
      }, Math.min(this.timeoutMs, 5_000));
      return response.ok;
    } catch {
      return false;
    }
  }

  abort(): void {
    for (const controller of this.activeControllers) controller.abort();
    this.activeControllers.clear();
  }

  async #fetchText(
    input: string,
    init: RequestInit,
    timeoutMs = this.timeoutMs,
  ): Promise<{ response: Response; text: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    this.activeControllers.add(controller);
    try {
      const response = await fetch(input, { ...init, signal: controller.signal });
      const text = await response.text();
      return { response, text };
    } finally {
      clearTimeout(timeout);
      this.activeControllers.delete(controller);
    }
  }
}
