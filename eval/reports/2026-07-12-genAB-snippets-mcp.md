# A/B de formato de contexto: firmas vs snippets vs MCP bajo demanda (gen13, deepseek-v4-pro)

**Fecha:** 2026-07-12
**Runs:** `genAB-v1` (no_context + firmas), `genAB-v2` (snippets), `genAB-mcp` (MCP bajo demanda)
**Agente:** OpenCode CLI · `opencode-go/deepseek-v4-pro` · Embedding Jina 768
**Corpus:** gen13 (5 svelte + 5 prettier + 3 mui); efectivo **12 tareas** (prettier-5025 excluida: `npm install` irrecuperable; mui-13690/13778 fuera de gen13).

## Pregunta

El hallazgo previo (ver [connector-scr]) fue que la *calidad de retrieval no se traduce en generación*: LaCoCo entregaba **firmas de símbolos, una sola vez, vía hook en t=0**, y el agente igual tenía que abrir archivos. Este A/B aísla **el formato de entrega** (no la estrategia): se fija `hybrid` y se varía CÓMO llega el contexto.

| # | Variante | Qué recibe el agente |
|---|---|---|
| 1 | `no_context` | Nada (baseline). |
| 2 | firmas (v1) | Hook en t=0 con **firmas** de los símbolos (template v1). |
| 3 | snippets (v2) | Hook en t=0 con el **cuerpo + líneas** de los símbolos (template v2, cuerpos cortados del working tree). |
| 4 | MCP | Sin contexto pre-inyectado; el agente tiene la tool `lacoco_retrieve` y la invoca **bajo demanda**. |

## Pass@1 — INCONCLUSO (se reporta con honestidad)

| variante | Pass@1 (n=12) | IC 95% | unknown-runner |
|---|---:|---|---:|
| no_context | 0.250 (3/12) | [0.000, 0.500] | 5 |
| firmas | 0.250 (3/12) | [0.000, 0.500] | 5 |
| snippets | 0.333 (4/12) | [0.083, 0.583] | 6 |
| MCP | 0.333 (4/12) | [0.083, 0.583] | 4 |

**No hay diferencia atribuible.** Con n=12, **7-8 de 12 celdas salen "unknown"** (el arnés no parsea la salida de tests — *todas* las de mui, y varias svelte/prettier), y los IC se solapan por completo. La matriz pareada lo confirma: los "flips" son de 1 tarea y viven en la capa de unknown-runner, no en el modelo.

Matriz por tarea (PASS / fail / unk):

| tarea | no_ctx | firmas | snippets | MCP |
|---|:--:|:--:|:--:|:--:|
| svelte-510 | PASS | PASS | PASS | PASS |
| svelte-907 | PASS | unk | PASS | PASS |
| svelte-906 | unk | unk | **PASS** | unk |
| prettier-14400 | PASS | PASS | PASS | PASS |
| prettier-12930 | unk | PASS | unk | PASS |
| svelte-728/1116, prettier-6604/4667, mui×3 | unk/fail | unk | unk | unk/fail |

## Esfuerzo del agente — LA SEÑAL DEFENDIBLE

Los ejes de esfuerzo (tokens, tool-calls) son independientes del parseo de tests y cubren 10-12 celdas con telemetría.

| variante | tokens (mean) | tool-calls | grep | read | tiempo agente | costo/celda | tool MCP |
|---|---:|---:|---:|---:|---:|---:|---:|
| no_context | 531k | 24.5 | 1.4 | 8.8 | 247s | $0.095 | — |
| **firmas** | **803k** (+51%) | 28.6 | 2.7 | 8.8 | 364s | $0.103 | — |
| **snippets** | **530k** (−34% vs firmas) | 22.7 | 1.6 | 7.8 | 273s | $0.120 | — |
| **MCP** | **521k** | 29.3 | 2.8 | 11.2 | 282s | **$0.080** | 0.7 (8/12 celdas) |

### Hallazgos

1. **Las firmas EMPEORAN sobre no_context** (+51% tokens, más greps, +47% tiempo) sin ganar Pass@1. Confirma con datos el diagnóstico: una firma es *un mapa que cuesta exploración* — el agente abre archivos para ver la implementación detrás de cada firma. Entregar firmas one-shot es la peor de las cuatro opciones.

2. **Los snippets revierten el esfuerzo** (−34% tokens y −25% tiempo vs firmas; menos greps y reads) al entregar el código directamente. Trade-off: cuestan más por celda ($0.12 vs $0.10) porque el contexto inyectado es más grande (cuerpos a 12k tokens vs firmas a 4k). Es un **desplazamiento de trabajo del loop del agente al prompt one-shot** — favorable donde importa la latencia/tokens del agente.

3. **El MCP es el más barato** ($0.080/celda, sin contexto pesado por adelantado) e iguala a snippets en Pass@1, PERO **no reduce la exploración**: grep 2.8 y read 11.2 son los más altos, y el agente invocó la tool solo **0.7 veces/celda** (8/12). Con el hint mínimo, el agente **subutiliza la tool** y mantiene su loop por defecto de grep/read, así que no realiza el ahorro de exploración que sí logran los snippets pre-inyectados.

## Veredicto

- **Entregar CUERPOS (snippets o MCP) supera a entregar FIRMAS**, que activamente perjudican. Esto matiza el hallazgo previo ("el contexto no ayuda"): era cierto *para firmas*, no para código.
- **El mecanismo de entrega importa:** el snippet pre-inyectado reduce la exploración del agente (a costa de un prompt grande); la tool bajo demanda es la más barata pero requiere que el agente **realmente la use** — con el prompting actual no lo hace lo suficiente.
- **Pass@1 no es medible aquí:** el cuello es el arnés (unknown-runner) y el tamaño de muestra, no el formato. El aporte citable es el **eje de eficiencia** (tokens/tiempo/costo por formato).

## Siguiente

1. **Empujar el uso de la tool MCP** (hint más fuerte / política del agente) para capturar el ahorro de snippets al costo del MCP — hoy es la hipótesis más prometedora.
2. **Arreglar el unknown-runner** (parseo de tests de mui/prettier) para desbloquear Pass@1; hoy medio benchmark es invisible.
3. Escalar n más allá de 12 y sumar `connector` (mejor retrieval) × snippets, solo si (1) muestra que el formato mueve la aguja.

## Notas de validez

- n=12; prettier-5025 auto-excluida (install roto); mui contribuye 0 señal de Pass@1 (todas unknown-runner).
- Índice re-construido con migración 006 (líneas pobladas) + cap de embedding `LACOCO_EMBEDDING_MAX_CHARS=2000` (prettier tenía firmas de ~80k chars que reventaban Jina por OOM). prettier-6604 quedó con lancedb sin `embedding.json` (índice reconstruido con CLI directo) → warning no bloqueante.
- El servidor MCP entrega cuerpos+líneas con clasificación del agente congelada (sin SLM/Ollama en el camino); verificado por stdio contra repos reales.
