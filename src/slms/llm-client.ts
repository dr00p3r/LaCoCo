export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  format?: "json";
}

export interface LlmClient {
  isAvailable(): Promise<boolean>;
  generate(prompt: string, system?: string): Promise<string>;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
