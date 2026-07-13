# LaCoCo — SLMs (Small Language Models)

## Propósito

Módulo de comunicación con modelos de lenguaje pequeños locales vía Ollama.
Provee una interfaz unificada para generar texto, completar chats, verificar
disponibilidad del servicio y cancelar solicitudes activas. Lo usan el agente
planificador, el clasificador dimensional y el enriquecedor del Project Semantic
Profile.

## Esquema

```
src/slms/
├── model/
│   └── types.ts                ← OllamaGenerateRequest, OllamaGenerateResponse, OllamaChatMessage
├── llm-client.ts               ← interfaz comun LlmClient
└── ollama-service.ts           ← Fachada pública del módulo
```

## Funciones del Service (`OllamaService`)

| Método | Descripción |
|--------|-------------|
| `constructor(endpoint?, model?)` | Configura endpoint y modelo Ollama |
| `generate(prompt, system?)` | Genera texto con el modelo configurado |
| `chat(messages)` | Chat completion con historial de mensajes |
| `isAvailable()` | Verifica si Ollama está corriendo localmente |
| `abort()` | Cancela solicitudes activas |

El modelo recomendado para `agent.model` es `qwen3:4b-instruct`. Para pruebas
A/B, `intermediary.model` puede separarse de `agent.model`; si esta vacio,
hereda el modelo principal.
