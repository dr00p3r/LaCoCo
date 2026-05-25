# LaCoCo — SLMs (Small Language Models)

## Propósito

Módulo de comunicación con modelos de lenguaje pequeños locales vía Ollama. Provee una interfaz unificada para generar texto, completar chats y verificar disponibilidad del servicio, utilizado por el agente planificador y el clasificador dimensional.

## Esquema

```
src/slms/
├── model/
│   └── types.ts                ← OllamaGenerateRequest, OllamaGenerateResponse, OllamaChatMessage
└── ollama-service.ts           ← Fachada pública del módulo
```

## Funciones del Service (`OllamaService`)

| Método | Descripción |
|--------|-------------|
| `constructor(endpoint?, model?)` | Configura endpoint y modelo Ollama |
| `generate(prompt, system?)` | Genera texto con el modelo configurado |
| `chat(messages)` | Chat completion con historial de mensajes |
| `isAvailable()` | Verifica si Ollama está corriendo localmente |
