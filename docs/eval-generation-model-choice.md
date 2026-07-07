# Elección del modelo generador para el benchmark M1/M2

**Estado:** aceptada · **Fecha:** 2026-07-05 · **Ámbito:** fase de generación del arnés `eval/` (métricas M1 = Pass@1, M2 = Hallucination Rate)

## Decisión

Para el piloto de generación (`run.yaml` → split `generation_pilot`, run-id
`2026-07-05-slm-active`) el agente generador se ejecuta con el modelo
**`opencode-go/qwen3.7-plus`** a través del CLI `opencode`, en lugar del modelo
Claude Sonnet (referido en las notas del ciclo como `claude-sonnet-4-5`) que
correspondería al agente `claude-code` del manifest.

## Contexto: qué es el "default del manifest"

El manifest de agentes (`eval/manifests/agents.yaml`) define varios agentes, pero
solo uno es el **agente oficial de generación**:

```yaml
execution_policy:
  official_generation_agent: "opencode"       # agents.yaml:190
  exploratory_agents:
    - "codex-cli"
    - "claude-code"                            # agents.yaml:193 (exploratorio)
    - "manual"
```

Puntos clave:

- El agente `opencode` está `enabled: true` y su `model.default` es
  `opencode-go/qwen3.7-plus` (`agents.yaml:63-65`). Ese es el modelo que se
  resuelve por defecto en la corrida real.
- El agente `claude-code` (cuyo `model.default` es el alias `sonnet`,
  `agents.yaml:133-134`) está **`enabled: false`** (`agents.yaml:120`) y figura
  como agente **exploratorio**, no oficial. El manifest documenta el motivo:

  > *"Codex CLI y Claude Code se dejan desactivados hasta verificar localmente su
  > contrato de flags, permisos, autenticacion y formato de salida en la maquina
  > que ejecutara la corrida."* (`agents.yaml:195-198`)

Es decir: usar Claude Sonnet no era el default operativo de la corrida sino la
opción "de referencia" desactivada. La pregunta que documenta este archivo es por
qué el modelo del agente oficial acabó siendo `qwen3.7-plus` y no un modelo de
Anthropic, dado que el proveedor autenticado se invoca a través de `opencode`.

## Resolución del modelo en tiempo de ejecución

`run-generation.ts` resuelve el modelo con esta precedencia
(`run-generation.ts:134-144`):

1. variable de entorno `LACOCO_EVAL_OPENCODE_MODEL` si está definida;
2. si no, `agent.model.default` del manifest (`opencode-go/qwen3.7-plus`);
3. si no hay default, error.

El modelo resuelto se interpola en el comando `opencode run … --model {model} …` y
el proveedor autenticado (`opencode-go`) resuelve la credencial internamente
(`opencode auth login` / variables de entorno del proveedor). Por tanto, la
disponibilidad efectiva del modelo depende de qué exponga el proveedor autenticado,
no solo de qué string pongamos en el manifest.

## Modelos evaluados y por qué se descartaron

| Modelo (slug proveedor) | Resultado | Motivo de descarte |
|---|---|---|
| **`opencode-go/qwen3.7-plus`** | **Elegido** | Disponible en el proveedor autenticado, comportamiento estable en las celdas de prueba, costo aceptable dentro del budget del piloto. |
| Claude Sonnet (`claude-code` / alias `sonnet`) | No usado | El agente `claude-code` está desactivado en el manifest (contrato de CLI/permisos/salida sin verificar en la máquina de corrida). No disponible como modelo servido por el proveedor autenticado de `opencode` en esta máquina. |
| `deepseek-v4-flash` | Descartado | Error **500 del proveedor, reproducible** al invocar la generación. Fallo determinista, no transitorio. |
| `deepseek-v4-pro` | Descartado | Comportamiento **ambiguo / no confirmado**; no se logró una corrida limpia y reproducible que justificara adoptarlo. |
| `qwen3.7-max` | Descartado | **Costo** por encima del presupuesto del piloto. |
| `GLM` | Descartado | **Costo** / no prioritario frente a `qwen3.7-plus`. |
| `kimi-k2.7-code` | Descartado | **Costo** / no prioritario frente a `qwen3.7-plus`. |

## Por qué `qwen3.7-plus`

1. **Disponibilidad real.** Es un modelo que el proveedor autenticado (`opencode-go`)
   sirve efectivamente en la máquina de corrida, a diferencia del modelo de Anthropic
   (agente desactivado / no servido por ese proveedor) y de `deepseek-v4-flash`
   (500 reproducible).
2. **Estabilidad reproducible.** Frente a `deepseek-v4-pro` (comportamiento
   ambiguo/no confirmado), `qwen3.7-plus` produjo corridas completas y repetibles,
   requisito para un benchmark cuyas conclusiones deben ser reproducibles.
3. **Costo dentro del budget.** El piloto corre con budget agregado de ~$9.00. Los
   modelos de mayor capacidad/costo (`qwen3.7-max`, `GLM`, `kimi-k2.7-code`) se
   descartaron explícitamente por presupuesto; `qwen3.7-plus` es el punto de
   equilibrio capacidad/costo dentro de esa restricción.
4. **Es un tier "plus", no el mínimo.** No se recortó a un modelo pequeño local: se
   eligió un modelo de gama media-alta del mismo proveedor, de modo que la señal de
   M1/M2 no quede sesgada por usar deliberadamente un generador débil.

## Reproducibilidad de la evidencia

Cada celda de generación deja artefactos que respaldan las afirmaciones anteriores
(`generation-record.ts` → `artifact_paths`):

- `command.log` — comando exacto, incluyendo `--model <slug>` usado.
- `agent.stdout.log` / `agent.stderr.log` — salida del proveedor; aquí quedan los
  500 de `deepseek-v4-flash` y el comportamiento de `deepseek-v4-pro`.

> **Pendiente de adjuntar:** enlazar aquí las rutas concretas de `agent.stderr.log`
> de las corridas de descarte (flash / pro) como evidencia citable. El
> `GenerationRecord` **no** persiste hoy el string del modelo en un campo propio;
> el modelo solo queda en `command.log`. Si se quiere trazabilidad de modelo por
> celda en el JSONL, sería un cambio pequeño a `generation-record.ts` (añadir
> `model: string`) — anotado como mejora, fuera de este ciclo.

## Amenazas a la validez / advertencias

- **Cambiar el generador cambia el benchmark.** M1/M2 son relativas al modelo
  generador. Los resultados del piloto con `qwen3.7-plus` **no** son directamente
  comparables con hipotéticos resultados de Claude Sonnet u otro modelo; toda
  conclusión debe reportarse condicionada al generador.
- **Comparación entre estrategias sí es válida.** Como las tres condiciones
  (`no_context` / `hybrid` / `ictd`) usan el **mismo** generador y el mismo prompt
  base (la sección `lacoco_context` está siempre presente, Opción B), la comparación
  *entre estrategias* dentro del piloto es limpia; el generador es una constante
  controlada, no una variable.
- **Nomenclatura del modelo Anthropic.** El manifest usa el alias `sonnet` para el
  agente `claude-code`; la etiqueta `claude-sonnet-4-5` proviene de las notas del
  ciclo, no del repo. No se fija aquí un ID datado de Anthropic porque el agente está
  desactivado y no se ejecutó; si en un ciclo futuro se activa, conviene fijar el ID
  exacto del modelo servido en ese momento.
