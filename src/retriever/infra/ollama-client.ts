/**
 * OllamaClient — Cliente HTTP para SLM local (Qwen2.5-Coder:1.5B)
 *
 * Comunica con Ollama vía su API REST local (sin llamadas de red externas).
 * Usa fetch nativo de Node.js >= 18.
 */

export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  stream?: boolean;
  options?: Record<string, unknown>;
}

export interface OllamaGenerateResponse {
  model: string;
  response: string;
  done: boolean;
}

export interface OllamaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  stream?: boolean;
  tools?: unknown[];
}

export class OllamaClient {
  constructor(
    private readonly endpoint = "http://localhost:11434",
    private readonly model = "qwen2.5-coder:1.5b"
  ) {}

  /**
   * Genera texto con el modelo configurado.
   *
   * @param prompt Texto de entrada
   * @param system Prompt de sistema opcional
   * @returns Texto generado (trimmed)
   */
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
    });

    if (!res.ok) {
      throw new Error(`Ollama error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as OllamaGenerateResponse;
    return data.response.trim();
  }

  /**
   * Chat completion con historial de mensajes.
   * Útil para AgenticStrategy (tool-calling con contexto).
   */
  async chat(messages: OllamaChatMessage[], tools?: unknown[]): Promise<string> {
    const res = await fetch(`${this.endpoint}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
        tools,
      } as OllamaChatRequest),
    });

    if (!res.ok) {
      throw new Error(`Ollama chat error ${res.status}: ${await res.text()}`);
    }

    const data = (await res.json()) as { message: { content: string } };
    return data.message.content.trim();
  }

  /**
   * Verifica si Ollama está disponible localmente.
   */
  async isAvailable(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/api/tags`, { method: "GET" });
      return res.ok;
    } catch {
      return false;
    }
  }
}
