# MCP con hint reforzado + arnés unknown-runner arreglado (gen13, deepseek-v4-pro)

**Fecha:** 2026-07-13
**Run:** `genAB-mcp-hint` (variante MCP bajo demanda, hint endurecido)
**Agente:** OpenCode CLI · `opencode-go/deepseek-v4-pro` · Embedding Jina 768
**Corpus:** gen13 (5 svelte + 5 prettier + 3 mui); efectivo **12 tareas** (prettier-5025 auto-excluida: `npm install` irrecuperable).
**Coste:** $1.214 (12 celdas; cap $4). Índice reusado (líneas ya pobladas, migración 006).

## Qué cambia respecto al A/B del 2026-07-12

Este run reintenta la **misma variante MCP** con dos correcciones que salieron del A/B previo (ver `2026-07-12-genAB-snippets-mcp.md` y [connector-scr]):

1. **Hint MCP endurecido** (commit `02663f4`): de un "úsala primero" suave a un **protocolo obligatorio** — llamar a `lacoco_retrieve` ANTES de cualquier grep/read, grep/read solo como fallback, no editar hasta localizar con la tool. Objetivo: subir de las 0.7 llamadas/celda observadas.
2. **unknown-runner arreglado** (commit `9ceb505`): mui mocha ahora pasa el spec + `test/mocha.opts`; prettier `parseJest` tolera summary solo-fallos; `NODE_OPTIONS=--no-experimental-global-navigator` para mui ~2018 en node ≥21; nuevo campo `invalid_reason` que de-confla la etiqueta opaca. Objetivo: hacer medible el medio benchmark que era invisible.

## Resultado 1 — MEDIBILIDAD (el arnés se paga)

| | medibles (exit≠null) | PASS (exit=0) | unknown_runner |
|---|---:|---:|---:|
| previo (genAB-mcp) | 5/12 | 4 | 4 |
| **nuevo (genAB-mcp-hint)** | **9/12** | **8** | **2** |

- **De 5 a 9 celdas medibles.** Las dos mui que antes eran `unknown_runner` invisibles (material-ui-11451, material-ui-12406) ahora **miden y PASAN** — el agente arreglaba el bug pero no se podía graduar. prettier-4667 ahora mide como **fail (exit=1)**. Este salto es del **arnés**, no del modelo: revela pases/fallos que ya existían.
- **Los 2 inválidos restantes ya están DIAGNOSTICADOS** (antes todo era el opaco `unknown_runner`):
  - `prettier-6604` → `zero_tests_matched` (el jest sintetizado no matcheó tests).
  - `material-ui-11858` → `test_patch_apply_failed` (el agente tocó `test/`, el gold no aplica limpio).
  - (`svelte-728` → exit=null sin motivo: fallo del AGENTE — 1.9M tokens, sin patch aplicable/timeout, no del arnés.)

Pass@1 = **8/9 medibles (0.89)** ó 8/12 (0.67) overall — pero el conjunto medible es pequeño y sesgado (las duras quedan fuera), así que sigue sin ser la métrica citable; el aporte es que **ahora se puede diagnosticar cada celda**.

## Resultado 2 — USO DE LA TOOL subió, pero NO desplazó la exploración

| variante | llamadas MCP/celda | adopción | grep | read | tokens | coste/celda |
|---|---:|---:|---:|---:|---:|---:|
| MCP previo (hint suave) | 0.67 | 8/12 | 11.2 | 11.2 | 521k | $0.080 |
| **MCP nuevo (hint fuerte)** | **1.33** (2×) | **12/12** | **16.3** | 11.5 | **698k** (+34%) | **$0.101** (+26%) |

- **El hint funcionó en su objetivo literal:** duplicó las llamadas (0.67→1.33) y logró **adopción total** (12/12 vs 8/12 — ninguna celda ignora ya la tool).
- **Pero NO capturó el ahorro esperado (dato negativo honesto):** grep SUBIÓ (11.2→16.3), read plano, tokens +34%, coste +26%. El agente ahora usa la tool **Y** sigue explorando igual o más. Una o dos llamadas a `lacoco_retrieve` no reemplazan su loop de grep/read por defecto — lo prependen. El MCP deja de ser "el más barato" de las cuatro variantes.

## Veredicto

- **El arreglo del unknown-runner es un WIN limpio y citable:** casi duplica las celdas graduables (5→9) y convierte etiquetas opacas en diagnósticos accionables. Es la corrección de validez que faltaba para poder hablar de Pass@1.
- **Forzar el uso de la tool NO se traduce en eficiencia.** Endurecer el prompt sube la adopción pero el agente no deja que la tool desplace su exploración; el coste sube sin bajar greps. Esto **refuerza** el hallazgo del A/B previo: los **snippets pre-inyectados** (que eliminan la NECESIDAD de explorar) siguen siendo el mecanismo que reduce esfuerzo; la tool bajo demanda requiere que el agente confíe en ella y suprima su loop, cosa que con este modelo/prompt no ocurre.
- **El cuello no es la localización.** Con la tool localizando bien y usada por todas las celdas, el esfuerzo NO baja — consistente con el veredicto de [connector-scr]: el trabajo caro es RAZONAR el fix, no encontrar el sitio.

## Siguiente

1. Si se persigue el MCP: probar que la tool devuelva **suficiente contexto de una vez** (cuerpos completos + vecinos) para que el agente no necesite verificar con grep — o una política de agente que penalice grep tras un retrieve exitoso. Sin eso, el on-demand no compite con el snippet pre-inyectado.
2. Con el arnés arreglado, el `zero_tests_matched` de prettier-6604 y el `test_patch_apply_failed` de mui-11858 son ahora bugs concretos y perseguibles (síntesis del grep de fixture; reset de `test/` más agresivo).
3. Escalar n>12 ya es viable con 9/12 medibles por celda; el sesgo del conjunto medible se reduce con más tareas.

## Notas de validez

- n=12; prettier-5025 auto-excluida (install roto). Telemetría de esfuerzo en 12/12 celdas.
- Comparación pareada contra `genAB-mcp` (mismo modelo, mismo corpus, mismo índice); la única diferencia son el hint y el arnés.
- `runner_error` se mantiene como la señal binaria para `m1_unknown_runner_count` (compat métricas); `invalid_reason` lleva el motivo real. Validado e2e SIN agente antes del run: mui-11451 ran=1/exit=1, prettier-12930 ran=6/exit=1.
- Coste total de la noche (ping + run) ≈ $1.22, bajo el techo de $5.
