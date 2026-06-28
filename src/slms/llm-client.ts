export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  format?: "json" | Record<string, unknown>;
  options?: Record<string, string | number | boolean>;
}

export interface LlmClient {
  abort(): void;
  isAvailable(): Promise<boolean>;
  generate(prompt: string, system?: string): Promise<string>;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
