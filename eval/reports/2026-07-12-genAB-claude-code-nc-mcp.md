# Generación con Claude Code: no_context vs MCP suave vs MCP fuerte (sonnet)

**Fecha:** 2026-07-12
**Runs:** `cc-nc` (no_context) · `cc-mcp-soft` (MCP hint suave) · `cc-mcp-hard` (MCP hint fuerte)
**Agente:** Claude Code (headless, `--print`) · modelo **sonnet** (no-1m) · vía wrapper `eval/scripts/run-claude-cell.sh`
**Corpus:** gen13 (5 svelte + 5 prettier + 3 mui); **12 tareas** efectivas (prettier-5025 auto-excluida: install irrecuperable).
**Por qué Claude Code:** opencode-go se quedó sin tokens; se cambió de agente y se re-corrieron las **tres** condiciones a igual agente/modelo para que la tabla sea comparable. Snippets por construcción (la tool `lacoco_retrieve` devuelve cuerpos+líneas; el hint solo cambia cuánto insiste en usarla).

## Resultado principal — Pass@1 PLANO, exploración BAJA con el MCP

| condición | Pass@1 | `lacoco_retrieve` | adopción | bash | read | tiempo/celda (avg·mediana) | costo/celda (API-eq) |
|---|---|---:|---:|---:|---:|---:|---:|
| **no_context** | **8/12** | 0 | 0/12 | 350 | 67 | 241s · 218s | $0.95 |
| **MCP suave** | **8/12** | 3 (0.25) | 3/12 | 250 | 53 | 207s · 157s | $0.86 |
| **MCP fuerte** | **8/12** | 8 (0.67) | 8/12 | 229 | 32 | 176s · 135s | $0.84 |

**Las tres condiciones pasan exactamente las MISMAS 8 tareas.** El MCP no rescató ni una tarea extra sobre no_context.

### Vista pareada por tarea
```
tarea                no_context   MCP-suave    MCP-fuerte
material-ui-11451    PASS         PASS         PASS
material-ui-11858    PASS         PASS         PASS
material-ui-12406    PASS         PASS         PASS
prettier-14400       PASS         PASS         PASS
prettier-6604        PASS         PASS         PASS
svelte-510           PASS         PASS         PASS
svelte-907           PASS         PASS         PASS
svelte-1116          PASS         PASS         PASS
prettier-12930       apply_failed apply_failed apply_failed   <- artefacto gold/arnés
prettier-4667        fail         apply_failed fail
svelte-906           fail         fail         fail
svelte-728           timeout      fail         fail
```
Los 4 no-pases son idénticos entre condiciones. `prettier-12930` es `test_patch_apply_failed` (el agente tocó `test/`, el gold no aplica) — artefacto, no fallo del modelo.

## Lo que SÍ cambió (comportamiento, no acierto)

1. **El hint fuerte funciona en adopción:** llamadas 0→3→8, adopción 3/12→8/12 (~2.6× suave→fuerte). Consistente con el A/B de opencode (endurecer el hint ~2× el uso). Cada celda fuerte llama la tool **una vez** al inicio y sigue con Bash.
2. **Con Claude el MCP SÍ reduce exploración** (a diferencia de opencode, donde no bajaba grep): bash 350→229 (**−35%**), read 67→32 (**−52%**), tiempo mediana 218→135s (**−38%**), costo −12%. La llamada a la tool **reemplaza** exploración en vez de sumarse.
3. **svelte-728:** en `no_context` **timeouteó** (600s girando sin cerrar); con MCP la tool le dio dirección y **falló rápido** (sin timeout). La localización ayudó al *proceso*, no al *resultado*.

## Veredicto

- **El MCP no mueve Pass@1.** Con sonnet (localizador fuerte por sí mismo), `no_context` ya saca 8/12; el techo para que la tool aporte acierto es casi nulo. **Confirma** el hallazgo previo (connector-scr, genAB-mcp-hint): **el cuello es RAZONAR el fix, no localizarlo.**
- **Matiz nuevo y defendible:** con Claude el MCP compra **eficiencia** (−35% bash, −52% read, −38% tiempo-mediana, −12% costo) a **igual calidad**. Es un aporte honesto como "misma tasa de acierto con menos esfuerzo de localización", no como "más fixes". Esto **diferencia** a Claude de opencode, donde el hint fuerte subía el uso pero NO bajaba la exploración.
- **Firmas descartadas** (el A/B previo ya mostró snippet > firmas); todo aquí es snippets.

## Notas de validez

- n=12; conjunto medible ~10-11 (sesgado: las duras caen fuera → subestima el margen del contexto en tareas difíciles).
- Costo en tabla = `total_cost_usd` del stream-json (API-equivalente). Claude Code va por **suscripción**, no facturado por token; el arnés no consume el costo (agente `bash` != `opencode`), por eso NO se pasó `--max-budget-usd` (evita la salvaguarda de costo-ausente).
- **Bug encontrado y arreglado antes de las 24 celdas MCP:** el servidor MCP exigía el Project Semantic Profile (grounding), obsoleto para estos repos → `lacoco_retrieve` fallaba con "profile rebuild". Causa: el flag `--grounding` de commander es **negable** (`options.grounding` es `true` por default y pisa env/config); fix = pasar **`--no-grounding`** (retrieve determinista, igual criterio que el retrieval del eval). Verificado end-to-end (20 chunks, 0 errores) antes de correr.
- Paralelismo GEN_JOBS=4 (seguro con Claude: sesiones `-p` independientes, sin la contención SQLite que trababa opencode; y sin cap de presupuesto no hay salvaguarda que aborte).

## Reproducir

```bash
# 3 condiciones, Claude Code + sonnet, sin cap de presupuesto:
SKIP_PREPARE=1 GEN_JOBS=4 bash eval/run-claude-nc-mcp.sh
# análisis (Pass@1 + tool-calls + costo + tiempo por celda, desde el stream-json):
node eval/scripts/analyze-claude-cells.mjs cc-nc cc-mcp-soft cc-mcp-hard
```
Cambiar a haiku: `LACOCO_EVAL_CLAUDE_MODEL=haiku`. Hint suave/fuerte: `LACOCO_EVAL_MCP_HINT=soft|hard`.
