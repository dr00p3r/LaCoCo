#!/usr/bin/env bash
# Comparación de generación con CLAUDE CODE (sonnet/haiku, no-1m) bajo el arnés
# arreglado, tres condiciones a igual agente/modelo:
#   - no_context      → baseline sin contexto y sin lacoco.
#   - MCP suave        → LaCoCo MCP bajo demanda, hint SUAVE.
#   - MCP fuerte       → LaCoCo MCP bajo demanda, hint FUERTE (protocolo obligatorio).
# Se cambia de agente (opencode-go sin tokens) → se re-corre también el MCP fuerte para
# que la tabla sea comparable a igual agente. El MCP devuelve cuerpos+líneas (snippets).
#
# COSTO: Claude Code no lo consume el arnés (agent.command=bash != opencode), así que NO
# se pasa --max-budget-usd (dispararía la salvaguarda de costo-ausente). El costo real y
# el uso de tools quedan en el stream-json de cada celda (agent.stdout.log) para análisis.
#
# Modelo: LACOCO_EVAL_CLAUDE_MODEL (default sonnet; export=haiku para abaratar).
# Paralelismo: GEN_JOBS (default 1, serial, para evitar contención de estado de claude).
#
# Uso:  bash eval/run-claude-nc-mcp.sh
#       LACOCO_EVAL_CLAUDE_MODEL=haiku bash eval/run-claude-nc-mcp.sh
#       PREP_ONLY=1 bash eval/run-claude-nc-mcp.sh   # build+prepare+retrieval (local/gratis)
set -euo pipefail
cd "$(dirname "$0")/.."

export LACOCO_EVAL_MANIFESTS_DIR="eval/manifests/swe-polybench-15"
export LACOCO_EVAL_CLAUDE_MODEL="${LACOCO_EVAL_CLAUDE_MODEL:-sonnet}"
export LACOCO_EMBEDDING_MODEL="jinaai/jina-embeddings-v2-base-code"
export LACOCO_EMBEDDING_DIM=768
export LACOCO_EMBEDDING_QUANTIZED=false
export LACOCO_EMBEDDING_MAX_CHARS="${LACOCO_EMBEDDING_MAX_CHARS:-2000}"

GEN_JOBS="${GEN_JOBS:-1}"

# Prefijo de run-id (para no pisar corridas de otros modelos). Ej: RID_PREFIX=cc-haiku.
RID_PREFIX="${RID_PREFIX:-cc}"
RID_NC="${RID_PREFIX}-nc"            # no_context (agente claude-code)
RID_SOFT="${RID_PREFIX}-mcp-soft"   # MCP hint suave (agente claude-code-mcp)
RID_HARD="${RID_PREFIX}-mcp-hard"   # MCP hint fuerte (agente claude-code-mcp)

GEN13_REPOS=(svelte-510 svelte-728 svelte-906 svelte-907 svelte-1116 \
  prettier-14400 prettier-12930 prettier-6604 prettier-5025 prettier-4667 \
  material-ui-11451 material-ui-11858 material-ui-12406)

echo "== 0. Build (dist para el servidor MCP) =="
npm run build

echo "== 1. Prepare (por-repo, tolerante) + retrieval de los 3 run-ids (local, sin cloud) =="
for rid in "$RID_NC" "$RID_SOFT" "$RID_HARD"; do
  if [[ "${SKIP_PREPARE:-0}" != "1" && ! -f "eval/runs/$rid/repos.lock.json" ]]; then
    for repo in "${GEN13_REPOS[@]}"; do
      npm run --silent eval:prepare -- --run-id "$rid" --repo-id "$repo" \
        || echo "  ⚠ prepare falló en $repo ($rid); continúo"
    done
  else
    echo "  (prepare saltado para $rid: lock ya existe o SKIP_PREPARE=1)"
  fi
  # Retrieval sobre gen13_mcp (solo no_context → retrieval.jsonl vacío, sin ejecución
  # real). Tolerante: sale !=0 por prettier-5025 ausente del lock, pero para no_context
  # basta el archivo vacío. touch garantiza que exista para loadRetrievalJsonl.
  npm run eval:retrieval -- --run-id "$rid" --split gen13_mcp > "eval/runs/ret-$rid.log" 2>&1 \
    || echo "  ⚠ retrieval $rid salió !=0 (esperado por prettier-5025); continúo"
  touch "eval/runs/$rid/retrieval.jsonl"
done
echo "  retrieval OK (retrieval.jsonl vacío para no_context)"

if [[ "${PREP_ONLY:-0}" == "1" ]]; then echo "PREP_ONLY: listo (sin generación)"; exit 0; fi

echo "== 2. Generación con Claude Code ($LACOCO_EVAL_CLAUDE_MODEL). Sin --max-budget-usd. =="
# Cada eval:generation sale !=0 si hay CUALQUIER fallo de celda (incluida prettier-5025
# ausente del lock, que es esperado e inocuo). Se guardan con `|| echo` para que ese
# fallo esperado no mate el runner entre variantes (set -e). Las celdas reales sí corren.
# no_context (agente claude-code plano) sobre split genAB, filtrado a no_context.
npm run eval:generation -- --run-id "$RID_NC" --split genAB --strategy-id no_context \
  --agent-id claude-code --max-parallel-repos "$GEN_JOBS" --resume \
  || echo "  ⚠ eval:generation $RID_NC salió !=0 (prettier-5025 lock-miss esperado; revisa Failures); continúo"
# MCP hint SUAVE (agente claude-code-mcp) sobre split gen13_mcp.
LACOCO_EVAL_MCP_HINT=soft \
  npm run eval:generation -- --run-id "$RID_SOFT" --split gen13_mcp \
    --agent-id claude-code-mcp --max-parallel-repos "$GEN_JOBS" --resume \
  || echo "  ⚠ eval:generation $RID_SOFT salió !=0 (prettier-5025 lock-miss esperado; revisa Failures); continúo"
# MCP hint FUERTE (agente claude-code-mcp) sobre split gen13_mcp.
LACOCO_EVAL_MCP_HINT=hard \
  npm run eval:generation -- --run-id "$RID_HARD" --split gen13_mcp \
    --agent-id claude-code-mcp --max-parallel-repos "$GEN_JOBS" --resume \
  || echo "  ⚠ eval:generation $RID_HARD salió !=0 (prettier-5025 lock-miss esperado; revisa Failures); continúo"

echo "== 3. Métricas =="
for rid in "$RID_NC" "$RID_SOFT" "$RID_HARD"; do npm run eval:metrics:generation -- --run-id "$rid" || true; done
echo "Resultados:"
echo "  eval/runs/$RID_NC/generation-summary.md      (no_context)"
echo "  eval/runs/$RID_SOFT/generation-summary.md     (MCP hint suave)"
echo "  eval/runs/$RID_HARD/generation-summary.md     (MCP hint fuerte)"
