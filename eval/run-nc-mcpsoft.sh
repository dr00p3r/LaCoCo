#!/usr/bin/env bash
# Re-corrida PAREADA bajo el arnés arreglado (unknown-runner fix, commit 9ceb505):
#   - no_context  → baseline sin contexto y sin lacoco (agente opencode solo).
#   - MCP suave    → variante MCP bajo demanda con hint SUAVE (LACOCO_EVAL_MCP_HINT=soft).
# El MCP hint FUERTE ya está corrido bajo este arnés (run genAB-mcp-hint) → no se repite.
# El objetivo es una tabla comparable a igual arnés: no_context vs MCP-suave vs MCP-fuerte.
# (v1 firmas descartado: el snippet ya ganó a las firmas.) El servidor MCP devuelve
# cuerpos+líneas (snippets), así que MCP-suave = snippets por construcción.
#
# NO re-indexa: startLine/endLine ya poblados (migración 006) por genAB-mcp-hint;
# el índice Jina en indexes-jina/ se reusa tal cual.
#
# Uso:  bash eval/run-nc-mcpsoft.sh
#       PREP_ONLY=1 bash eval/run-nc-mcpsoft.sh   # solo build + prepare + retrieval (local/gratis)
set -euo pipefail
cd "$(dirname "$0")/.."

export LACOCO_EVAL_MANIFESTS_DIR="eval/manifests/swe-polybench-15"
export LACOCO_EVAL_OPENCODE_MODEL="opencode-go/deepseek-v4-pro"
export LACOCO_EMBEDDING_MODEL="jinaai/jina-embeddings-v2-base-code"
export LACOCO_EMBEDDING_DIM=768
export LACOCO_EMBEDDING_QUANTIZED=false
export LACOCO_EMBEDDING_MAX_CHARS="${LACOCO_EMBEDDING_MAX_CHARS:-2000}"

GEN_JOBS="${GEN_JOBS:-4}"   # repos en paralelo dentro de cada variante

RID_NC="genAB-nc-fix"       # no_context bajo el arnés arreglado
RID_SOFT="genAB-mcp-soft"   # MCP bajo demanda, hint suave

# Los 13 gradeables (mui-13690/13778 excluidas: flatmap-stream despublicado → install
# irrecuperable). eval:prepare NO acepta --split; se prepara por-repo y tolerante para
# que un install roto no tire toda la corrida.
GEN13_REPOS=(svelte-510 svelte-728 svelte-906 svelte-907 svelte-1116 \
  prettier-14400 prettier-12930 prettier-6604 prettier-5025 prettier-4667 \
  material-ui-11451 material-ui-11858 material-ui-12406)

echo "== 0. Build (dist para el servidor MCP) =="
npm run build

echo "== 1. Prepare (por-repo, tolerante) + retrieval de ambos run-ids (local, sin cloud) =="
for rid in "$RID_NC" "$RID_SOFT"; do
  if [[ "${SKIP_PREPARE:-0}" != "1" && ! -f "eval/runs/$rid/repos.lock.json" ]]; then
    for repo in "${GEN13_REPOS[@]}"; do
      npm run --silent eval:prepare -- --run-id "$rid" --repo-id "$repo" \
        || echo "  ⚠ prepare falló en $repo ($rid); continúo"
    done
  else
    echo "  (prepare saltado para $rid: lock ya existe o SKIP_PREPARE=1)"
  fi
done
# AMBOS retrievals sobre gen13_mcp (solo no_context → escribe retrieval.jsonl vacío
# SIN ejecución real de retrieval). Así se evita el retrieval de hybrid, que fallaría
# por prettier-5025 ausente del lock (install irrecuperable). La generación de
# no_context usará split genAB (agente opencode plano) filtrada a --strategy-id
# no_context; no necesita registros de retrieval (findRetrievalRecord → null).
# El retrieval sale con código 1 porque prettier-5025 no está en el lock (install
# irrecuperable). Para no_context eso es INOCUO: findRetrievalRecord→null, así que un
# retrieval.jsonl vacío basta. Se guarda con `|| true` (no matar el script) y se
# garantiza que el archivo exista (touch) para que loadRetrievalJsonl no aborte.
npm run eval:retrieval -- --run-id "$RID_NC"   --split gen13_mcp  > eval/runs/ret-nc-fix.log   2>&1 \
  || echo "  ⚠ retrieval nc salió !=0 (esperado por prettier-5025 ausente del lock); continúo"
npm run eval:retrieval -- --run-id "$RID_SOFT" --split gen13_mcp  > eval/runs/ret-mcp-soft.log 2>&1 \
  || echo "  ⚠ retrieval mcp-soft salió !=0 (esperado por prettier-5025 ausente del lock); continúo"
touch "eval/runs/$RID_NC/retrieval.jsonl" "eval/runs/$RID_SOFT/retrieval.jsonl"
echo "  retrieval OK (retrieval.jsonl vacío para no_context; logs: eval/runs/ret-{nc-fix,mcp-soft}.log)"

if [[ "${PREP_ONLY:-0}" == "1" ]]; then echo "PREP_ONLY: listo (sin generación)"; exit 0; fi

echo "== 2. Generación (variantes en SERIE; dentro de cada una, repos en paralelo) =="
# Comparten repos-jina → NO se paralelizan entre sí (cada celda hace git reset).
# no_context (baseline). ~12 celdas. Filtrado a no_context sobre el split genAB.
npm run eval:generation -- --run-id "$RID_NC" --split genAB --strategy-id no_context \
  --max-budget-usd 2.5 --max-parallel-repos "$GEN_JOBS" --resume
# MCP hint SUAVE. ~12 celdas. LACOCO_EVAL_MCP_HINT=soft selecciona el hint mínimo.
LACOCO_EVAL_MCP_HINT=soft \
  npm run eval:generation -- --run-id "$RID_SOFT" --split gen13_mcp \
    --max-budget-usd 2.5 --max-parallel-repos "$GEN_JOBS" --resume

echo "== 3. Métricas =="
for rid in "$RID_NC" "$RID_SOFT"; do npm run eval:metrics:generation -- --run-id "$rid" || true; done
echo "Resultados:"
echo "  eval/runs/$RID_NC/generation-summary.md      (no_context)"
echo "  eval/runs/$RID_SOFT/generation-summary.md     (MCP hint suave)"
echo "Comparar contra: eval/runs/genAB-mcp-hint/generation-summary.md (MCP hint fuerte)"
