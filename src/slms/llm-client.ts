export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  format?: "json" | Record<string, unknown>;
  options?: Record<string, string | number | boolean>;
  // Campo de nivel superior de Ollama (no va dentro de `options`). Los modelos con
  // capacidad de razonamiento (p. ej. gemma4) gastan `num_predict` en el campo
  // `thinking` y devuelven `content` vacío. Poner `think:false` mantiene el
  // presupuesto de tokens para el JSON estructurado.
  think?: boolean;
  // Campo de nivel superior de Ollama: cuánto mantener el modelo en memoria tras
  // la llamada (p. ej. "5m", "-1" para siempre). Evita recargar el modelo entre
  // llamadas encadenadas. No afecta el sampling.
  keep_alive?: string | number;
}

export interface LlmClient {
  abort(): void;
  isAvailable(): Promise<boolean>;
  generate(prompt: string, system?: string): Promise<string>;
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
}
