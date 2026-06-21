import type {
  OllamaGenerateRequest,
  OllamaGenerateResponse,
  OllamaChatMessage,
} from "./model/types.js";

export interface OllamaChatOptions {
  format?: "json" | Record<string, unknown>;
}

export class OllamaService {
  constructor(
    private readonly endpoint = "http://localhost:11434",
    private readonly model = "qwen2.5-coder:1.5b"
  ) {}

  async generate(prompt: string, system?: string): Promise<string> {
    const res = await fetch(`${this.endpoint}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        prompt,
        system,
        stream: false,
      } as OllamaGenerateRequest),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${text}`);
    }

    const data = JSON.parse(text) as OllamaGenerateResponse;
    return data.response.trim();
  }

  async chat(
    messages: OllamaChatMessage[],
    options: OllamaChatOptions = {}
  ): Promise<string> {
    const res = await fetch(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        ...(options.format ? { format: options.format } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`Ollama chat error ${res.status}: ${text}`);
    }

    const data = JSON.parse(text) as { message: { content: string } };
    return data.message.content.trim();
  }

  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/api/tags`, {
        method: "GET",
        signal: AbortSignal.timeout(5_000),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}
